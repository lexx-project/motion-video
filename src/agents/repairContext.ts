import type { LayoutGateReport } from "../validation/layoutGate";
import type { VisualGateReport } from "../validation/visualGates";
import type { CollisionReport } from "../validation/collisionSemantics";
import type { PreRenderIssue } from "../validation/preRenderGate";
import type { SemanticEnactmentReport } from "../validation/semanticEnactment";
import { LAYOUT_GATES } from "../validation/layoutGate";
import { VISUAL_GATES } from "../validation/visualGates";
import { HARD_COLLISION_RATIO } from "../validation/collisionSemantics";
import type { SceneSpec } from "../validation/schema";

/**
 * Formal repair context + deterministic failure classification (Batch C / §4, §5,
 * extended by Batch D / §21).
 *
 * The classifier runs BEFORE any LLM call. Its output is the only thing the repair prompt
 * receives - never the whole project. Priority follows the brief:
 *
 *   1 hard deterministic layout failure
 *   2 hard deterministic visual-gate failure
 *   3 hard collision failure
 *   4 timing failure
 *   5 semantic enactment failure (Batch D: objects / events / timing / state / relationships)
 *   6 LLM judge failure
 *   7 aesthetic/slop warning
 *
 * Evidence strings are measurements only ("model overflow 38px", "promised 3.60s, detected
 * 1.42s"), never opinions - the deterministic system decides whether a repair worked.
 */

export type FailureType =
  | "layout_clip"
  | "safe_area_overflow"
  | "empty_visual_band"
  | "unreadable_text"
  | "unintended_collision"
  | "timing_issue"
  // Batch D: deterministic semantic enactment failures
  | "missing_semantic_object"
  // Batch E: obvious primitive/category mismatch (Phase 3)
  | "category_mismatch"
  | "missing_event"
  | "event_not_executed"
  | "event_timing_mismatch"
  | "state_transition_failed"
  | "relationship_failed"
  | "unsupported_event"
  | "novelty_fixture"
  | "judge_issue"
  | "unknown";

export type FailureSource =
  | "deterministic-layout"
  | "deterministic-visual"
  | "deterministic-collision"
  | "deterministic-timing"
  | "deterministic-semantic"
  | "novelty"
  | "judge"
  | "slop";

export type FailureSeverity = "hard" | "warning";

export interface RepairFailure {
  type: FailureType;
  severity: FailureSeverity;
  source: FailureSource;
  sceneId: string;
  /** prompt-ready one-liner built from measurements */
  evidence: string;
  /** renderer item id (`WordReveal[0]("YES...")`), semantic id or event id */
  target?: string[];
  /** affected side/band, e.g. "right", "middle" */
  region?: string[];
  /** magnitude of the defect in its own unit (px / occupancy / ratio / seconds) - higher is worse */
  magnitude?: number;
}

/** Failure types produced by the semantic enactment gate (Batch D + Batch E). */
export const SEMANTIC_FAILURE_TYPES: FailureType[] = [
  "missing_semantic_object",
  "category_mismatch",
  "missing_event",
  "event_not_executed",
  "event_timing_mismatch",
  "state_transition_failed",
  "relationship_failed",
  "unsupported_event",
];

export const isSemanticFailure = (t: FailureType): boolean => SEMANTIC_FAILURE_TYPES.includes(t);

/** Priority order (lower index = repaired first) - documented in BATCH_D_FINAL_REPORT.md. */
export const FAILURE_PRIORITY: FailureType[] = [
  "layout_clip",
  "safe_area_overflow",
  "empty_visual_band",
  "unreadable_text",
  "unintended_collision",
  "timing_issue",
  "missing_semantic_object",
  "category_mismatch",
  "missing_event",
  "event_not_executed",
  "event_timing_mismatch",
  "state_transition_failed",
  "relationship_failed",
  "unsupported_event",
  "novelty_fixture",
  "judge_issue",
  "unknown",
];

const priorityOf = (t: FailureType): number => {
  const i = FAILURE_PRIORITY.indexOf(t);
  return i === -1 ? FAILURE_PRIORITY.length : i;
};

export interface ClassifyInput {
  scenes: SceneSpec[];
  layoutGate?: LayoutGateReport | null;
  visualGates?: VisualGateReport | null;
  /** model-only issues found before the first render (Batch C pre-render gate) */
  preRenderIssues?: PreRenderIssue[] | null;
  /** per-scene collision report (Batch C collision semantics) */
  collisions?: Record<string, CollisionReport> | null;
  /** Batch D: deterministic semantic enactment gate (state-based, no render required) */
  semantic?: SemanticEnactmentReport | null;
  timingIssues?: { sceneId?: string; evidence: string }[] | null;
  judgeIssues?: { sceneId: string; evidence: string }[] | null;
  slopFindings?: { sceneId: string; type: string; evidence: string; severity: number }[] | null;
}

const sourceOf = (t: FailureType): FailureSource =>
  t === "empty_visual_band" || t === "unreadable_text"
    ? "deterministic-visual"
    : t === "unintended_collision"
      ? "deterministic-collision"
      : t === "layout_clip" || t === "safe_area_overflow"
        ? "deterministic-layout"
        : t === "timing_issue"
          ? "deterministic-timing"
          : isSemanticFailure(t)
            ? "deterministic-semantic"
            : "judge";

/** Deterministic classification of everything that could need repair. */
export function classifyFailures(input: ClassifyInput): RepairFailure[] {
  const out: RepairFailure[] = [];
  const known = new Set(input.scenes.map((s) => s.sceneId));
  const only = (sceneId: string): boolean => known.has(sceneId);

  // 0. pre-render gate issues (model-only, available before the first render)
  for (const i of input.preRenderIssues ?? []) {
    out.push({
      type: i.failureType,
      severity: i.severity,
      source: sourceOf(i.failureType),
      sceneId: i.sceneId,
      evidence: i.evidence,
      target: i.target,
      region: i.region,
      magnitude: i.magnitude,
    });
  }

  // 1. hard deterministic layout failure
  for (const f of input.layoutGate?.findings ?? []) {
    const frame = f.model.frameViolations.filter((v) => v.px >= LAYOUT_GATES.modelFrameClipPx);
    if (frame.length) {
      const worst = frame.reduce((a, b) => (b.px > a.px ? b : a));
      out.push({
        type: "layout_clip",
        severity: "hard",
        source: "deterministic-layout",
        sceneId: f.sceneId,
        evidence:
          `model overflow ${worst.px}px past the ${worst.side} frame edge after transform` +
          (f.rendered ? `; pixel edge ink ${Math.max(f.rendered.edgeInk.left, f.rendered.edgeInk.right, f.rendered.edgeInk.top, f.rendered.edgeInk.bottom)}px; agreement=${f.agreement.frame}` : "; no pixel evidence yet"),
        target: [worst.id],
        region: [worst.side],
        magnitude: worst.px,
      });
    }
    if (f.rendered?.contentOutsideFrame) {
      const e = f.rendered.edgeInk;
      const side = (["left", "right", "top", "bottom"] as const).reduce((a, b) => (e[b] > e[a] ? b : a), "left");
      const already = out.some((o) => o.sceneId === f.sceneId && o.type === "layout_clip");
      if (!already || e[side] > 0) {
        out.push({
          type: "layout_clip",
          severity: "hard",
          source: "deterministic-layout",
          sceneId: f.sceneId,
          evidence: `rendered content reaches the ${side} frame edge (${e[side]} ink px); agreement=${f.agreement.frame}`,
          region: [side],
          magnitude: e[side],
        });
      }
    }
    const modelSafe = f.model.safeAreaViolations.filter((v) => v.px >= LAYOUT_GATES.safeAreaSeverePx);
    const pixelSafe = f.rendered
      ? Math.max(...Object.values(f.rendered.safeAreaOverflowPx)) >= LAYOUT_GATES.safeAreaSeverePx
      : false;
    if (modelSafe.length || pixelSafe) {
      const worst = modelSafe.length ? modelSafe.reduce((a, b) => (b.px > a.px ? b : a)) : null;
      const px = worst ? worst.px : Math.max(...Object.values(f.rendered!.safeAreaOverflowPx));
      const side = worst ? worst.side : (["left", "right", "top", "bottom"] as const).reduce((a, b) => ((f.rendered!.safeAreaOverflowPx as Record<string, number>)[b] > (f.rendered!.safeAreaOverflowPx as Record<string, number>)[a] ? b : a), "left");
      out.push({
        type: "safe_area_overflow",
        severity: "hard",
        source: "deterministic-layout",
        sceneId: f.sceneId,
        evidence: `content crosses the ${side} safe margin by ${px}px (severe threshold ${LAYOUT_GATES.safeAreaSeverePx}px)${f.rendered ? `; pixel safe overflow ${Math.max(...Object.values(f.rendered.safeAreaOverflowPx))}px` : ""}`,
        target: worst ? [worst.id] : [],
        region: [side],
        magnitude: px,
      });
    }
  }

  // 2. hard deterministic visual-gate failure (needs pixel evidence)
  for (const s of input.visualGates?.scenes ?? []) {
    if (s.empty.status === "fail") {
      const band = s.empty.bands.find((b) => b.expectedBoxes >= VISUAL_GATES.minExpectedBoxesToFail && b.occupancy < VISUAL_GATES.bandOccupancyFloor);
      out.push({
        type: "empty_visual_band",
        severity: "hard",
        source: "deterministic-visual",
        sceneId: s.sceneId,
        evidence: s.empty.reason,
        region: band ? [band.band] : [],
        target: band ? [`${band.expectedBoxes} non-text objects`] : [],
        magnitude: s.empty.occupancy ?? 0,
      });
    }
    if (s.readability.status === "fail") {
      out.push({
        type: "unreadable_text",
        severity: "hard",
        source: "deterministic-visual",
        sceneId: s.sceneId,
        evidence: s.readability.reasons.join("; "),
        magnitude: s.readability.brightShare ?? 0,
      });
    }
  }

  // 3. collision failures (intentional overlaps are never failures)
  for (const [sceneId, report] of Object.entries(input.collisions ?? {})) {
    if (!only(sceneId)) continue;
    for (const c of report.unintended) {
      const hard = c.ratio >= HARD_COLLISION_RATIO;
      out.push({
        type: "unintended_collision",
        severity: hard ? "hard" : "warning",
        source: "deterministic-collision",
        sceneId,
        evidence: `${c.a} x ${c.b} overlap ${Math.round(c.ratio * 100)}% of the smaller box; ${c.reason}`,
        target: [c.a, c.b],
        region: [c.posA, c.posB],
        magnitude: c.ratio,
      });
    }
  }

  // 4. timing failures
  for (const t of input.timingIssues ?? []) {
    out.push({
      type: "timing_issue",
      severity: "hard",
      source: "deterministic-timing",
      sceneId: t.sceneId ?? input.scenes[0]?.sceneId ?? "unknown",
      evidence: t.evidence,
    });
  }

  // 4b. semantic enactment failures (Batch D / §18 - deterministic state evidence)
  for (const f of input.semantic?.failures ?? []) {
    if (!only(f.sceneId)) continue;
    out.push({
      type: f.type,
      severity: f.severity,
      source: f.source,
      sceneId: f.sceneId,
      evidence: f.evidence,
      target: f.target,
      magnitude: f.magnitude,
    });
  }

  // 5/6. judge + slop (never higher priority than deterministic evidence)
  for (const j of input.judgeIssues ?? []) {
    if (!only(j.sceneId)) continue;
    out.push({ type: "judge_issue", severity: "warning", source: "judge", sceneId: j.sceneId, evidence: j.evidence });
  }
  for (const f of input.slopFindings ?? []) {
    if (!only(f.sceneId)) continue;
    if (f.severity < 5) continue;
    out.push({
      type: "judge_issue",
      severity: "warning",
      source: "slop",
      sceneId: f.sceneId,
      evidence: `slop[${f.type}] ${f.severity}/10: ${f.evidence}`,
    });
  }

  return out.sort(
    (a, b) => priorityOf(a.type) - priorityOf(b.type) || a.sceneId.localeCompare(b.sceneId),
  );
}

/** Group failures per scene, highest-priority type first (one repair target per scene). */
export function primaryFailurePerScene(failures: RepairFailure[]): Map<string, RepairFailure> {
  const map = new Map<string, RepairFailure>();
  for (const f of failures) {
    const current = map.get(f.sceneId);
    if (!current || priorityOf(f.type) < priorityOf(current.type)) map.set(f.sceneId, f);
  }
  return map;
}

export interface RepairContext {
  round: number;
  attempt: number;
  maxAttempts: number;
  sceneId: string;
  failureType: FailureType;
  severity: FailureSeverity;
  source: FailureSource;
  /** measurements only - this is what the repair model is allowed to reason about */
  deterministicEvidence: string;
  affectedObjects: string[];
  affectedRegions: string[];
  /** narrow instruction derived from the failure type (never "make it better") */
  suggestedAction: string;
  baselineArtifactHash: string | null;
  baselineSnapshotId: string | null;
  allowedProperties: string[];
  preserve: string[];
}

const NARROW_ACTION: Record<FailureType, string> = {
  layout_clip:
    "Move and/or shrink ONLY the named object until its rendered box fits inside the frame and safe area. Do not change typography style, timing, scene meaning, other objects or other scenes.",
  safe_area_overflow:
    "Pull the named object back inside the safe margin using position/offset/scale only. Do not change any other property.",
  empty_visual_band:
    "Make the existing objects in the named band VISIBLE (size/thickness/position within that band). Do NOT add new objects, new text or decoration.",
  unreadable_text:
    "Raise the rendered size/opacity of the named text only. Do not change its wording, position or any other object.",
  unintended_collision:
    "Separate the two named items by moving one to another band or shrinking it. Do not delete either item and do not change their content.",
  timing_issue:
    "Adjust only the supported timing fields. Never move authoritative word timestamps and preserve the exact total duration.",
  // Batch D semantic repairs - narrow, contract-checked, storyboard promises are immutable
  missing_semantic_object:
    'Add ONLY the missing semantic object as one new element carrying semanticId="<id>" using an existing supported primitive. Preserve timing, typography, layout and every existing object.',
  category_mismatch:
    "Replace ONLY the named element's primitive with one whose category matches the promised object (keep semanticId, position band, scale and every other property). Do not touch the storyboard or other elements.",
  missing_event:
    'Restore ONLY the missing execution event (same event id, target and type the storyboard promises) in scene.executionPlan. Do not change any other event, element or the storyboard.',
  event_not_executed:
    "Give the named execution event concrete parameters so it visibly runs (destination/offsets/value). Do not change event timing, targets, other events or any unrelated object.",
  event_timing_mismatch:
    "Move ONLY the named event's atSeconds to the promised time (within the scene window). Do not change duration, other events or objects.",
  state_transition_failed:
    "Adjust ONLY the named event's target values (to/offsets) so the final state reaches the promised result. Keep the event time, target and all other state unchanged.",
  relationship_failed:
    "Fix ONLY the named relationship: correct the attachTo/destination reference or move the two named objects closer. Never delete the relationship or its endpoints.",
  unsupported_event:
    "Replace ONLY the named event's type with a semantically equivalent SUPPORTED type that performs the same visual action on the same target at the same time.",
  novelty_fixture:
  "Change the composition/objects of the named scene so it is no longer the same visual solution, keeping the beat meaning.",
  judge_issue:
    "Apply the single smallest change that addresses the cited judge issue. Keep concept, timing and all unrelated objects.",
  unknown:
    "Apply the smallest change that addresses the cited measurement. Keep everything else.",
};

export interface BuildRepairContextOptions {
  round: number;
  attempt: number;
  maxAttempts: number;
  failure: RepairFailure;
  allowedProperties: string[];
  preserve?: string[];
  baselineArtifactHash?: string | null;
  baselineSnapshotId?: string | null;
}

export function buildRepairContext(opts: BuildRepairContextOptions): RepairContext {
  const f = opts.failure;
  return {
    round: opts.round,
    attempt: opts.attempt,
    maxAttempts: opts.maxAttempts,
    sceneId: f.sceneId,
    failureType: f.type,
    severity: f.severity,
    source: f.source,
    deterministicEvidence: f.evidence,
    affectedObjects: f.target ?? [],
    affectedRegions: f.region ?? [],
    suggestedAction: NARROW_ACTION[f.type],
    baselineArtifactHash: opts.baselineArtifactHash ?? null,
    baselineSnapshotId: opts.baselineSnapshotId ?? null,
    allowedProperties: opts.allowedProperties,
    preserve: opts.preserve ?? DEFAULT_PRESERVE,
  };
}

/** What a narrow repair must never touch (Batch C §7 + Batch D §23). */
export const DEFAULT_PRESERVE = [
  "scene meaning / purpose / visualConcept",
  "duration and voice synchronization",
  "typography style and accent discipline",
  "motion family (entrance/emphasis/exit)",
  "elements not named in affectedObjects",
  "other scenes and project-wide design tokens",
  "storyboard promises (objects, beats, relationships)",
  "execution plan events (tune, never delete)",
];

/** Compact, prompt-ready context block (no project dump). */
export function repairContextBlock(ctx: RepairContext): string {
  return [
    `RepairContext: round=${ctx.round} attempt=${ctx.attempt}/${ctx.maxAttempts} scene=${ctx.sceneId}`,
    `failure=${ctx.failureType} severity=${ctx.severity} source=${ctx.source}`,
    `evidence: ${ctx.deterministicEvidence}`,
    ctx.affectedObjects.length ? `affected objects: ${ctx.affectedObjects.join(", ")}` : "",
    ctx.affectedRegions.length ? `affected regions: ${ctx.affectedRegions.join(", ")}` : "",
    `do this: ${ctx.suggestedAction}`,
    `allowed properties: ${ctx.allowedProperties.join(", ")}`,
    `preserve: ${ctx.preserve.join("; ")}`,
    ctx.baselineSnapshotId ? `baseline snapshot: ${ctx.baselineSnapshotId} (${(ctx.baselineArtifactHash ?? "").slice(0, 12)})` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
