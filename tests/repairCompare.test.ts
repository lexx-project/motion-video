import { describe, it, expect } from "vitest";
import {
  buildMetricVector,
  compareRepair,
  describeComparison,
  withTargetSeverity,
  type MetricVector,
} from "../src/agents/repairCompare";
import type { LayoutGateReport } from "../src/validation/layoutGate";
import type { SceneSpec } from "../src/validation/schema";

/** Batch C / §12: deterministic metric-vector comparison (no single-score decisions). */

const vector = (over: Partial<MetricVector> = {}): MetricVector => ({
  hardKeys: [],
  hardFailures: 0,
  targetSeverity: 0,
  safeAreaOverflowPx: 0,
  frameEdgeInk: null,
  layoutDisagreements: 0,
  visualGateFails: 0,
  unintendedCollisions: 0,
  timingViolations: 0,
  artifactConsistent: true,
  ...over,
});

describe("repair comparison rules", () => {
  it("KEEPS a repair that fixes the target without new hard failures", () => {
    const base = vector({ hardKeys: ["scene_03:layout_clip"], hardFailures: 1, targetSeverity: 419, frameEdgeInk: 419, safeAreaOverflowPx: 86 });
    const cand = vector({ hardKeys: [], hardFailures: 0, targetSeverity: 0, frameEdgeInk: 0, safeAreaOverflowPx: 0 });
    const r = compareRepair(base, cand);
    expect(r.action).toBe("KEEP");
    expect(r.reason).toMatch(/improved/);
    expect(r.deltas.targetSeverity).toBe(-419);
    expect(describeComparison(r)).toMatch(/decision: KEEP/);
  });

  it("ROLLS BACK when the target failure worsens", () => {
    const base = vector({ hardKeys: ["scene_03:layout_clip"], hardFailures: 1, targetSeverity: 419 });
    const cand = vector({ hardKeys: ["scene_03:layout_clip"], hardFailures: 1, targetSeverity: 500 });
    const r = compareRepair(base, cand);
    expect(r.action).toBe("ROLLBACK");
    expect(r.reason).toMatch(/target failure worsened \(419 -> 500\)/);
  });

  it("REJECTS a repair that changes nothing", () => {
    const base = vector({ hardKeys: ["scene_03:layout_clip"], hardFailures: 1, targetSeverity: 419 });
    const cand = vector({ hardKeys: ["scene_03:layout_clip"], hardFailures: 1, targetSeverity: 419 });
    const r = compareRepair(base, cand);
    expect(r.action).toBe("REJECT");
    expect(r.reason).toMatch(/unchanged/);
  });

  it("ROLLS BACK when the candidate introduces a NEW hard failure", () => {
    const base = vector({ hardKeys: ["scene_03:layout_clip"], hardFailures: 1, targetSeverity: 419, frameEdgeInk: 419 });
    const cand = vector({
      hardKeys: ["scene_03:safe_area_overflow"],
      hardFailures: 1,
      targetSeverity: 0,
      frameEdgeInk: 0,
      safeAreaOverflowPx: 120,
    });
    const r = compareRepair(base, cand);
    expect(r.action).toBe("ROLLBACK");
    expect(r.reason).toMatch(/new hard failure/);
    expect(r.reason).toMatch(/scene_03:safe_area_overflow/);
  });

  it("ROLLS BACK when hard failures increase even with the same keys", () => {
    const base = vector({ hardKeys: ["a:layout_clip"], hardFailures: 1, targetSeverity: 100 });
    const cand = vector({ hardKeys: ["a:layout_clip"], hardFailures: 2, targetSeverity: 50 });
    const r = compareRepair(base, cand);
    expect(r.action).toBe("ROLLBACK");
    expect(r.reason).toMatch(/hard failures increased 1 -> 2/);
  });

  it("ROLLS BACK when artifact identity is not consistent", () => {
    const r = compareRepair(vector({ targetSeverity: 419 }), vector({ targetSeverity: 0, artifactConsistent: false }));
    expect(r.action).toBe("ROLLBACK");
    expect(r.reason).toMatch(/artifact identity/);
  });

  it("ROLLS BACK when unrelated evidence regresses", () => {
    const base = vector({ targetSeverity: 419, unintendedCollisions: 0, timingViolations: 0 });
    const cand = vector({ targetSeverity: 0, unintendedCollisions: 3, timingViolations: 1 });
    const r = compareRepair(base, cand);
    expect(r.action).toBe("ROLLBACK");
    expect(r.reason).toMatch(/unrelated evidence regressed/);
    expect(r.reason).toMatch(/unintendedCollisions \+3/);
  });

  it("never credits metrics that were not measured on the candidate", () => {
    // candidate has no pixel evidence (pre-render measurement) - the missing field must not
    // count as an improvement over the baseline's 419 edge ink
    const base = vector({ targetSeverity: 38, frameEdgeInk: 419, safeAreaOverflowPx: 86 });
    const cand = vector({ targetSeverity: 0, frameEdgeInk: null, safeAreaOverflowPx: null as unknown as number });
    const r = compareRepair(base, cand);
    // frameEdgeInk/safeArea are excluded from BOTH sides -> no regression credit or penalty
    expect(r.action).toBe("KEEP");
    expect(r.deltas.frameEdgeInk).toBeNull();
  });

  it("emits a human-readable comparison line", () => {
    const r = compareRepair(vector({ hardFailures: 3, targetSeverity: 419, frameEdgeInk: 419 }), vector({ hardFailures: 0, targetSeverity: 0, frameEdgeInk: 0 }));
    expect(r.action).toBe("KEEP");
    expect(r.reason).toMatch(/target 419 -> 0/);
    expect(r.reason).toMatch(/hard 3 -> 0/);
    expect(describeComparison(r)).toMatch(/baseline: hard=3 targetOverflow=419 edgeInk=419/);
    expect(describeComparison(r)).toMatch(/candidate: hard=0 targetOverflow=0 edgeInk=0/);
  });
});

describe("metric vector construction", () => {
  const scene = { sceneId: "scene_01", duration: 3, purpose: "test purpose", visualConcept: "c", composition: "centered", elements: [], motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" } } as unknown as SceneSpec;

  const layoutGate: LayoutGateReport = {
    schema: "layout-gate/1",
    generatedAt: "2026-10-08T00:00:00.000Z",
    findings: [
      {
        sceneId: "scene_01",
        model: {
          frameViolations: [{ id: "WordReveal[0]", side: "right", px: 38 }],
          safeAreaViolations: [{ id: "WordReveal[0]", side: "right", px: 86 }],
          contentBox: null,
          contentBoxRounded: null,
          sources: [],
        },
        rendered: {
          available: true,
          edgeInk: { left: 0, right: 419, top: 0, bottom: 0 },
          contentOutsideFrame: true,
          safeAreaOverflowPx: { left: 0, top: 0, right: 86, bottom: 0 },
          contentBox: null,
        },
        agreement: { frame: "both", safeArea: "both" },
        hard: [],
        warnings: [],
        summary: "",
      },
    ],
    hard: [],
    warnings: [],
    ok: false,
    disagreements: 1,
  };

  it("derives hard keys, edge ink and safe area from the reports", () => {
    const v = buildMetricVector({ scenes: [scene], layoutGate });
    expect(v.hardKeys).toContain("scene_01:layout_clip");
    expect(v.hardKeys).toContain("scene_01:safe_area_overflow");
    expect(v.hardFailures).toBeGreaterThanOrEqual(2);
    expect(v.frameEdgeInk).toBe(419);
    expect(v.safeAreaOverflowPx).toBe(86);
    expect(v.layoutDisagreements).toBe(1);
    expect(v.artifactConsistent).toBe(true);
  });

  it("attaches the target failure severity", () => {
    const v = buildMetricVector({ scenes: [scene], layoutGate });
    const withTarget = withTargetSeverity(v, { type: "layout_clip", severity: "hard", source: "deterministic-layout", sceneId: "scene_01", evidence: "x", magnitude: 38 });
    expect(withTarget.targetSeverity).toBe(38);
    expect(withTarget.hardFailures).toBe(v.hardFailures);
  });

  it("counts pre-render hard failures when no full gate is available", () => {
    const v = buildMetricVector({
      scenes: [scene],
      preRenderHard: [{ sceneId: "scene_01", failureType: "layout_clip", magnitude: 38 }],
    });
    expect(v.hardKeys).toEqual(["scene_01:layout_clip"]);
    expect(v.hardFailures).toBe(1);
  });
});
