import { describe, it, expect } from "vitest";
import { aggregateQa, compactEvidenceLines } from "../src/agents/qa";
import type { VisualQa, SlopQa } from "../src/agents/schemas";
import type { TechnicalQaResult } from "../src/render/renderProject";
import type { NoveltyReport } from "../src/agents/novelty";
import type { LayoutGateReport } from "../src/validation/layoutGate";
import type { VisualGateReport } from "../src/validation/visualGates";
import type { FrameEvidenceReport } from "../src/render/frameEvidence";
import type { SceneSpec } from "../src/validation/schema";
import { evaluateSemanticEnactment } from "../src/validation/semanticEnactment";
import { missingObjectScene, passScene } from "./fixtures/batchD";

/**
 * Batch B / B5 + B6: deterministic frame evidence must reach aggregate QA and the judges,
 * and must be able to FAIL a project that the LLM scores would otherwise pass.
 */

const goodScores = {
  scriptRelevance: 9,
  visualClarity: 9,
  designConsistency: 9,
  typography: 9,
  composition: 9,
  motionQuality: 9,
  novelty: 8,
  aiSlopSeverity: 1,
};

const technicalOk: TechnicalQaResult = {
  file: "x.mp4",
  durationSec: 9,
  width: 1080,
  height: 1920,
  fps: 30,
  hasAudio: true,
  videoCodec: "h264",
  audioCodec: "aac",
  errors: [],
};

const stableStats = { mean: 9, median: 9, variance: 0.1, confidence: 0.9 };

const visual: VisualQa = {
  evaluatorCount: 3,
  projectStatus: "pass",
  overall: { ...goodScores, technicalCorrectness: "pass", stats: stableStats },
  scenes: [
    {
      sceneId: "scene_01",
      scores: { ...goodScores },
      stats: stableStats,
      technicalCorrectness: "pass",
      issues: [],
      recommendedRepair: [],
    },
  ],
};

const slop: SlopQa = { projectSeverity: 1, verdict: "acceptable", findings: [] };
const novelty: NoveltyReport = { results: [], rejectedSceneIds: [], status: "pass" };

const layoutGate = (over: Partial<LayoutGateReport>): LayoutGateReport => ({
  schema: "layout-gate/1",
  generatedAt: "2026-10-08T00:00:00.000Z",
  findings: [
    {
      sceneId: "scene_01",
      model: { frameViolations: [], safeAreaViolations: [], contentBox: null, contentBoxRounded: null, sources: [] },
      rendered: null,
      agreement: { frame: "neither", safeArea: "neither" },
      hard: [],
      warnings: [],
      summary: "clean",
    },
  ],
  hard: [],
  warnings: [],
  ok: true,
  disagreements: 0,
  ...over,
});

const visualGates = (over: Partial<VisualGateReport>): VisualGateReport => ({
  schema: "visual-gates/1",
  generatedAt: "2026-10-08T00:00:00.000Z",
  scenes: [],
  hard: [],
  warnings: [],
  ok: true,
  ...over,
});

describe("aggregate QA consumes deterministic evidence (B5/B7)", () => {
  it("passes when the deterministic gates are clean (regression)", () => {
    const qa = aggregateQa(technicalOk, visual, slop, novelty, undefined, undefined, {
      layoutGate: layoutGate({}),
      visualGates: visualGates({}),
    });
    expect(qa.status).toBe("pass");
    expect(qa.reasons).toEqual([]);
  });

  it("fails the project on a hard layout finding even when every LLM score is 9", () => {
    const gate = layoutGate({
      ok: false,
      hard: ["scene_01: RENDERED clipping - 419 edge-ink px on the right edge (content box reaches the frame)"],
      findings: [
        {
          sceneId: "scene_01",
          model: { frameViolations: [], safeAreaViolations: [], contentBox: null, contentBoxRounded: null, sources: [] },
          rendered: null,
          agreement: { frame: "rendered-only", safeArea: "neither" },
          hard: ["scene_01: RENDERED clipping - 419 edge-ink px on the right edge"],
          warnings: [],
          summary: "hard=1",
        },
      ],
      disagreements: 1,
    });
    const qa = aggregateQa(technicalOk, visual, slop, novelty, undefined, undefined, { layoutGate: gate });
    expect(qa.status).toBe("fail");
    expect(qa.reasons.join(" ")).toMatch(/RENDERED clipping/);
    expect(qa.reasons.join(" ")).toMatch(/contradicts a passing vision score/);
    expect(qa.reasons.join(" ")).toMatch(/disagree on 1 scene/);
  });

  it("fails the project on an empty-scene hard finding (Scene 04 principle)", () => {
    const gates = visualGates({
      ok: false,
      hard: ["scene_01: accidentally empty: 4 non-text objects are placed in the middle band but its rendered occupancy is 0.200%"],
    });
    const qa = aggregateQa(technicalOk, visual, slop, novelty, undefined, undefined, { visualGates: gates });
    expect(qa.status).toBe("fail");
    expect(qa.reasons.join(" ")).toMatch(/accidentally empty/);
  });

  it("keeps warnings as repairable reasons (not failures)", () => {
    const gate = layoutGate({
      warnings: ["scene_01: model safe-area crossing 26px on right (Line[1])"],
    });
    const qa = aggregateQa(technicalOk, visual, slop, novelty, undefined, undefined, { layoutGate: gate });
    expect(qa.status).toBe("needs_repair");
    expect(qa.reasons.join(" ")).toMatch(/safe-area crossing 26px/);
  });
});

describe("compact judge evidence (B6)", () => {
  const scene = (over: Partial<SceneSpec>): SceneSpec =>
    ({
      sceneId: "scene_01",
      duration: 3,
      purpose: "p",
      visualConcept: "c",
      composition: "centered",
      elements: [],
      motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
      ...over,
    }) as unknown as SceneSpec;

  const evidence: FrameEvidenceReport = {
    schema: "frame-evidence/1",
    label: "r1",
    generatedAt: "2026-10-08T00:00:00.000Z",
    fps: 30,
    sourceRender: null,
    scenesHash: null,
    samples: [],
    sceneRollup: [
      {
        sceneId: "scene_01",
        sampleCount: 6,
        minOccupancy: 0.0436,
        maxEdgeInk: 0,
        maxSafeAreaOverflowPx: 28,
        contentOutsideFrame: false,
        motionDelta: 0.00246,
      },
    ],
  } as unknown as FrameEvidenceReport;

  it("emits one short line per scene with the key measurements", () => {
    const lines = compactEvidenceLines([scene({})], evidence, null, null);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^scene_01: /);
    expect(lines[0]).toMatch(/occ=4\.4%/);
    expect(lines[0]).toMatch(/edgeInk=0/);
    expect(lines[0]).toMatch(/safeOvf=28px/);
    expect(lines[0]).toMatch(/motion=0\.00246/);
  });

  it("stays compact: no JSON dumps, bounded length", () => {
    const scenes = Array.from({ length: 8 }, (_, i) => scene({ sceneId: `scene_0${i + 1}` }));
    const lines = compactEvidenceLines(scenes, evidence, layoutGate({}), visualGates({}));
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(260);
      expect(line).not.toMatch(/\{\s*"/); // no raw JSON in the prompt
    }
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it("includes layout flags and empty-scene status when the gates report them", () => {
    const gate = layoutGate({
      hard: ["scene_01: MODEL clipping - \"WordReveal[0](...)\" overflows the right frame edge by 38px after transform"],
      findings: [
        {
          sceneId: "scene_01",
          model: { frameViolations: [], safeAreaViolations: [], contentBox: null, contentBoxRounded: null, sources: [] },
          rendered: null,
          agreement: { frame: "model-only", safeArea: "neither" },
          hard: ["scene_01: MODEL clipping - \"WordReveal[0](...)\" overflows the right frame edge by 38px after transform"],
          warnings: [],
          summary: "hard=1",
        },
      ],
    });
    const gates = visualGates({
      scenes: [
        {
          sceneId: "scene_01",
          empty: {
            sceneId: "scene_01",
            status: "suspicious",
            reason: "thin content: 1 object expected in the middle band but occupancy is 0.200%",
            occupancy: 0.04,
            contentBBox: null,
            motionDelta: 0.001,
            regionOccupancy: null,
            bands: [],
          },
          readability: {
            sceneId: "scene_01",
            status: "ok",
            reasons: [],
            brightShare: 0.04,
            headlineHeightPx: 104,
            smallestTextHeightPx: 40,
            subtitleBandOccupancy: 0.05,
          },
        },
      ],
      hard: [],
      warnings: ["scene_01: thin content"],
      ok: true,
    });
    const lines = compactEvidenceLines([scene({})], evidence, gate, gates);
    expect(lines[0]).toMatch(/layout: MODEL clipping/);
    expect(lines[0]).toMatch(/disagree \(model-only\)/);
    expect(lines[0]).toMatch(/empty=suspicious/);
    expect(lines[0].length).toBeLessThanOrEqual(400);
  });
});

/* ---------------- Batch D: semantic enactment reaches aggregate QA ---------------- */

describe("semantic enactment in aggregate QA (Batch D / §18)", () => {
  it("a missing promised object FAILS QA even with perfect judge scores", () => {
    const enactment = evaluateSemanticEnactment([missingObjectScene()]);
    expect(enactment.ok).toBe(false);
    const qa = aggregateQa(technicalOk, visual, slop, novelty, undefined, undefined, { enactment });
    expect(qa.status).toBe("fail");
    expect(qa.reasons.join(" ")).toMatch(/semantic\/missing_semantic_object/);
    expect(qa.reasons.join(" ")).toMatch(/gate_01/);
  });

  it("a satisfied contract leaves QA untouched (deterministic evidence only fires on failure)", () => {
    const enactment = evaluateSemanticEnactment([passScene()]);
    expect(enactment.ok).toBe(true);
    const qa = aggregateQa(technicalOk, visual, slop, novelty, undefined, undefined, { enactment });
    expect(qa.status).toBe("pass");
    expect(qa.reasons.join(" ")).not.toMatch(/semantic\//);
  });
});
