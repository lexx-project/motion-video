import { describe, it, expect, afterEach } from "vitest";
import {
  emptySceneFinding,
  readabilityFinding,
  evaluateVisualGates,
  expectedBands,
  expectsVisualObjects,
  BAND_SPLITS,
  VISUAL_GATES,
} from "../src/validation/visualGates";
import { resetTextMetricsCache } from "../src/render/measureText";
import type { SceneSpec } from "../src/validation/schema";
import type { FrameEvidenceReport, FrameMetrics } from "../src/render/frameEvidence";

/**
 * Batch B / B9: Scene 04 regression - "many logical elements but visually empty".
 *
 * The detector must flag the scene from RENDERED evidence while the JSON declares plenty of
 * elements, and it must NOT flag a deliberately sparse typography-only scene.
 */

const scene = (over: Partial<SceneSpec>): SceneSpec =>
  ({
    sceneId: "visual_fixture",
    duration: 4,
    purpose: "p",
    visualConcept: "c",
    composition: "centered",
    elements: [],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    ...over,
  }) as unknown as SceneSpec;

/** Scene-04 shaped fixture: many semantic lines stacked in the middle band + a headline. */
const recordStageScene = (): SceneSpec =>
  scene({
    sceneId: "scene_04",
    composition: "topTextBottomObject",
    headline: { text: "NEVER BEND, GET REMEMBERED", accentWords: [], align: "left", position: "topLeft" },
    elements: [
      ...[0, 1, 2, 3].map((i) => ({
        primitive: "Line",
        position: "right",
        scale: 0.85,
        accent: "none",
        role: "semantic",
        purpose: `answer version ${i}`,
        delay: 0.3 + i * 0.15,
      })),
      { primitive: "Label", text: "HELD", position: "bottomRight", accent: "teal", role: "semantic", purpose: "survivor name" },
    ],
  });

const metricsFor = (over: Partial<FrameMetrics> = {}): FrameMetrics =>
  ({
    width: 1080,
    height: 1920,
    analysisWidth: 540,
    analysisHeight: 960,
    scale: 0.5,
    background: "#070d0d",
    occupancy: 0.044,
    brightShare: 0.037,
    accentShare: 0.01,
    meanLuma: 23,
    edgeInk: { left: 0, right: 0, top: 0, bottom: 0 },
    edgeBandAnalysisPx: 6,
    contentBox: { x0: 90, y0: 208, x1: 990, y1: 1652 },
    safeAreaOverflow: { left: 0, top: 0, right: 0, bottom: 0, outside: false },
    contentOutsideFrame: false,
    regionOccupancy: { top: 0.11, middle: 0.002, bottom: 0.016, subtitleBand: 0.053 },
    ...over,
  }) as FrameMetrics;

const evidence = (metrics: FrameMetrics[], motionDelta = 0.001, sceneId = "scene_04"): FrameEvidenceReport =>
  ({
    schema: "frame-evidence/1",
    label: "r1",
    generatedAt: "2026-10-08T00:00:00.000Z",
    fps: 30,
    sourceRender: null,
    scenesHash: null,
    samples: metrics.map((m, i) => ({
      sceneId,
      sampleIndex: i,
      reason: i === 0 ? "early" : i === metrics.length - 1 ? "late" : "mid",
      timeSec: i * 1.2,
      sceneFrame: i * 36,
      absoluteFrame: i * 36,
      file: `f${i}.png`,
      sha256: null,
      metrics: m,
    })),
    sceneRollup: [
      {
        sceneId,
        sampleCount: metrics.length,
        minOccupancy: Math.min(...metrics.map((m) => m.occupancy)),
        maxEdgeInk: 0,
        maxSafeAreaOverflowPx: 0,
        contentOutsideFrame: false,
        motionDelta,
      },
    ],
  }) as unknown as FrameEvidenceReport;

afterEach(() => resetTextMetricsCache());

describe("empty-scene detector (Scene 04 regression)", () => {
  it("flags a scene with many elements whose expected band renders empty", () => {
    const s = recordStageScene();
    expect(s.elements.length).toBeGreaterThanOrEqual(5); // JSON looks rich
    const finding = emptySceneFinding(s, evidence([metricsFor(), metricsFor(), metricsFor()]));

    expect(finding.status).toBe("fail");
    expect(finding.reason).toMatch(/accidentally empty/);
    expect(finding.reason).toMatch(/middle/);
    expect(finding.occupancy).toBeCloseTo(0.044, 3); // whole-frame occupancy looks fine...
    expect(finding.regionOccupancy!.middle).toBeCloseTo(0.002, 4); // ...but the band is dead
    expect(finding.motionDelta).toBeCloseTo(0.001, 4);
    expect(finding.contentBBox).not.toBeNull();
    const middle = finding.bands.find((b) => b.band === "middle")!;
    expect(middle.expectedBoxes).toBeGreaterThanOrEqual(VISUAL_GATES.minExpectedBoxesToFail);
    expect(middle.occupancy).toBeLessThan(VISUAL_GATES.bandOccupancyFloor);
  });

  it("passes the same scene when the band actually carries content", () => {
    const s = recordStageScene();
    const healthy = metricsFor({ regionOccupancy: { top: 0.11, middle: 0.052, bottom: 0.02, subtitleBand: 0.05 } });
    const finding = emptySceneFinding(s, evidence([healthy, healthy]));
    expect(finding.status).toBe("ok");
    expect(finding.reason).toMatch(/expected bands carry visible content/);
  });

  it("recognises a deliberately sparse typography-only scene (intentional sparse)", () => {
    const s = scene({
      sceneId: "sparse",
      composition: "typographyDominant",
      headline: { text: "ONE LINE ONLY", accentWords: [], align: "center" },
      elements: [{ primitive: "Label", text: "AND A SMALL CAPTION", position: "bottom", accent: "none", role: "semantic", purpose: "supporting line" }],
    });
    expect(expectsVisualObjects(s)).toBe(false);
    expect(expectedBands(s)).toEqual([]);

    const thin = metricsFor({ occupancy: 0.012, regionOccupancy: { top: 0.01, middle: 0.0, bottom: 0.005, subtitleBand: 0.02 } });
    const finding = emptySceneFinding(s, evidence([thin], 0.0002, "sparse"));
    expect(finding.status).toBe("ok");
    expect(finding.reason).toMatch(/intentional sparse/);
  });

  it("does not evaluate emptiness when frame evidence is missing", () => {
    const finding = emptySceneFinding(recordStageScene(), null);
    expect(finding.status).toBe("ok");
    expect(finding.reason).toMatch(/no frame evidence/);
    expect(finding.occupancy).toBeNull();
  });

  it("computes band expectations from rendered geometry (not element count)", () => {
    const s = recordStageScene();
    const bands = expectedBands(s);
    const middle = bands.find((b) => b.band === "middle");
    expect(middle).toBeDefined();
    expect(middle!.count).toBeGreaterThanOrEqual(4);
    expect(BAND_SPLITS.top).toBe(0.35);
    expect(BAND_SPLITS.middle).toBe(0.75);
  });
});

describe("readability evidence", () => {
  it("fails when nothing bright is rendered although text exists", () => {
    const s = scene({ headline: { text: "INVISIBLE", accentWords: [], align: "left" }, elements: [] });
    const dark = metricsFor({ brightShare: 0.0005 });
    const f = readabilityFinding(s, evidence([dark], 0.001, "visual_fixture"));
    expect(f.status).toBe("fail");
    expect(f.reasons.join(" ")).toMatch(/text effectively invisible/);
    expect(f.brightShare).toBeCloseTo(0.0005, 5);
  });

  it("reports a headline that is painted unreadably small", () => {
    const s = scene({
      composition: "centered",
      headline: { text: "TINY", accentWords: [], align: "left" },
      elements: [{ primitive: "WordReveal", text: "TINY", position: "center", scale: 0.12, role: "semantic", purpose: "shrunk word" }],
    });
    const f = readabilityFinding(s, evidence([metricsFor()], 0.001, "visual_fixture"));
    expect(f.smallestTextHeightPx).not.toBeNull();
    expect(f.smallestTextHeightPx!).toBeLessThan(VISUAL_GATES.unreadableTextPx);
    expect(f.status).toBe("fail");
    expect(f.reasons.join(" ")).toMatch(/unreadable/);
  });

  it("flags captions that are enabled but produce no ink", () => {
    const s = scene({
      sceneId: "scene_04",
      headline: { text: "CAPTIONS ON", accentWords: [], align: "left" },
      elements: [],
      subtitle: { enabled: true, role: "vo caption", phrases: [{ text: "spoken words", start: 0, end: 3 }] },
    });
    const f = readabilityFinding(
      s,
      evidence([metricsFor({ regionOccupancy: { top: 0.11, middle: 0.0, bottom: 0.016, subtitleBand: 0.0002 } })], 0.001, "scene_04"),
    );
    expect(f.status).toBe("suspicious");
    expect(f.reasons.join(" ")).toMatch(/caption band/);
  });

  it("flags a scene with no measurable motion", () => {
    const s = scene({ headline: { text: "STATIC", accentWords: [], align: "left" }, elements: [] });
    const f = readabilityFinding(s, evidence([metricsFor()], 0.0001, "visual_fixture"));
    expect(f.reasons.join(" ")).toMatch(/no measurable motion/);
  });
});

describe("visual gate report", () => {
  it("aggregates hard failures and warnings without hiding either", () => {
    const empty = recordStageScene();
    const sparse = scene({
      sceneId: "sparse",
      composition: "typographyDominant",
      headline: { text: "CALM", accentWords: [], align: "center" },
      elements: [],
    });
    const ev = evidence([metricsFor()]);
    // make the evidence's rollup/samples belong to scene_04 only; sparse gets its own
    const report = evaluateVisualGates([empty, sparse], ev);
    const emptyRow = report.scenes.find((r) => r.sceneId === "scene_04")!;

    expect(emptyRow.empty.status).toBe("fail");
    expect(report.ok).toBe(false);
    expect(report.hard.join(" ")).toMatch(/scene_04/);
    expect(report.schema).toBe("visual-gates/1");

    const sparseRow = report.scenes.find((r) => r.sceneId === "sparse")!;
    expect(sparseRow.empty.status).toBe("ok");
  });
});
