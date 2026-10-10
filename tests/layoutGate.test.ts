import { describe, it, expect, afterEach } from "vitest";
import {
  evaluateLayoutGate,
  layoutFinding,
  LAYOUT_GATES,
  worstMetricsForScene,
} from "../src/validation/layoutGate";
import { sceneRenderedGeometry } from "../src/scenes/rendererGeometry";
import { resetTextMetricsCache, setTextMetrics, metricKey, type TextStyle } from "../src/render/measureText";
import { typography } from "../src/core/designSystem";
import type { SceneSpec } from "../src/validation/schema";
import type { FrameEvidenceReport, FrameMetrics } from "../src/render/frameEvidence";

/**
 * Batch B / B4 gate tests: model evidence, rendered evidence and their agreement.
 * Thresholds are the calibrated constants - never tuned per fixture.
 */

const headlineStyle = (): TextStyle => {
  const t = typography.scale.headline;
  return { family: "Archivo", sizePx: t.default, weight: t.weight, letterSpacingEm: t.letterSpacingEm, lineHeight: t.lineHeight, uppercase: t.uppercase };
};

const scene = (over: Partial<SceneSpec>): SceneSpec =>
  ({
    sceneId: "gate_fixture",
    duration: 3,
    purpose: "p",
    visualConcept: "c",
    composition: "centered",
    elements: [],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    ...over,
  }) as unknown as SceneSpec;

const metrics = (over: Partial<FrameMetrics> = {}): FrameMetrics => ({
  width: 1080,
  height: 1920,
  analysisWidth: 540,
  analysisHeight: 960,
  scale: 0.5,
  background: "#070d0d",
  occupancy: 0.05,
  brightShare: 0.04,
  accentShare: 0.01,
  meanLuma: 24,
  edgeInk: { left: 0, right: 0, top: 0, bottom: 0 },
  edgeBandAnalysisPx: 6,
  contentBox: { x0: 86, y0: 192, x1: 994, y1: 1651 },
  safeAreaOverflow: { left: 0, top: 0, right: 0, bottom: 0, outside: false },
  contentOutsideFrame: false,
  regionOccupancy: { top: 0.05, middle: 0.05, bottom: 0.05, subtitleBand: 0.05 },
  ...over,
});

const clipped = (): FrameMetrics =>
  metrics({
    edgeInk: { left: 0, right: 419, top: 0, bottom: 0 },
    contentBox: { x0: 86, y0: 460, x1: 1080, y1: 1652 },
    safeAreaOverflow: { left: 0, top: 0, right: 86, bottom: 1, outside: true },
    contentOutsideFrame: true,
  });

afterEach(() => resetTextMetricsCache());

describe("layout gate: model + rendered agreement", () => {
  it("flags model-predicted clipping as a hard failure even without rendered evidence", async () => {
    const style = headlineStyle();
    setTextMetrics({ [metricKey("OVERFLOWING", style)]: 300 });
    const s = scene({
      composition: "leftTextRightObject",
      elements: [{ primitive: "WordReveal", text: "OVERFLOWING", position: "right", scale: 2.2, role: "semantic", purpose: "hero" }],
    });
    const finding = await evaluateLayoutGate(s, null);
    expect(finding.hard.length).toBeGreaterThan(0);
    expect(finding.hard.join(" ")).toMatch(/MODEL clipping/);
    expect(finding.agreement.frame).toBe("model-only");
    expect(finding.model.frameViolations[0].px).toBeGreaterThanOrEqual(LAYOUT_GATES.modelFrameClipPx);
  });

  it("reports BOTH agreeing when pixels confirm the model", async () => {
    const style = headlineStyle();
    setTextMetrics({ [metricKey("OVERFLOWING", style)]: 300 });
    const s = scene({
      composition: "leftTextRightObject",
      elements: [{ primitive: "WordReveal", text: "OVERFLOWING", position: "right", scale: 2.2, role: "semantic", purpose: "hero" }],
    });
    const geo = sceneRenderedGeometry(s);
    const finding = layoutFinding(s, geo, clipped());
    expect(finding.agreement.frame).toBe("both");
    expect(finding.hard.join(" ")).toMatch(/RENDERED clipping/);
    expect(finding.hard.join(" ")).toMatch(/MODEL clipping/);
    expect(finding.model.contentBox).not.toBeNull();
    expect(finding.rendered!.edgeInk.right).toBe(419);
  });

  it("surfaces a rendered-only clip as a hard failure plus a MODEL MISS warning", () => {
    const s = scene({ elements: [{ primitive: "Circle", position: "center", role: "semantic", purpose: "ring" }] });
    const geo = sceneRenderedGeometry(s);
    const finding = layoutFinding(s, geo, clipped());
    expect(finding.agreement.frame).toBe("rendered-only");
    expect(finding.hard.join(" ")).toMatch(/RENDERED clipping/);
    expect(finding.warnings.join(" ")).toMatch(/MODEL MISS/);
  });

  it("mild safe-area crossing is a warning, severe is a hard failure", async () => {
    const style = headlineStyle();
    setTextMetrics({ [metricKey("EDGEWORD", style)]: 240 });

    const mild = scene({ elements: [{ primitive: "WordReveal", text: "EDGEWORD", position: "right", scale: 1.3, role: "semantic", purpose: "edge" }] });
    const mildFinding = await evaluateLayoutGate(mild, null);
    expect(mildFinding.hard).toEqual([]);
    expect(mildFinding.warnings.join(" ")).toMatch(/safe-area crossing/);

    setTextMetrics({ [metricKey("HUGEWORDBLOCK", style)]: 700, [metricKey("HUGE", style)]: 250, [metricKey("WORDBLOCK", style)]: 450 });
    const severe = scene({
      composition: "leftTextRightObject",
      elements: [{ primitive: "WordReveal", text: "HUGEWORDBLOCK", position: "left", scale: 2.8, role: "semantic", purpose: "wall" }],
    });
    const severeFinding = await evaluateLayoutGate(severe, null);
    expect(severeFinding.hard.length).toBeGreaterThan(0);
    expect(severeFinding.hard.join(" ")).toMatch(/safe-area|clipping/);
  });

  it("a clean scene produces no hard failures", async () => {
    const s = scene({
      composition: "topTextBottomObject",
      headline: { text: "CLEAN", accentWords: [], align: "left" },
      elements: [{ primitive: "Circle", position: "bottom", diameterPct: 30, scale: 1, role: "semantic", purpose: "ring" }],
    });
    setTextMetrics({ [metricKey("CLEAN", headlineStyle())]: 320 });
    const finding = await evaluateLayoutGate(s, null);
    expect(finding.hard).toEqual([]);
    expect(finding.agreement.frame).toBe("neither");
    expect(finding.summary).toMatch(/hard=0/);
  });

  it("worstMetricsForScene merges the worst signals across samples", () => {
    const good = metrics();
    const bad = clipped();
    const report = {
      schema: "frame-evidence/1",
      label: "r1",
      generatedAt: "2026-10-08T00:00:00.000Z",
      fps: 30,
      sourceRender: null,
      scenesHash: null,
      samples: [
        { sceneId: "s", sampleIndex: 0, reason: "early", timeSec: 0.2, sceneFrame: 6, absoluteFrame: 6, file: "a.png", sha256: null, metrics: good },
        { sceneId: "s", sampleIndex: 1, reason: "mid", timeSec: 1.5, sceneFrame: 45, absoluteFrame: 45, file: "b.png", sha256: null, metrics: bad },
      ],
      sceneRollup: [],
    } as unknown as FrameEvidenceReport;

    const worst = worstMetricsForScene(report, "s")!;
    expect(worst.edgeInk.right).toBe(419);
    expect(worst.contentOutsideFrame).toBe(true);
    expect(worst.safeAreaOverflow.right).toBe(86);
    expect(worstMetricsForScene(report, "missing")).toBeNull();
  });
});
