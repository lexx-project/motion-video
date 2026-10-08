import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { selectComposition, renderStill } from "@remotion/renderer";
import { getBundle } from "../src/render/renderProject";
import { frameStats, conformanceScores } from "../src/reference/conformance";
import { validateScene } from "../src/validation/validate";
import type { SceneSpec } from "../src/validation/schema";

const execFileAsync = promisify(execFile);

/**
 * Golden visual tests (Phase 2 §17): deterministic scenes rendered to stills,
 * then structural + pixel-sanity assertions (NOT exact pixel equality).
 */
const golden: Record<string, SceneSpec> = {
  typography: {
    sceneId: "golden_typography",
    duration: 3,
    purpose: "headline emphasis carries the message",
    visualConcept: "gold_keyword_reveal",
    composition: "typographyDominant",
    headline: { text: "WORDS ARE THE WEAPON", accentWords: ["WEAPON"], align: "left" },
    elements: [
      { primitive: "Label", text: "CHOOSE THEM WISELY", position: "bottom", accent: "none", delay: 0.5 },
    ],
    motion: { entrance: "reveal", emphasis: "highlight", exit: "fade" },
    timing: { entranceAt: 0, emphasisAt: 1.2 },
  },
  object: {
    sceneId: "golden_object",
    duration: 3,
    purpose: "progress is visible",
    visualConcept: "progress_climbs",
    composition: "leftTextRightObject",
    headline: { text: "MOMENTUM BUILDS", accentWords: [], align: "left" },
    elements: [
      { primitive: "ProgressBar", value: 0.7, label: "MOMENTUM", showValue: true, position: "right", accent: "teal", delay: 0.4 },
    ],
    motion: { entrance: "fade", emphasis: "controlledReveal", exit: "fade" },
    timing: { entranceAt: 0, emphasisAt: 1.5 },
  },
  composition: {
    sceneId: "golden_composition",
    duration: 3,
    purpose: "text left object right layout",
    visualConcept: "split_attention",
    composition: "leftTextRightObject",
    headline: { text: "TWO SIDES, ONE CHOICE", accentWords: ["CHOICE"], align: "left" },
    elements: [
      { primitive: "Circle", position: "right", accent: "gold", diameterPct: 34, delay: 0.4 },
    ],
    motion: { entrance: "slide", emphasis: "subtleScale", exit: "dissolve" },
    timing: { entranceAt: 0, emphasisAt: 1.4 },
  },
  motion: {
    sceneId: "golden_motion",
    duration: 3,
    purpose: "staggered entries are visible over time",
    visualConcept: "steps_appear_one_by_one",
    composition: "topTextBottomObject",
    headline: { text: "STEP BY STEP", accentWords: [], align: "left" },
    elements: [
      { primitive: "Sequence", position: "bottom", accent: "teal", delay: 0.2, items: [
        { label: "NOTICE", state: "done" },
        { label: "DECIDE", state: "active" },
        { label: "ACT", state: "todo" },
      ] },
    ],
    motion: { entrance: "stagger", emphasis: "counterChange", exit: "fade" },
    timing: { entranceAt: 0, emphasisAt: 1.5 },
  },
  fullScene: {
    sceneId: "golden_full",
    duration: 4,
    purpose: "complete scene inside the reference language",
    visualConcept: "loop_breaks",
    composition: "centered",
    headline: { text: "BREAK THE LOOP", accentWords: ["LOOP"], align: "center" },
    elements: [
      { primitive: "Timeline", position: "bottom", accent: "teal", delay: 0.4, orientation: "vertical", items: [
        { label: "OLD PATTERN", state: "done" },
        { label: "NEW PATTERN", state: "active" },
      ] },
      { primitive: "Label", text: "IT ENDS WHEN YOU DO", position: "top", delay: 0.8 },
    ],
    motion: { entrance: "reveal", emphasis: "highlight", exit: "fade" },
    timing: { entranceAt: 0, emphasisAt: 2 },
  },
};

const stills = new Map<string, string>();

async function renderGoldenStill(scene: SceneSpec, frame: number): Promise<string> {
  const serveUrl = await getBundle();
  const inputProps = { scenes: [scene] };
  const composition = await selectComposition({ serveUrl, id: "Project", inputProps });
  const out = path.join(os.tmpdir(), `golden_${scene.sceneId}_${frame}.png`);
  await renderStill({ composition, serveUrl, output: out, frame, inputProps, timeoutInMilliseconds: 120000 });
  return out;
}

async function rawAt(file: string, w = 64, h = 36): Promise<Buffer> {
  const tmp = `${file}.raw`;
  await execFileAsync("ffmpeg", ["-hide_banner", "-y", "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-pix_fmt", "rgb24", "-f", "rawvideo", tmp]);
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return buf;
}

const meanDiff = (a: Buffer, b: Buffer): number => {
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc += Math.abs(a[i] - b[i]);
  return acc / (a.length * 255);
};

describe("golden visual tests", () => {
  beforeAll(async () => {
    for (const scene of Object.values(golden)) {
      const check = validateScene(scene);
      expect(check.success, check.errors.join("; ")).toBe(true);
    }
    // mid-scene stills
    for (const scene of Object.values(golden)) {
      stills.set(`${scene.sceneId}:mid`, await renderGoldenStill(scene, Math.round(scene.duration * 30 * 0.55)));
    }
    // motion pair: early (during entrance) vs mid
    stills.set("golden_motion:early", await renderGoldenStill(golden.motion, 4));
  }, 300000);

  it("all golden scenes validate against the schema", () => {
    for (const scene of Object.values(golden)) {
      expect(validateScene(scene).success).toBe(true);
    }
  });

  it("typography scene: dark background + visible text + restrained bright area", async () => {
    const stats = await frameStats(stills.get("golden_typography:mid")!);
    expect(stats).not.toBeNull();
    expect(stats!.meanLuma).toBeLessThan(60);
    expect(stats!.textPixelShare).toBeGreaterThan(0.004);
    expect(stats!.textPixelShare).toBeLessThan(0.35);
  });

  it("object scene: teal accent present but restrained", async () => {
    const stats = await frameStats(stills.get("golden_object:mid")!);
    expect(stats!.meanLuma).toBeLessThan(60);
    expect(stats!.accentPixelShare).toBeGreaterThan(0.0005);
    expect(stats!.accentPixelShare).toBeLessThan(0.3);
  });

  it("composition scene: frame stays dark and text stays inside safety share", async () => {
    const stats = await frameStats(stills.get("golden_composition:mid")!);
    expect(stats!.meanLuma).toBeLessThan(60);
    expect(stats!.textPixelShare).toBeLessThan(0.35);
    // structural: composition score must reflect reference language
    const conf = conformanceScores(golden.composition);
    expect(conf.scores.composition).toBeGreaterThanOrEqual(8);
  });

  it("motion scene: entrance frames actually differ over time (deterministic animation)", async () => {
    const early = await rawAt(stills.get("golden_motion:early")!);
    const mid = await rawAt(stills.get("golden_motion:mid")!);
    const diff = meanDiff(early, mid);
    expect(diff).toBeGreaterThan(0.001);
    expect(diff).toBeLessThan(0.6);
  });

  it("full scene: passes reference conformance >= 8 and renders dark with text", async () => {
    const conf = conformanceScores(golden.fullScene);
    expect(conf.overall).toBeGreaterThanOrEqual(8);
    const stats = await frameStats(stills.get("golden_full:mid")!);
    expect(stats!.meanLuma).toBeLessThan(60);
    expect(stats!.textPixelShare).toBeGreaterThan(0.004);
  });

  it("every golden scene conforms structurally (>= 8 overall)", () => {
    for (const scene of Object.values(golden)) {
      const conf = conformanceScores(scene);
      expect(conf.overall, `${scene.sceneId}: ${conf.evidence.join("; ")}`).toBeGreaterThanOrEqual(8);
    }
  });
});
