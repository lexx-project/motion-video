import type { LayoutGateReport } from "../validation/layoutGate";
import type { VisualGateReport } from "../validation/visualGates";
import type { CollisionReport } from "../validation/collisionSemantics";
import type { SemanticEnactmentReport } from "../validation/semanticEnactment";
import type { FailureType, RepairFailure } from "./repairContext";
import { classifyFailures } from "./repairContext";
import type { SceneSpec } from "../validation/schema";

/**
 * Deterministic repair comparison (Batch C / §12).
 *
 * A repair is never judged by a single score. Both versions are reduced to the same metric
 * vector and compared with explicit rules:
 *
 *   ROLLBACK - candidate introduces a hard failure, invalidates artifact identity,
 *              or materially regresses unrelated evidence
 *   REJECT   - target failure did not measurably improve (nothing changed)
 *   KEEP     - target improved, no new hard failure, no material regression
 *
 * Fields missing on one side (e.g. pixel metrics before a render) are excluded from BOTH sides,
 * so a pre-render candidate can never "win" by having no pixels.
 */

export interface MetricVector {
  /** unique `${sceneId}:${failureType}` keys of every hard failure */
  hardKeys: string[];
  hardFailures: number;
  /** severity of the failure being repaired (px / occupancy / ratio) - higher is worse */
  targetSeverity: number;
  safeAreaOverflowPx: number;
  frameEdgeInk: number | null;
  layoutDisagreements: number;
  visualGateFails: number;
  unintendedCollisions: number;
  timingViolations: number;
  artifactConsistent: boolean;
}

export interface MetricSources {
  scenes?: SceneSpec[];
  layoutGate?: LayoutGateReport | null;
  visualGates?: VisualGateReport | null;
  collisions?: Record<string, CollisionReport> | null;
  /** Batch D: semantic enactment evidence (state-based) - joins the metric vector */
  semantic?: SemanticEnactmentReport | null;
  preRenderHard?: { sceneId: string; failureType: FailureType; magnitude?: number }[] | null;
  frameEdgeInk?: number | null;
  timingViolations?: number;
  artifactConsistent?: boolean;
}

const hardKey = (sceneId: string, type: FailureType): string => `${sceneId}:${type}`;

export function buildMetricVector(sources: MetricSources): MetricVector {
  const scenes = sources.scenes ?? [];
  const failures = classifyFailures({
    scenes,
    layoutGate: sources.layoutGate ?? null,
    visualGates: sources.visualGates ?? null,
    collisions: sources.collisions ?? null,
    semantic: sources.semantic ?? null,
  });
  // pre-render-only sources (no full gate reports) contribute their own hard list
  for (const h of sources.preRenderHard ?? []) {
    if (!failures.some((f) => f.sceneId === h.sceneId && f.type === h.failureType && f.severity === "hard")) {
      failures.push({
        type: h.failureType,
        severity: "hard",
        source: "deterministic-layout",
        sceneId: h.sceneId,
        evidence: "pre-render hard failure",
        magnitude: h.magnitude,
      });
    }
  }

  const hard = failures.filter((f) => f.severity === "hard");
  let safeArea = 0;
  let frameInk: number | null = sources.frameEdgeInk ?? null;
  for (const f of sources.layoutGate?.findings ?? []) {
    const modelSafe = f.model.safeAreaViolations.reduce((m, v) => Math.max(m, v.px), 0);
    const pixelSafe = f.rendered
      ? Math.max(f.rendered.safeAreaOverflowPx.left, f.rendered.safeAreaOverflowPx.top, f.rendered.safeAreaOverflowPx.right, f.rendered.safeAreaOverflowPx.bottom)
      : 0;
    safeArea = Math.max(safeArea, modelSafe, pixelSafe);
    if (f.rendered) {
      const ink = Math.max(f.rendered.edgeInk.left, f.rendered.edgeInk.top, f.rendered.edgeInk.right, f.rendered.edgeInk.bottom);
      frameInk = Math.max(frameInk ?? 0, ink);
    }
  }

  return {
    hardKeys: hard.map((f) => hardKey(f.sceneId, f.type)).sort(),
    hardFailures: hard.length,
    targetSeverity: 0,
    safeAreaOverflowPx: safeArea,
    frameEdgeInk: frameInk,
    layoutDisagreements: sources.layoutGate?.disagreements ?? 0,
    visualGateFails: sources.visualGates?.hard.length ?? 0,
    unintendedCollisions: Object.values(sources.collisions ?? {}).reduce((n, r) => n + r.unintended.length, 0),
    timingViolations: sources.timingViolations ?? 0,
    artifactConsistent: sources.artifactConsistent ?? true,
  };
}

/** Attach the severity of the failure this repair targets (so the compare can require improvement). */
export function withTargetSeverity(vector: MetricVector, failure: RepairFailure | null | undefined): MetricVector {
  if (!failure || typeof failure.magnitude !== "number") return vector;
  return { ...vector, targetSeverity: failure.magnitude };
}

export type RepairAction = "KEEP" | "ROLLBACK" | "REJECT";

export interface RepairComparison {
  action: RepairAction;
  reason: string;
  baseline: MetricVector;
  candidate: MetricVector;
  deltas: Record<string, number | null>;
}

/** Fields compared only when BOTH sides measured them (never credit missing pixels). */
const COMPARED_NUMERIC: (keyof MetricVector)[] = [
  "safeAreaOverflowPx",
  "frameEdgeInk",
  "layoutDisagreements",
  "visualGateFails",
  "unintendedCollisions",
  "timingViolations",
];

const REGRESSION_EPSILON = 1e-9;

/**
 * Deterministic KEEP/ROLLBACK decision. Rules are ordered and each reason is explicit so a
 * human can answer "why did the agent keep/rollback this scene" from the ledger alone.
 */
export function compareRepair(
  baseline: MetricVector,
  candidate: MetricVector,
  opts: { targetKey?: string } = {},
): RepairComparison {
  const deltas: Record<string, number | null> = {};
  for (const key of [...COMPARED_NUMERIC, "hardFailures", "targetSeverity"] as (keyof MetricVector)[]) {
    const b = baseline[key];
    const c = candidate[key];
    deltas[key as string] = typeof b === "number" && typeof c === "number" ? Number((c - b).toFixed(4)) : null;
  }

  // 1. artifact identity must hold
  if (!candidate.artifactConsistent) {
    return { action: "ROLLBACK", reason: "candidate artifact identity is not consistent", baseline, candidate, deltas };
  }

  // 2. no new hard failure of any kind
  const newHard = candidate.hardKeys.filter((k) => !baseline.hardKeys.includes(k));
  if (newHard.length > 0) {
    return {
      action: "ROLLBACK",
      reason: `candidate introduces new hard failure(s): ${newHard.join(", ")}`,
      baseline,
      candidate,
      deltas,
    };
  }
  if (candidate.hardFailures > baseline.hardFailures) {
    return {
      action: "ROLLBACK",
      reason: `hard failures increased ${baseline.hardFailures} -> ${candidate.hardFailures}`,
      baseline,
      candidate,
      deltas,
    };
  }

  // 3. the target failure must measurably improve (unless no target severity was measured)
  if (baseline.targetSeverity > 0) {
    if (candidate.targetSeverity > baseline.targetSeverity + REGRESSION_EPSILON) {
      return {
        action: "ROLLBACK",
        reason: `target failure worsened (${baseline.targetSeverity} -> ${candidate.targetSeverity})`,
        baseline,
        candidate,
        deltas,
      };
    }
    if (candidate.targetSeverity >= baseline.targetSeverity - REGRESSION_EPSILON) {
      return {
        action: "REJECT",
        reason: `target failure unchanged (${baseline.targetSeverity} -> ${candidate.targetSeverity})`,
        baseline,
        candidate,
        deltas,
      };
    }
  }

  // 4. unrelated evidence must not materially regress
  const comparable = COMPARED_NUMERIC.filter(
    (k) => typeof baseline[k] === "number" && typeof candidate[k] === "number",
  );
  const sum = (v: MetricVector): number =>
    comparable.reduce((n, k) => n + (v[k] as number), 0);
  const baseSum = sum(baseline);
  const candSum = sum(candidate);
  if (candSum > baseSum + REGRESSION_EPSILON) {
    const worst = comparable
      .map((k) => ({ k, d: (candidate[k] as number) - (baseline[k] as number) }))
      .filter((x) => x.d > 0)
      .sort((a, b) => b.d - a.d)
      .map((x) => `${x.k} +${x.d}`)
      .join(", ");
    return {
      action: "ROLLBACK",
      reason: `unrelated evidence regressed: ${worst} (sum ${baseSum} -> ${candSum})`,
      baseline,
      candidate,
      deltas,
    };
  }

  const improvement = baseline.targetSeverity > 0 ? `target ${baseline.targetSeverity} -> ${candidate.targetSeverity}` : "no target severity measured";
  return { action: "KEEP", reason: `improved: ${improvement}; hard ${baseline.hardFailures} -> ${candidate.hardFailures}`, baseline, candidate, deltas };
}

/** One-line summary for logs / diagnostics (mirrors the brief's example). */
export const describeComparison = (r: RepairComparison): string =>
  `baseline: hard=${r.baseline.hardFailures} targetOverflow=${r.baseline.targetSeverity} edgeInk=${r.baseline.frameEdgeInk ?? "-"} | ` +
  `candidate: hard=${r.candidate.hardFailures} targetOverflow=${r.candidate.targetSeverity} edgeInk=${r.candidate.frameEdgeInk ?? "-"} | ` +
  `decision: ${r.action} (${r.reason})`;
