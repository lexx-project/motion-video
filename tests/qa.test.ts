import { describe, it, expect } from "vitest";
import { aggregateQa } from "../src/agents/qa";
import { buildRepairPlan } from "../src/agents/repair";
import type { VisualQa, SlopQa } from "../src/agents/schemas";
import type { TechnicalQaResult } from "../src/render/renderProject";
import type { NoveltyReport } from "../src/agents/novelty";
import type { SceneSpec } from "../src/validation/schema";

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

const visualFixture = (over?: Partial<VisualQa["scenes"][number]>): VisualQa => ({
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
      ...(over ?? {}),
    },
  ],
});

const slopOk: SlopQa = { projectSeverity: 1, verdict: "acceptable", findings: [] };
const noveltyOk: NoveltyReport = { results: [], rejectedSceneIds: [], status: "pass" };

describe("QA scoring (MASTER_SPEC section 11)", () => {
  it("passes when everything is strong", () => {
    const qa = aggregateQa(technicalOk, visualFixture(), slopOk, noveltyOk);
    expect(qa.status).toBe("pass");
    expect(qa.overallQuality).toBeGreaterThanOrEqual(8);
    expect(qa.reasons).toEqual([]);
  });

  it("needs repair when overall quality drops below 8", () => {
    const visual = visualFixture();
    visual.scenes[0].scores = {
      scriptRelevance: 7,
      visualClarity: 7,
      designConsistency: 7,
      typography: 7,
      composition: 7,
      motionQuality: 7,
      novelty: 7,
      aiSlopSeverity: 1,
    };
    const qa = aggregateQa(technicalOk, visual, slopOk, noveltyOk);
    expect(qa.status).toBe("needs_repair");
    expect(qa.reasons.join(" ")).toMatch(/overall quality/i);
  });

  it("flags severe AI-slop per scene and project-wide", () => {
    const visual = visualFixture();
    visual.scenes[0].scores.aiSlopSeverity = 8;
    const slop: SlopQa = { projectSeverity: 7, verdict: "severe", findings: [] };
    const qa = aggregateQa(technicalOk, visual, slop, noveltyOk);
    expect(qa.status).not.toBe("pass");
    expect(qa.reasons.join(" ")).toMatch(/slop/);
  });

  it("fails on technical correctness errors", () => {
    const bad: TechnicalQaResult = { ...technicalOk, errors: ["dimensions 720x1280 != 1080x1920"] };
    const qa = aggregateQa(bad, visualFixture(), slopOk, noveltyOk);
    expect(qa.status).toBe("fail");
    expect(qa.reasons.join(" ")).toMatch(/technical/);
  });

  it("reports missing audio as a repairable reason, not a hard fail", () => {
    const silent: TechnicalQaResult = { ...technicalOk, hasAudio: false, errors: ["no VO audio provided (silent render)"] };
    const qa = aggregateQa(silent, visualFixture(), slopOk, noveltyOk);
    expect(qa.status).toBe("needs_repair");
    expect(qa.reasons.join(" ")).toMatch(/no VO audio/);
  });

  it("includes novelty rejects in reasons", () => {
    const novelty: NoveltyReport = {
      results: [],
      rejectedSceneIds: ["scene_01"],
      status: "needs_repair",
    };
    const qa = aggregateQa(technicalOk, visualFixture(), slopOk, novelty);
    expect(qa.reasons.join(" ")).toMatch(/novelty/);
  });
});

describe("repair planning", () => {
  const scenes = [
    {
      sceneId: "scene_01",
      duration: 3,
      purpose: "open strong",
      visualConcept: "x",
      composition: "centered",
      elements: [{ primitive: "Circle", position: "center" }],
      motion: { entrance: "fade", emphasis: "glow", exit: "fade" },
    },
  ] as unknown as SceneSpec[];

  it("only plans scenes with actual findings", () => {
    const qa = aggregateQa(technicalOk, visualFixture(), slopOk, noveltyOk);
    void qa;
    const visual = visualFixture();
    visual.scenes[0].scores.typography = 3;
    visual.scenes[0].issues = ["headline overlaps the object"];
    visual.scenes[0].recommendedRepair = ["shorten headline"];
    const plan = buildRepairPlan(scenes, visual, slopOk, noveltyOk);
    expect(plan).toHaveLength(1);
    expect(plan[0].sceneId).toBe("scene_01");
    expect(plan[0].reason).toMatch(/headline overlaps/);
  });

  it("plans nothing when all scenes pass", () => {
    const plan = buildRepairPlan(scenes, visualFixture(), slopOk, noveltyOk);
    expect(plan).toEqual([]);
  });

  it("adds slop findings above severity 5", () => {
    const slop: SlopQa = {
      projectSeverity: 6,
      verdict: "needs_repair",
      findings: [
        { sceneId: "scene_01", type: "unnecessary-glow", evidence: "three glow layers", severity: 7 },
        { sceneId: "scene_01", type: "repetitive-layouts", evidence: "same layout as earlier", severity: 2 },
      ],
    };
    const plan = buildRepairPlan(scenes, visualFixture(), slop, noveltyOk);
    expect(plan).toHaveLength(1);
    expect(plan[0].reason).toMatch(/unnecessary-glow/);
    expect(plan[0].reason).not.toMatch(/repetitive-layouts/);
  });
});
