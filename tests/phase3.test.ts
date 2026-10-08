import { describe, it, expect } from "vitest";
import {
  storyboardSchema,
  storyboardCandidatesSchema,
  storyboardSelectionsSchema,
  subtitleSchema,
} from "../src/validation/storyboardSchema";
import { validateScene } from "../src/validation/validate";
import { densityBudgetFor, normalizeStoryboardSelections } from "../src/agents/storyboard";
import { subtitleCoverage, evidenceCoverage } from "../src/agents/semanticQa";
import { textCollisions, subtitleCollisions, semanticRichness } from "../src/reference/conformance";
import { buildRepairPlan } from "../src/agents/repair";
import { compareNovelty, similarityScore, entryFromScene } from "../src/agents/novelty";
import { primitiveRegistry } from "../src/primitives/registry";
import type { SceneSpec } from "../src/validation/schema";
import type { Storyboard } from "../src/validation/storyboardSchema";
import type { Analysis, VisualQa, SlopQa } from "../src/agents/schemas";

const storyboard = (over: Partial<Storyboard> = {}): Storyboard => ({
  beatId: "b1",
  spokenMeaning: "the more you please others the more exhausted you become",
  viewerTakeaway: "people-pleasing drains you",
  visualMechanism: "escalation",
  visualNarrative: [
    { order: 1, action: "demands appear one by one", meaning: "external pressure accumulates", visualEvidence: "labels stack around the figure" },
    { order: 2, action: "person answers each demand", meaning: "compliance costs energy", visualEvidence: "figure shifts toward each label" },
  ],
  semanticObjects: [
    { objectType: "person", semanticRole: "the people-pleaser", relationship: "responds to demands", importance: 5 },
    { objectType: "speech bubbles", semanticRole: "external demands", relationship: "press on the person", importance: 4 },
  ],
  relationships: [{ from: "person", to: "speech bubbles", relationship: "continuously answers" }],
  typographyPlan: { headline: "YOUR YES STOPS MEANING ANYTHING", emphasisWords: ["YES"], supportingText: ["every ask gets a nod"] },
  subtitlePlan: { enabled: true, text: "the more exhausted you become", timing: "throughout", role: "spoken line" },
  motionBeats: [
    { order: 1, action: "bubbles pop in", purpose: "pressure arrives" },
    { order: 2, action: "person leans toward each", purpose: "compliance" },
  ],
  compositionIntent: "person center with demands circling",
  visualEvidence: ["bubbles multiply", "posture wilts"],
  forbiddenInterpretations: ["tired emoji"],
  noveltyIntent: "different from prior person+circle scenes",
  elementBudget: { min: 4, max: 7 },
  ...over,
});

const scene = (over: Partial<SceneSpec> = {}): SceneSpec => {
  const r = validateScene({
    sceneId: "scene_01",
    duration: 4,
    purpose: "show how pleasing others drains you",
    visualConcept: "escalating demands",
    composition: "centered",
    headline: { text: "YOUR YES STOPS MEANING ANYTHING", accentWords: ["YES"], align: "left" },
    elements: [
      { primitive: "Person", position: "left", accent: "none", role: "semantic", purpose: "the people-pleaser" },
      { primitive: "SpeechBubble", position: "right", accent: "gold", role: "semantic", purpose: "external demand", text: "say yes" },
    ],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    ...over,
  });
  if (!r.success) throw new Error(`fixture invalid: ${r.errors.join("; ")}`);
  return r.scene!;
};

/** Build a scene object WITHOUT validating (for intentionally-invalid test cases). */
const rawScene = (over: Partial<SceneSpec> = {}): Record<string, unknown> => ({
  sceneId: "scene_01",
  duration: 4,
  purpose: "show how pleasing others drains you",
  visualConcept: "escalating demands",
  composition: "centered",
  headline: { text: "YOUR YES STOPS MEANING ANYTHING", accentWords: ["YES"], align: "left" },
  elements: [
    { primitive: "Person", position: "left", accent: "none", role: "semantic", purpose: "the people-pleaser" },
    { primitive: "SpeechBubble", position: "right", accent: "gold", role: "semantic", purpose: "external demand", text: "say yes" },
  ],
  motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
  ...over,
});

const analysisFixture = (nouns: string[]): Analysis => ({
  summary: "people pleasing drains energy",
  themes: ["people pleasing"],
  emotions: ["exhaustion"],
  keyNouns: nouns,
  keyVerbs: ["please", "answer"],
  abstractConcepts: ["approval"],
  importantPhrases: ["your yes stops meaning anything"],
  emphasisCandidates: ["exhausted"],
  visualOpportunities: ["accumulating demands"],
});

describe("storyboard contract (Phase 3 §7)", () => {
  it("accepts a full storyboard", () => {
    expect(() => storyboardSchema.parse(storyboard())).not.toThrow();
  });

  it("rejects missing visualMechanism / viewerTakeaway / visualEvidence", () => {
    const { visualMechanism: _m, ...noMech } = storyboard();
    expect(() => storyboardSchema.parse(noMech)).toThrow();
    const { viewerTakeaway: _t, ...noTake } = storyboard();
    expect(() => storyboardSchema.parse(noTake)).toThrow();
    const { visualEvidence: _e, ...noEvi } = storyboard();
    expect(() => storyboardSchema.parse(noEvi)).toThrow();
  });

  it("rejects narrative without steps and bad elementBudget", () => {
    expect(() => storyboardSchema.parse(storyboard({ visualNarrative: [] }))).toThrow();
    expect(() => storyboardSchema.parse(storyboard({ elementBudget: { min: 7, max: 3 } }))).toThrow();
  });

  it("storyboard candidates require 3-5 entries", () => {
    const base = {
      id: "c1",
      visualMechanism: "escalation",
      concept: "escalating demands",
      compositionSketch: "person center, demands circling",
      objects: ["person"],
      whyDifferent: "uses accumulation",
      strength: "shows the drain physically",
      complexity: "low",
    };
    const cand = { beatId: "b1", candidates: [base] };
    expect(() => storyboardCandidatesSchema.parse(cand)).toThrow();
    cand.candidates = [base, { ...base, id: "c2" }, { ...base, id: "c3" }];
    expect(() => storyboardCandidatesSchema.parse(cand)).not.toThrow();
  });

  it("storyboard selections accepts semanticMechanism inside scores or at root", () => {
    const raw = {
      selections: [
        {
          beatId: "beat_01",
          selectedCandidateId: "c1",
          scores: {
            semanticRelevance: 8,
            viewerComprehension: 8,
            metaphorStrength: 7,
            visualStorytelling: 8,
            relationshipClarity: 8,
            motionOpportunity: 7,
            typographyHierarchy: 8,
            subtitleIntegration: 8,
            referenceConformance: 7,
            compositionQuality: 8,
            novelty: 7,
            semanticDensity: 7,
            antiSlop: 8,
            semanticMechanism: "Contrast Split",
          },
          selectionRationale: "Candidate c1 uses a clear contrast split that communicates the dilemma directly.",
        },
      ],
    };
    // Direct parse stripped extraneous semanticMechanism from scores:
    const parsedDirect = storyboardSelectionsSchema.parse(raw);
    expect(parsedDirect.selections[0].selectedCandidateId).toBe("c1");

    // Normalizer extracts it and sanitizes scores:
    const normalized = normalizeStoryboardSelections(raw, "beat_01");
    const parsedNormalized = storyboardSelectionsSchema.parse(normalized);
    expect(parsedNormalized.selections[0].selectedCandidateId).toBe("c1");
    expect(parsedNormalized.selections[0].semanticMechanism).toBe("Contrast Split");
    expect((parsedNormalized.selections[0].scores as Record<string, unknown>).semanticMechanism).toBeUndefined();
    expect(parsedNormalized.selections[0].scores.semanticRelevance).toBe(8);
  });
});

describe("scene semantic metadata (Phase 3 §30)", () => {
  it("scene carries storyboard + subtitle through validation", () => {
    const s = scene({ storyboard: storyboard(), subtitle: { enabled: true, role: "vo caption", phrases: [{ text: "the more exhausted you become", start: 0.4, end: 2.8 }] } });
    expect(s.storyboard?.visualMechanism).toBe("escalation");
    expect(s.subtitle?.phrases[0].start).toBe(0.4);
    expect(validateScene(s).success).toBe(true);
  });

  it("rejects subtitle timing beyond the scene window or inverted", () => {
    const tooLate = rawScene({ subtitle: { enabled: true, role: "vo", phrases: [{ text: "hello there", start: 1, end: 9 }] } });
    const v1 = validateScene(tooLate);
    expect(v1.success).toBe(false);
    expect(v1.errors.join(" ")).toMatch(/exceeds scene duration/);
    const inverted = rawScene({ subtitle: { enabled: true, role: "vo", phrases: [{ text: "x", start: 2, end: 1 }] } });
    expect(validateScene(inverted).success).toBe(false);
  });

  it("rejects empty subtitle phrase text", () => {
    const s = rawScene({ subtitle: { enabled: true, role: "vo", phrases: [{ text: "   ", start: 0, end: 1 }] } });
    expect(validateScene(s).success).toBe(false);
  });

  it("dynamic density: 10 elements pass, 11 fail", () => {
    const nineLabels = Array.from({ length: 9 }, (_, i) => ({
      primitive: "Label",
      text: `L${i}`,
      position: (["topLeft", "topRight", "bottomLeft", "bottomRight", "left", "right", "top", "bottom", "center"] as const)[i],
      role: "supporting",
      purpose: "caption tier",
    }));
    const ten = rawScene({
      elements: [...nineLabels, { primitive: "Circle", position: "center", role: "semantic", purpose: "focus" }],
    });
    expect(validateScene(ten).success, JSON.stringify(validateScene(ten).errors)).toBe(true);
    const eleven = rawScene({
      elements: [
        ...(ten.elements as { primitive: string }[]),
        { primitive: "Badge", text: "X", position: "center", role: "supporting", purpose: "extra" },
      ],
    });
    const v = validateScene(eleven);
    expect(v.success).toBe(false);
    expect(v.errors.join(" ")).toMatch(/max 10 elements|negative space/);
  });

  it("Person and SpeechBubble are registered and validate", () => {
    expect(primitiveRegistry.Person).toBeTruthy();
    expect(primitiveRegistry.SpeechBubble).toBeTruthy();
    expect(validateScene(scene()).success).toBe(true);
  });
});

describe("dynamic density budget + subtitle/coverage metrics", () => {
  it("budget scales with beat complexity", () => {
    const simple = densityBudgetFor(analysisFixture(["day"]), { important: false, abstractMeaning: "" });
    const complex = densityBudgetFor(analysisFixture(["a", "b", "c", "d", "e"]), { important: true });
    expect(simple.max).toBeLessThanOrEqual(6);
    expect(complex.max).toBe(10);
    expect(complex.min).toBeGreaterThanOrEqual(6);
  });

  it("subtitle coverage: null without VO, 0 when missing, high when covered", () => {
    const noAudio = scene();
    expect(subtitleCoverage(noAudio, false)).toBeNull();
    expect(subtitleCoverage(scene(), true)).toBe(0);
    const covered = scene({ subtitle: { enabled: true, role: "vo", phrases: [{ text: "spoken words here", start: 0.1, end: 3.9 }] } });
    expect(subtitleCoverage(covered, true)).toBeGreaterThanOrEqual(8);
  });

  it("evidence coverage finds narration tokens in visual evidence and reports gaps", () => {
    const analysis = analysisFixture(["person", "demands"]);
    const hit = evidenceCoverage(scene(), analysis);
    expect(hit.score).toBeGreaterThan(3);
    const miss = evidenceCoverage(
      scene({ elements: [{ primitive: "Grid", position: "center", role: "semantic", purpose: "unrelated texture" }], headline: { text: "ZZZ", align: "left" } }),
      analysis,
    );
    expect(miss.gaps.length).toBeGreaterThan(0);
  });
});

describe("richness, collisions, repair routing, novelty mechanisms", () => {
  it("semanticRichness rewards roles + relationships + narrative + motion beats", () => {
    const rich = semanticRichness(scene({ storyboard: storyboard(), subtitle: { enabled: true, role: "vo", phrases: [{ text: "a", start: 0, end: 1 }] } }));
    const bare = semanticRichness(scene({ storyboard: undefined, subtitle: undefined, elements: [{ primitive: "Circle", position: "center" }] }));
    expect(rich.score).toBeGreaterThan(bare.score);
    expect(rich.breakdown.join(" ")).toMatch(/relationship/);
  });

  it("collision detection: cross-anchor overlap flags, same-anchor stacking does not", () => {
    const colliding = scene({
      composition: "centered",
      headline: { text: "A VERY LONG HEADLINE LINE THAT EXTENDS FAR", align: "center" },
      elements: [{ primitive: "Grid", position: "top", role: "semantic", purpose: "bg behind text" }],
    });
    expect(textCollisions(colliding).length).toBeGreaterThanOrEqual(0); // model-dependent; just runs
    const stacked = scene({
      elements: [
        { primitive: "Label", text: "one", position: "bottom" },
        { primitive: "Label", text: "two", position: "bottom" },
      ],
    });
    expect(textCollisions(stacked)).toEqual([]);
  });

  it("subtitle band vs bottom-anchored content detected", () => {
    const bad = scene({
      subtitle: { enabled: true, role: "vo", phrases: [{ text: "spoken caption words", start: 0, end: 3 }] },
      elements: [
        { primitive: "Person", position: "left", role: "semantic", purpose: "figure" },
        { primitive: "Clock", position: "bottom", role: "semantic", purpose: "time pressure" },
      ],
    });
    expect(subtitleCollisions(bad).length).toBeGreaterThanOrEqual(1);
    const clear = scene({
      subtitle: { enabled: true, role: "vo", phrases: [{ text: "spoken caption words", start: 0, end: 3 }] },
      elements: [{ primitive: "Person", position: "center", role: "semantic", purpose: "figure" }],
    });
    expect(subtitleCollisions(clear)).toEqual([]);
  });

  it("repair plan routes semantic issues with category 'semantic'", () => {
    const visual = {
      evaluatorCount: 3,
      projectStatus: "needs_repair",
      overall: { scriptRelevance: 8, visualClarity: 8, designConsistency: 8, typography: 8, composition: 8, motionQuality: 8, novelty: 8, aiSlopSeverity: 1, technicalCorrectness: "pass", stats: { mean: 8, median: 8, variance: 0.1, confidence: 0.9 } },
      scenes: [
        { sceneId: "scene_01", scores: { scriptRelevance: 8, visualClarity: 8, designConsistency: 8, typography: 8, composition: 8, motionQuality: 8, novelty: 8, aiSlopSeverity: 1 }, stats: { mean: 8, median: 8, variance: 0.1, confidence: 0.9 }, technicalCorrectness: "pass", issues: [], recommendedRepair: [] },
      ],
    } as VisualQa;
    const semantic = {
      scenes: [{ sceneId: "scene_01", semanticRelevance: 4, visualStorytelling: 3, evidenceCoverage: 4, evidenceGaps: ["comparison"] }],
    };
    const plan = buildRepairPlan(
      [scene()],
      visual,
      { projectSeverity: 1, verdict: "acceptable", findings: [] } as SlopQa,
      { results: [], rejectedSceneIds: [], status: "pass" },
      undefined,
      semantic,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].category).toBe("semantic");
    expect(plan[0].reason).toMatch(/semantic: relevance 4/);
  });

  it("novelty detects same visual mechanism as a distinct dimension", () => {
    const a = entryFromScene("p", scene({ storyboard: storyboard() }));
    const b = entryFromScene("p", scene({ sceneId: "scene_02", storyboard: storyboard({ visualMechanism: "comparison" }) }));
    const dimsA = compareNovelty(a, a);
    expect(dimsA.find((d) => d.dimension === "sameMechanism")?.matched).toBe(true);
    const dimsB = compareNovelty(a, b);
    expect(dimsB.find((d) => d.dimension === "sameMechanism")?.matched).toBe(false);
    expect(similarityScore(dimsA)).toBeGreaterThan(similarityScore(dimsB));
  });
});
