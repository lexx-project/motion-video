import { describe, it, expect } from "vitest";
import { statsOf, QA_EVALUATORS } from "../src/agents/qa";
import { conformanceScores, applyFrameStats } from "../src/reference/conformance";
import { conceptChanged } from "../src/agents/repair";
import { candidateSchema, repairReportSchema, visualQaSchema, evaluatorResultSchema } from "../src/agents/schemas";
import { analyzeRawColors } from "../src/reference/extract";
import { validateScene } from "../src/validation/validate";
import type { SceneSpec } from "../src/validation/schema";

const scene = (over: Record<string, unknown> = {}): SceneSpec => {
  const r = validateScene({
    sceneId: "scene_01",
    duration: 3,
    purpose: "test purpose for scene",
    visualConcept: "test_concept",
    composition: "centered",
    headline: { text: "SHORT LINE", accentWords: [], align: "left" },
    elements: [{ primitive: "Circle", position: "bottom", accent: "teal" }],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    ...over,
  });
  if (!r.success) throw new Error(r.errors.join("; "));
  return r.scene!;
};

describe("multi-sample QA statistics (Phase 2 §11-12)", () => {
  it("computes mean/median/variance/confidence", () => {
    const s = statsOf([8, 9, 7]);
    expect(s.median).toBe(8);
    expect(s.mean).toBeCloseTo(8, 1);
    expect(s.variance).toBeGreaterThan(0);
    expect(s.confidence).toBeGreaterThan(0.8);
  });

  it("high variance lowers confidence (unstable judges)", () => {
    const stable = statsOf([8, 8, 8]);
    const unstable = statsOf([3, 8, 10]);
    expect(stable.variance).toBe(0);
    expect(stable.confidence).toBeGreaterThan(unstable.confidence);
    expect(unstable.confidence).toBeLessThan(0.6);
  });

  it("median is outlier-immune: one evaluator cannot drag the decision", () => {
    expect(statsOf([9, 9, 2]).median).toBe(9);
    expect(statsOf([9, 9, 2]).mean).toBeLessThan(9);
  });

  it("uses three independent evaluators with distinct lenses/temperatures", () => {
    expect(QA_EVALUATORS).toHaveLength(3);
    const temps = QA_EVALUATORS.map((e) => e.temperature);
    expect(new Set(temps).size).toBe(3);
    const lenses = QA_EVALUATORS.map((e) => e.lens).join(" ");
    expect(lenses).toMatch(/script-communication/);
    expect(lenses).toMatch(/design-craft/);
    expect(lenses).toMatch(/skeptic/);
  });

  it("aggregated visual QA schema requires stats + evaluatorCount", () => {
    const good = {
      scriptRelevance: 8, visualClarity: 8, designConsistency: 8, typography: 8,
      composition: 8, motionQuality: 8, novelty: 8, aiSlopSeverity: 2,
    };
    expect(() =>
      visualQaSchema.parse({
        evaluatorCount: 3,
        projectStatus: "pass",
        overall: { ...good, technicalCorrectness: "pass", stats: { mean: 8, median: 8, variance: 0.2, confidence: 0.9 } },
        scenes: [{ sceneId: "scene_01", scores: good, stats: { mean: 8, median: 8, variance: 0.2, confidence: 0.9 }, technicalCorrectness: "pass", issues: [], recommendedRepair: [] }],
      }),
    ).not.toThrow();
    expect(() =>
      evaluatorResultSchema.parse({ scenes: [{ sceneId: "scene_01", scores: good }], overall: good }),
    ).not.toThrow();
  });
});

describe("reference conformance (Phase 2 §8)", () => {
  it("scores a clean scene high", () => {
    const conf = conformanceScores(scene());
    expect(conf.overall).toBeGreaterThanOrEqual(8);
    expect(conf.evidence.length).toBeGreaterThan(0);
  });

  it("punishes multiple accents (one dominant accent rule)", () => {
    const conf = conformanceScores(
      scene({ elements: [
        { primitive: "Circle", position: "left", accent: "teal" },
        { primitive: "Arrow", position: "right", accent: "gold" },
        { primitive: "Badge", position: "top", text: "GO", accent: "red" },
      ] }),
    );
    expect(conf.scores.color).toBeLessThan(7);
  });

  it("punishes off-reference grammar", () => {
    const conf = conformanceScores(scene({ composition: "rightTextLeftObject" }));
    expect(conf.scores.composition).toBeLessThan(8);
  });

  it("applies dynamic density budget (Phase 3): sparse penalized, guideline>8 penalized", () => {
    // sparse: only 1 renderable element
    const sparse = conformanceScores(
      scene({ elements: [{ primitive: "Circle", position: "center", role: "semantic", purpose: "the cycle itself" }] }),
    );
    expect(sparse.scores.density).toBeLessThan(8);
    expect(sparse.evidence.join(" ")).toMatch(/SPARSE/);

    // guideline-pressure: 9 renderable elements (schema hard max is 10)
    const dense = conformanceScores(
      scene({ elements: [
        { primitive: "Circle", position: "left", role: "semantic", purpose: "focus" },
        { primitive: "Clock", position: "right" },
        { primitive: "Grid", position: "top" },
        { primitive: "Stack", position: "bottom" },
        { primitive: "Label", text: "A", position: "topLeft" },
        { primitive: "Label", text: "B", position: "topRight" },
        { primitive: "Label", text: "C", position: "bottomLeft" },
        { primitive: "Badge", text: "GO", position: "bottomRight" },
        { primitive: "Arrow", position: "center" },
      ] }),
    );
    expect(dense.scores.density).toBeLessThanOrEqual(8);
    expect(dense.evidence.join(" ")).toMatch(/exceeds guideline 8/);
  });

  it("penalizes generic shapes without documented semantic roles", () => {
    const conf = conformanceScores(
      scene({ elements: [
        { primitive: "Circle", position: "left" },
        { primitive: "Arrow", position: "right" },
      ] }),
    );
    expect(conf.evidence.join(" ")).toMatch(/GENERIC/);
    expect(conf.scores.density).toBeLessThan(9);
  });

  it("detects text-only scenes (unless typography is the mechanism)", () => {
    const textOnly = conformanceScores(
      scene({
        composition: "topTextBottomObject",
        elements: [{ primitive: "Label", text: "JUST TEXT", position: "bottom" }],
      }),
    );
    expect(textOnly.evidence.join(" ")).toMatch(/TEXT_ONLY/);
    expect(textOnly.scores.visualStyle).toBeLessThan(8);
  });

  it("applies frame stats: bright backgrounds reduce visual style score", () => {
    const base = conformanceScores(scene());
    const bright = applyFrameStats(base, { meanLuma: 140, textPixelShare: 0.02, accentPixelShare: 0.05, background: "#888888" });
    expect(bright.scores.visualStyle).toBeLessThan(base.scores.visualStyle);
    const clean = applyFrameStats(base, { meanLuma: 25, textPixelShare: 0.03, accentPixelShare: 0.05, background: "#0b1313" });
    expect(clean.scores.visualStyle).toBe(base.scores.visualStyle);
  });

  it("deterministic pixel color analyzer finds dark background", () => {
    const raw = Buffer.alloc(48 * 27 * 3);
    for (let i = 0; i < 48 * 27; i++) {
      const isBg = i % 10 !== 0;
      raw[i * 3] = isBg ? 11 : 244;
      raw[i * 3 + 1] = isBg ? 19 : 242;
      raw[i * 3 + 2] = isBg ? 19 : 237;
    }
    const s = analyzeRawColors(raw, 48, 27, "test");
    expect(parseInt(s.background.slice(1), 16)).toBeLessThan(0x202020);
    expect(s.textPrimary).not.toBeNull();
  });
});

describe("repair root-cause guard (Phase 2 §14)", () => {
  it("detects a silent full-concept replacement", () => {
    const before = scene();
    const after = scene({
      composition: "split",
      visualConcept: "totally_new_idea",
      elements: [
        { primitive: "Comparison", position: "center", leftLabel: "A", rightLabel: "B", leftItems: ["x"], rightItems: ["y"] },
        { primitive: "Flow", position: "bottom", steps: [{ label: "one" }, { label: "two" }] },
      ],
    });
    expect(conceptChanged(before, after)).toBe(true);
  });

  it("does not flag a minimal edit", () => {
    const before = scene();
    const after = scene({ headline: { text: "SHORT LINE", accentWords: [], align: "left" }, elements: [{ primitive: "Circle", position: "bottom", accent: "gold" }] });
    expect(conceptChanged(before, after)).toBe(false);
  });

  it("repair report schema requires issue/rootCause/scope/preserve", () => {
    const good = {
      issue: "headline collides with caption",
      rootCause: "both anchored to the same position slot",
      scope: "minimal",
      changesMade: ["moved caption to bottom"],
      preserve: ["headline typography", "color discipline"],
      expectedEffect: "collision removed",
      scene: scene() as unknown as Record<string, unknown>,
    };
    expect(() => repairReportSchema.parse(good)).not.toThrow();
    const { issue, ...missing } = good;
    void issue;
    expect(() => repairReportSchema.parse(missing)).toThrow();
  });
});

describe("concept schema (Phase 2 §9-10)", () => {
  it("requires semanticMechanism + whyViewerUnderstandsIt", () => {
    const base = {
      id: "c1",
      concept: "looping calendar",
      metaphor: "same days repeat",
      semanticMechanism: "the grid refills identically while the counter resets",
      whyViewerUnderstandsIt: "identical repetition reads as a loop without words",
      composition: "centered",
      objects: ["Calendar"],
      typographyStrategy: "headline",
      motionOpportunity: "stagger",
      whyItWorks: "performs repetition",
      complexity: "low",
      primitiveSketch: ["Calendar", "Headline"],
    };
    expect(() => candidateSchema.parse(base)).not.toThrow();
    const { semanticMechanism, ...noMech } = base;
    void semanticMechanism;
    expect(() => candidateSchema.parse(noMech)).toThrow();
  });
});
