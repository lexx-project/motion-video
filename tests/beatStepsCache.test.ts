import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { loadBeatSteps, saveBeatSteps, normalizeStoryboard } from "../src/agents/storyboard";
import { projectDir, initProject } from "../src/core/projectStore";
import { assessSemanticCategory } from "../src/validation/semanticCategories";
import type { Analysis } from "../src/agents/schemas";
import type { StoryboardCandidates, StoryboardSelections } from "../src/validation/storyboardSchema";

/**
 * Batch F - storyboard stage: per-beat validated-step cache (latency) and the
 * objectType normalization root cause (live-run category storm).
 */

const analysis: Analysis = {
  summary: "small disciplines repeated in silence build loud results",
  themes: ["persistence"],
  emotions: ["resolve"],
  keyNouns: ["discipline", "result"],
  keyVerbs: ["build", "repeat"],
  abstractConcepts: ["persistence"],
  importantPhrases: ["build loud results"],
  emphasisCandidates: ["loud"],
  visualOpportunities: ["accumulation"],
};

const beat = { id: "b1", text: "small disciplines repeated", why: "core claim", emotion: "resolve" };

const candidates: StoryboardCandidates = {
  beatId: "b1",
  candidates: [
    {
      id: "c1",
      visualMechanism: "accumulation",
      concept: "drops wearing stone",
      compositionSketch: "stone left, drops right",
      objects: ["stone", "drop"],
      whyDifferent: "physical accumulation metaphor",
      strength: "shows persistence without narration",
      complexity: "medium",
    },
  ],
} as StoryboardCandidates;

const selection = {
  beatId: "b1",
  selectedCandidateId: "c1",
  rejected: false,
  scores: {} as never,
  selectionRationale: "best mechanism for persistence",
} as StoryboardSelections["selections"][number];

const PROJECT = "_batchf_beatsteps_test";

afterEach(() => {
  const dir = projectDir(PROJECT);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("per-beat validated-step cache (Batch F latency)", () => {
  it("round-trips a cached selection for the same inputs", () => {
    initProject(PROJECT, "script");
    saveBeatSteps(PROJECT, analysis, beat, null, candidates, selection);
    const loaded = loadBeatSteps(PROJECT, analysis, beat);
    expect(loaded.rounds).toHaveLength(1);
    expect(loaded.rounds[0].direction).toBeNull();
    expect(loaded.rounds[0].selection.selectedCandidateId).toBe("c1");
    expect(loaded.rounds[0].candidates.candidates[0].id).toBe("c1");
  });

  it("misses when the beat text changes (no stale reuse)", () => {
    initProject(PROJECT, "script");
    saveBeatSteps(PROJECT, analysis, beat, null, candidates, selection);
    const changed = loadBeatSteps(PROJECT, analysis, { ...beat, text: "different words entirely" });
    expect(changed.rounds).toEqual([]);
  });

  it("misses when the analysis summary changes (different script)", () => {
    initProject(PROJECT, "script");
    saveBeatSteps(PROJECT, analysis, beat, null, candidates, selection);
    const changed = loadBeatSteps(PROJECT, { ...analysis, summary: "another script altogether" }, beat);
    expect(changed.rounds).toEqual([]);
  });

  it("misses on an unknown beat id", () => {
    initProject(PROJECT, "script");
    saveBeatSteps(PROJECT, analysis, beat, null, candidates, selection);
    expect(loadBeatSteps(PROJECT, analysis, { ...beat, id: "b2" }).rounds).toEqual([]);
  });

  it("keeps rounds with distinct directions side by side", () => {
    initProject(PROJECT, "script");
    saveBeatSteps(PROJECT, analysis, beat, null, candidates, selection);
    saveBeatSteps(PROJECT, analysis, beat, "try a clock mechanism", candidates, selection);
    const loaded = loadBeatSteps(PROJECT, analysis, beat);
    expect(loaded.rounds).toHaveLength(2);
    expect(loaded.rounds.map((r) => r.direction)).toEqual([null, "try a clock mechanism"]);
  });

  it("replaces the round for the same direction instead of duplicating it", () => {
    initProject(PROJECT, "script");
    saveBeatSteps(PROJECT, analysis, beat, null, candidates, selection);
    saveBeatSteps(PROJECT, analysis, beat, null, candidates, selection);
    expect(loadBeatSteps(PROJECT, analysis, beat).rounds).toHaveLength(1);
  });

  it("survives a corrupt cache file as a clean miss", () => {
    initProject(PROJECT, "script");
    fs.writeFileSync(path.join(projectDir(PROJECT), "concepts", "beat-steps-b1.json"), "{ not json", "utf8");
    expect(loadBeatSteps(PROJECT, analysis, beat).rounds).toEqual([]);
  });
});

describe("storyboard objectType normalization (live-run root cause)", () => {
  it("defaults a missing objectType to the neutral 'object', never 'Actor'", () => {
    const normalized = normalizeStoryboard({
      beatId: "b1",
      semanticObjects: [{ semanticRole: "the hard resistance", relationship: "worn by drops", importance: 5 }],
    }) as { semanticObjects: { objectType: string }[] };
    expect(normalized.semanticObjects[0].objectType).toBe("object");
  });

  it("a neutral objectType maps to NO category -> honest not_verified, not a false person fail", () => {
    const assessment = assessSemanticCategory({
      objectType: "object",
      semanticRole: "the hard, unmoving resistance the disciplines must outlast",
      primitive: "GenericCard",
    });
    expect(assessment.status).toBe("not_verified");
    expect(assessment.promisedCategory).toBeNull();
  });

  it("a real person promise still fails against a non-person primitive (gate not weakened)", () => {
    const assessment = assessSemanticCategory({
      objectType: "person",
      semanticRole: "the one who waits",
      primitive: "Line",
    });
    expect(assessment.status).toBe("fail");
  });

  it("an explicit model objectType is preserved verbatim", () => {
    const normalized = normalizeStoryboard({
      beatId: "b1",
      semanticObjects: [
        { objectType: "stone slab", semanticRole: "resistance", relationship: "worn", importance: 4 },
      ],
    }) as { semanticObjects: { objectType: string }[] };
    expect(normalized.semanticObjects[0].objectType).toBe("stone slab");
  });
});
