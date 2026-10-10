import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import {
  planFrameSamples,
  planProjectSamples,
  analyzeFrame,
  frameDiff,
  buildFrameEvidence,
  BASE_SAMPLE_PLAN,
  MAX_SAMPLES_PER_SCENE,
} from "../src/render/frameEvidence";
import type { SceneSpec } from "../src/validation/schema";

const execFileAsync = promisify(execFile);

const sceneFixture = (over?: Partial<Record<string, unknown>>): SceneSpec =>
  ({
    sceneId: "fe_scene",
    duration: 3,
    purpose: "evidence fixture",
    visualConcept: "fixture",
    composition: "centered",
    headline: { text: "EVIDENCE", accentWords: [], align: "left" },
    elements: [{ primitive: "Circle", position: "center", accent: "teal" }],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    timing: { entranceAt: 0, emphasisAt: 1.5, exitAt: 2.8 },
    ...over,
  }) as unknown as SceneSpec;

/* ------------------------------ A1: sample plan ----------------------------- */

describe("frame sample plan (A1)", () => {
  it("is deterministic for the same scene", () => {
    const a = planFrameSamples(sceneFixture());
    const b = planFrameSamples(sceneFixture());
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("always captures early, middle and late frames inside the scene", () => {
    const s = planFrameSamples(sceneFixture());
    expect(s.map((x) => x.reason)).toEqual(expect.arrayContaining(["early", "mid", "late"]));
    const durationFrames = 90;
    for (const x of s) {
      expect(x.frame).toBeGreaterThanOrEqual(0);
      expect(x.frame).toBeLessThan(durationFrames);
    }
    const frames = s.map((x) => x.frame);
    expect([...frames].sort((a, b) => a - b)).toEqual(frames);
    expect(new Set(frames).size).toBe(frames.length);
  });

  it("adds known motion events up to the sample cap", () => {
    const many = sceneFixture({
      elements: Array.from({ length: 12 }, (_, i) => ({
        primitive: "Circle",
        position: "center",
        delay: 0.1 * (i + 1),
      })),
    });
    const s = planFrameSamples(many);
    expect(s.length).toBeLessThanOrEqual(MAX_SAMPLES_PER_SCENE);
    expect(s.length).toBeGreaterThanOrEqual(BASE_SAMPLE_PLAN.length);
    expect(s.filter((x) => x.reason === "motion").length).toBeGreaterThan(0);
    expect(s.map((x) => x.reason)).toEqual(expect.arrayContaining(["early", "mid", "late"]));
  });

  it("deduplicates motion events that land on an existing sample", () => {
    const s = planFrameSamples(sceneFixture()); // emphasisAt 1.5 == the mid sample
    expect(s.filter((x) => Math.abs(x.timeSec - 1.5) < 0.01)).toHaveLength(1);
  });

  it("maps to absolute project frames using Sequence offsets", () => {
    const scenes = [sceneFixture(), sceneFixture({ sceneId: "fe_scene_2", duration: 2 })];
    const plan = planProjectSamples(scenes);
    const first = plan.filter((p) => p.sceneId === "fe_scene");
    const second = plan.filter((p) => p.sceneId === "fe_scene_2");
    expect(first.every((p) => p.sceneStartFrame === 0)).toBe(true);
    expect(second.every((p) => p.sceneStartFrame === 90)).toBe(true);
    for (const p of second) expect(p.absoluteFrame).toBe(90 + p.frame);
    expect(planProjectSamples(scenes)).toEqual(plan);
  });
});

/* ------------------------------ A2: metrics --------------------------------- */

describe("frame metrics (A2)", () => {
  let dir = "";
  let interior = "";
  let edge = "";
  let caption = "";

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-metrics-"));
    const make = async (name: string, box: string): Promise<string> => {
      const out = path.join(dir, name);
      await execFileAsync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=30:d=1",
        "-vf", `drawbox=${box}:color=white:t=fill`,
        "-frames:v", "1", out,
      ]);
      return out;
    };
    interior = await make("interior.png", "x=200:y=600:w=300:h=200");
    edge = await make("edge.png", "x=980:y=600:w=100:h=200");
    caption = await make("caption.png", "x=100:y=1550:w=300:h=60");
  }, 60000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("measures dimensions, occupancy and bounds of an interior box", async () => {
    const m = await analyzeFrame(interior);
    expect(m).not.toBeNull();
    expect(m!.width).toBe(1080);
    expect(m!.height).toBe(1920);
    expect(m!.analysisWidth).toBe(540);
    expect(m!.background).toMatch(/^#[0-9a-f]{6}$/);
    expect(m!.occupancy).toBeGreaterThan(0.02);
    expect(m!.occupancy).toBeLessThan(0.04);
    expect(m!.contentBox).toEqual({ x0: 200, y0: 600, x1: 500, y1: 800 });
    expect(m!.edgeInk).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(m!.contentOutsideFrame).toBe(false);
    expect(m!.safeAreaOverflow.outside).toBe(false);
    expect(m!.regionOccupancy.top + m!.regionOccupancy.middle).toBeGreaterThan(0.02);
  });

  it("detects content that touches the frame edge and crosses the safe area", async () => {
    const m = await analyzeFrame(edge);
    expect(m).not.toBeNull();
    expect(m!.edgeInk.right).toBeGreaterThan(0);
    expect(m!.contentOutsideFrame).toBe(true);
    expect(m!.safeAreaOverflow.outside).toBe(true);
    expect(m!.safeAreaOverflow.right).toBeGreaterThanOrEqual(86);
    expect(m!.contentBox!.x1).toBeGreaterThanOrEqual(1079);
  });

  it("reports caption-band occupancy separately from other regions", async () => {
    const m = await analyzeFrame(caption);
    expect(m).not.toBeNull();
    expect(m!.regionOccupancy.subtitleBand).toBeGreaterThan(0.1);
    expect(m!.regionOccupancy.top).toBe(0);
    expect(m!.regionOccupancy.bottom).toBeGreaterThan(0.02);
  });

  it("is deterministic: same file, same metrics", async () => {
    const a = await analyzeFrame(interior);
    const b = await analyzeFrame(interior);
    expect(a).toEqual(b);
  });

  it("frame diff separates different frames and is 0 for identical ones", async () => {
    const same = await frameDiff(interior, interior);
    expect(same).toBe(0);
    const diff = await frameDiff(interior, edge);
    expect(diff).not.toBeNull();
    expect(diff!).toBeGreaterThan(0.01);
  });

  it("returns null for a missing frame instead of throwing", async () => {
    expect(await analyzeFrame(path.join(dir, "missing.png"))).toBeNull();
  });

  it("builds an evidence report with per-scene rollups and motion deltas", async () => {
    fs.copyFileSync(interior, path.join(dir, "a.png"));
    fs.copyFileSync(edge, path.join(dir, "b.png"));
    const report = await buildFrameEvidence({
      label: "t1",
      samples: [
        { sceneId: "fe_scene", sampleIndex: 0, reason: "early", timeSec: 0.45, sceneFrame: 14, absoluteFrame: 14, file: "a.png" },
        { sceneId: "fe_scene", sampleIndex: 1, reason: "mid", timeSec: 1.5, sceneFrame: 45, absoluteFrame: 45, file: "b.png" },
      ],
      resolve: (rel) => path.join(dir, rel),
      sourceRender: { file: "renders/preview.mp4", sha256: "abc123" },
      scenesHash: "sceneshash",
      generatedAt: "2026-10-08T00:00:00.000Z",
    });
    expect(report.schema).toBe("frame-evidence/1");
    expect(report.generatedAt).toBe("2026-10-08T00:00:00.000Z");
    expect(report.samples).toHaveLength(2);
    expect(report.samples[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.samples[0].metrics!.occupancy).toBeGreaterThan(0);
    expect(report.sceneRollup).toHaveLength(1);
    expect(report.sceneRollup[0].motionDelta).toBeGreaterThan(0);
    expect(report.sceneRollup[0].contentOutsideFrame).toBe(true); // second sample touches the edge
    expect(report.sourceRender!.sha256).toBe("abc123");
    expect(report.scenesHash).toBe("sceneshash");
    fs.rmSync(path.join(dir, "a.png"), { force: true });
    fs.rmSync(path.join(dir, "b.png"), { force: true });
  }, 60000);
});
