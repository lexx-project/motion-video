import { z } from "zod";
import {
  resolveExecutionPlan,
  promisedEventSchedule,
  isSupportedEventType,
  SUPPORTED_EVENT_LIST_TEXT,
  type PromisedEventSchedule,
} from "./executionPlan";
import { SUPPORTED_MOTION_EVENT_TYPES, RELATIONSHIP_TYPES, type RelationshipType } from "./storyboardSchema";
import { assessSemanticCategory, type CategoryStatus } from "./semanticCategories";
import {
  stateForSemanticId,
  snapshotOf,
  elementStateAt,
  type ElementState,
  type StateSnapshot,
} from "../scenes/state";
import { elementBySemanticId, maxMoveTravelPx } from "../scenes/execution";
import { requiredSemanticIds } from "./semanticContract";
import { scenesFingerprint } from "../core/identity";
import type { SceneSpec } from "./schema";
import type { PlanEvent } from "./executionPlan";

/**
 * SEMANTIC ENACTMENT GATE (Batch D / §18-§21).
 *
 * Answers, deterministically and without a single pixel of computer vision:
 *
 *   1. OBJECT EXISTENCE    - does every promised semantic object exist (semanticId)?
 *   2. EVENT EXISTENCE     - is every promised event in the execution plan?
 *   3. EVENT TIMING        - does the state transition happen near the promised time?
 *   4. STATE TRANSITION    - did the expected state actually change (and to what)?
 *   5. RELATIONSHIP        - do the declared relationships hold?
 *   6. FINAL STATE         - does the post-event state match the promise?
 *
 * Evidence is sampled ONLY around event windows (pre / at / post) from the pure state
 * extractor (src/scenes/state.ts) - no frame rendering, no LLM, no thresholds hidden in code:
 * every number lives in ENACTMENT below and is documented in BATCH_D_FINAL_REPORT.md.
 *
 * The contract is ALWAYS the baseline storyboard's promises (§25): a candidate scene cannot
 * rewrite the requirements it is judged against.
 */

/** Explicit, documented gate thresholds (§19, §39 - never tuned to make a test pass). */
export const ENACTMENT = {
  /** |detected - promised| <= this passes (seconds) */
  timingToleranceSec: 0.3,
  /** pre/post evidence sampling offset around the promised time (seconds) */
  eventWindowSec: 0.25,
  /** state-change scan resolution for detectedAt (1/60s = one half-frame at 30fps) */
  scanStepSec: 1 / 60,
  // --- "did it execute at all?" deltas (initial vs post-state) ---
  opacityExec: 0.6,
  revealExec: 0.6,
  moveExecPx: 150,
  scaleExec: 0.15,
  /** Batch G (WS-C): scale delta as a FRACTION of the element's own scale, so a correct
   * small-element change is not rejected by a full-size-calibrated absolute bar. The
   * effective threshold is min(scaleExec, max(scaleExecRel*scale, scaleExecMin)) - it can
   * only ever be MORE permissive than the documented absolute bar, never stricter. */
  scaleExecRel: 0.2,
  scaleExecMin: 0.04,
  rotateExecDeg: 25,
  progressExec: 0.15,
  flagExec: 0.5,
  // --- "settled at the post-state" bands used to locate detectedAt ---
  opacitySettle: 0.05,
  revealSettle: 0.05,
  moveSettlePx: 24,
  scaleSettle: 0.04,
  rotateSettleDeg: 5,
  progressSettle: 0.05,
  flagSettle: 0.5,
  // --- final-state tolerance (promise vs rendered state) ---
  opacityFinalTol: 0.12,
  scaleFinalTol: 0.12,
  progressFinalTol: 0.12,
  rotateFinalTolDeg: 15,
  moveFinalPx: 60,
  // --- relationship geometry (anchor-point model) ---
  approachPx: 80,
  nearPx: 640,
} as const;

export type EnactmentFailureType =
  | "missing_semantic_object"
  | "category_mismatch"
  | "missing_event"
  | "event_not_executed"
  | "event_timing_mismatch"
  | "state_transition_failed"
  | "relationship_failed"
  | "unsupported_event";

export const ENACTMENT_FAILURE_TYPES: readonly EnactmentFailureType[] = [
  "missing_semantic_object",
  "category_mismatch",
  "missing_event",
  "event_not_executed",
  "event_timing_mismatch",
  "state_transition_failed",
  "relationship_failed",
  "unsupported_event",
];

/** One category verdict per promised semantic object (Batch E / Phase 3). */
export interface ObjectCategoryCheck {
  id: string;
  objectType: string;
  primitive: string | null;
  status: CategoryStatus;
  reason: string;
}

export interface EnactmentFailure {
  type: EnactmentFailureType;
  severity: "hard";
  source: "deterministic-semantic";
  sceneId: string;
  /** measurements only - this string is what the repair model sees */
  evidence: string;
  target?: string[];
  /** magnitude in the failure's own unit (seconds for timing, count/delta otherwise) */
  magnitude?: number;
}

export type EventStatus =
  | "pass"
  | "missing_event"
  | "unsupported_event"
  | "missing_semantic_object"
  | "event_not_executed"
  | "event_timing_mismatch"
  | "state_transition_failed";

export interface EventEvidence {
  eventId: string;
  sceneId: string;
  target: string;
  type: string;
  action: string;
  promisedAt: number;
  /** time the execution plan actually carries (null = event absent from the plan) */
  planAt: number | null;
  /** first time the state reaches the post-state (deterministic scan; null = never) */
  detectedAt: number | null;
  timingDeltaSec: number | null;
  window: { pre: number; at: number; post: number };
  status: EventStatus;
  expected: string;
  before: StateSnapshot | null;
  at: StateSnapshot | null;
  after: StateSnapshot | null;
  detected: boolean;
  /** 1 = verdict from measured state, 0 = no measurement possible (never fabricated) */
  confidence: number;
  evidence: string;
}

export interface RelationshipEvidence {
  sceneId: string;
  from: string;
  to: string;
  type: RelationshipType;
  declared: string;
  status: "pass" | "relationship_failed";
  /** true when the failure is already covered by an object/event failure (no duplicate row) */
  suppressed: boolean;
  distanceBeforePx: number | null;
  distanceAfterPx: number | null;
  evidence: string;
}

export interface SceneEnactment {
  sceneId: string;
  /** false = storyboard carries no executable promises (legacy scenes stay untouched) */
  contractActive: boolean;
  objects: { promised: string[]; present: string[]; missing: string[] };
  /** Batch E: per-object category verdict (pass / fail / not_verified / unsupported_representation) */
  categories: ObjectCategoryCheck[];
  events: EventEvidence[];
  relationships: RelationshipEvidence[];
  failures: EnactmentFailure[];
  /** compact judge-ready line, e.g. `events=3/4 missing=gate_01 executed=2/3 relationships=2/2` */
  summary: string;
}

export interface SemanticEnactmentReport {
  schema: "semantic-enactment/1";
  scenesHash: string;
  toleranceSec: number;
  ok: boolean;
  scenes: SceneEnactment[];
  failures: EnactmentFailure[];
  /** one compact line per scene for LLM judges (§26) - images stay the primary evidence */
  compact: string[];
}

/* --------------------------------- helpers ---------------------------------- */

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

type Channel =
  | { kind: "scalar"; v: number }
  | { kind: "vec"; x: number; y: number }
  | { kind: "flag"; on: boolean };

const channelDist = (a: Channel | null, b: Channel | null): number => {
  if (!a || !b || a.kind !== b.kind) return 0;
  if (a.kind === "scalar" && b.kind === "scalar") return Math.abs(a.v - b.v);
  if (a.kind === "vec" && b.kind === "vec") return Math.hypot(a.x - b.x, a.y - b.y);
  if (a.kind === "flag" && b.kind === "flag") return a.on === b.on ? 0 : 1;
  return 0;
};

/**
 * Execution-delta threshold per event type. Batch G (WS-C): the move threshold is
 * distance-aware — when the destination is geometrically closer than the standard
 * `moveExecPx`, requiring the full 150px is impossible by construction (the move stops
 * short of the destination), which produced guaranteed false `event_not_executed`
 * failures on close pairs in the live runs. The threshold becomes
 * `min(moveExecPx, maxAchievableTravel)`; far moves keep the full 150px standard, and
 * a zero-delta (non-executed) move can never pass.
 */
const execThresholdFor = (type: string, scene?: SceneSpec, ev?: PlanEvent): number => {
  if (type === "move" && scene && ev) {
    const maxTravel = maxMoveTravelPx(scene, ev);
    // require 90% of the achievable travel, capped at the standard bar: a full-effort
    // move always clears it with margin, while far moves keep the moveExecPx standard.
    if (maxTravel !== null) return Math.min(ENACTMENT.moveExecPx, maxTravel * 0.9);
  }
  return type === "move"
    ? ENACTMENT.moveExecPx
    : type === "scale"
      ? ENACTMENT.scaleExec
      : type === "rotate"
        ? ENACTMENT.rotateExecDeg
        : type === "progress"
          ? ENACTMENT.progressExec
          : type === "reveal"
            ? ENACTMENT.revealExec
            : type === "attach" || type === "detach"
              ? ENACTMENT.flagExec
              : ENACTMENT.opacityExec;
};

const settleFor = (type: string): number =>
  type === "move"
    ? ENACTMENT.moveSettlePx
    : type === "scale"
      ? ENACTMENT.scaleSettle
      : type === "rotate"
        ? ENACTMENT.rotateSettleDeg
        : type === "progress"
          ? ENACTMENT.progressSettle
          : type === "reveal"
            ? ENACTMENT.revealSettle
            : type === "attach" || type === "detach"
              ? ENACTMENT.flagSettle
              : ENACTMENT.opacitySettle;

/** The channel a promised event controls, measured from the pure state extractor. */
function channelAt(scene: SceneSpec, p: PromisedEventSchedule, t: number): Channel | null {
  const state = stateForSemanticId(scene, p.target ?? "", t);
  if (!state) return null;
  switch (p.type) {
    case "enter":
    case "exit":
    case "fade":
    case "replace":
      return { kind: "scalar", v: state.opacity };
    case "reveal":
      return { kind: "scalar", v: state.reveal };
    case "move":
      return { kind: "vec", x: state.x, y: state.y };
    case "scale":
      return { kind: "scalar", v: state.scale };
    case "rotate":
      return { kind: "scalar", v: state.rotation };
    case "progress":
      return { kind: "scalar", v: state.progress ?? 0 };
    case "attach":
      return { kind: "flag", on: p.expected?.parent != null && state.attachedTo === p.expected.parent };
    case "detach":
      return { kind: "flag", on: state.attachedTo === null };
    default:
      return null;
  }
}

const fmtChannel = (type: string, c: Channel | null): string => {
  if (!c) return "n/a";
  if (c.kind === "vec") return `(${Math.round(c.x)},${Math.round(c.y)})`;
  if (c.kind === "flag") return c.on ? "on" : "off";
  return type === "move" ? String(Math.round(c.v)) : c.v.toFixed(2);
};

const deltaUnit = (type: string): string =>
  type === "move" ? "px" : type === "rotate" ? "deg" : "";

/** Expected post-state description (also drives the final-state check). */
function goalFor(p: PromisedEventSchedule): { text: string; check: "none" } | {
  text: string;
  check: "opacity" | "reveal" | "scale" | "rotate" | "progress" | "approach" | "offset";
  value: number;
} {
  const to = p.expected?.to;
  switch (p.type) {
    case "enter":
      return { text: "opacity -> 1 (visible)", check: "opacity", value: 1 };
    case "exit":
      return { text: "opacity -> 0 (hidden)", check: "opacity", value: 0 };
    case "replace":
      return { text: "opacity -> 0 (replaced away)", check: "opacity", value: 0 };
    case "reveal":
      return { text: "reveal -> 1", check: "reveal", value: 1 };
    case "fade":
      return typeof to === "number"
        ? { text: `opacity -> ${to}`, check: "opacity", value: to }
        : { text: "opacity changes", check: "none" };
    case "scale":
      return typeof to === "number"
        ? { text: `scale x${to}`, check: "scale", value: to }
        : { text: "scale changes", check: "none" };
    case "rotate":
      return typeof to === "number"
        ? { text: `rotation +${to}deg`, check: "rotate", value: to }
        : { text: "rotation changes", check: "none" };
    case "progress":
      return typeof to === "number"
        ? { text: `value -> ${to}`, check: "progress", value: to }
        : { text: "value advances", check: "none" };
    case "move":
      return p.expected?.toward
        ? { text: `approaches ${p.expected.toward} (>= ${ENACTMENT.approachPx}px)`, check: "approach", value: ENACTMENT.approachPx }
        : { text: "reaches the plan destination", check: "none" };
    default:
      return { text: "state changes", check: "none" };
  }
}

/* ------------------------------ event evaluation ---------------------------- */

function evaluateEvent(scene: SceneSpec, p: PromisedEventSchedule): EventEvidence {
  const plan = resolveExecutionPlan(scene);
  const planEvent = plan.events.find((e) => e.id === p.id) ?? null;
  const window = {
    pre: r3(clamp(p.atSeconds - ENACTMENT.eventWindowSec, 0, scene.duration)),
    at: r3(clamp(p.atSeconds, 0, scene.duration)),
    post: r3(clamp(p.atSeconds + ENACTMENT.eventWindowSec, 0, scene.duration)),
  };
  const goal = goalFor(p);
  const action = planEvent?.action ?? "unsupported";
  const base: EventEvidence = {
    eventId: p.id,
    sceneId: scene.sceneId,
    target: p.target ?? "",
    type: p.type,
    action,
    promisedAt: p.atSeconds,
    planAt: planEvent ? planEvent.atSeconds : null,
    detectedAt: null,
    timingDeltaSec: null,
    window,
    status: "pass",
    expected: goal.text,
    before: null,
    at: null,
    after: null,
    detected: false,
    confidence: 0,
    evidence: "",
  };

  // 1. unsupported taxonomy -> structured failure, never faked
  if (!isSupportedEventType(p.type)) {
    return {
      ...base,
      status: "unsupported_event",
      evidence: `event ${p.id} type "${p.type}" is not executable; supported: ${SUPPORTED_EVENT_LIST_TEXT}`,
    };
  }

  // 2. the plan must contain the promised event
  if (!planEvent) {
    return {
      ...base,
      status: "missing_event",
      evidence: `storyboard promises ${p.type} ${p.target ?? "?"} at ${p.atSeconds.toFixed(2)}s but the execution plan has no event ${p.id}`,
    };
  }
  if (planEvent.type !== p.type) {
    return {
      ...base,
      status: "missing_event",
      evidence: `plan event ${p.id} implements type "${planEvent.type}" instead of the promised "${p.type}" (${p.target})`,
    };
  }

  // 3. the target object must exist
  const targetState = p.target ? stateForSemanticId(scene, p.target, window.at) : null;
  if (!p.target || !targetState) {
    return {
      ...base,
      status: "missing_semantic_object",
      evidence: `event ${p.id} targets "${p.target}" but no element carries semanticId=${p.target}`,
    };
  }

  // 4. deterministic state evidence around the promised window.
  // Post-state target preference: state AT the promise, then just after, then at the scene
  // end (an execution that happens LATE only shows up there).
  // Baseline: whichever of {window start, scene start} sits FARTHER from the post-state -
  // an element may not exist at t=0 (replace/enter hide it before the event).
  // Batch G (WS-C): the scale threshold is RELATIVE to the element's own scale so a
  // correct small-element change (e.g. 0.5 -> 0.75 on a 0.35-scale element = 0.0875
  // absolute) is not rejected by a threshold calibrated for full-size elements. And
  // MOVE events use ONLY the window-start baseline: an earlier move to the same
  // destination must not be misattributed to a later redundant one.
  const absThreshold = execThresholdFor(p.type, scene, planEvent);
  const settle = settleFor(p.type);
  const windowStart = Math.max(0, p.atSeconds - (planEvent.durationSec ?? 0.35));
  const atC = channelAt(scene, p, window.at);
  const postC = channelAt(scene, p, window.post);
  const endC = channelAt(scene, p, scene.duration);
  const startC = channelAt(scene, p, windowStart);
  const atZero = channelAt(scene, p, 0);
  const initialCandidates: (Channel | null)[] =
    p.type === "move" ? [startC] : [startC, atZero];
  // reference magnitude for the relative scale threshold (larger baseline wins)
  const refScale =
    p.type === "scale"
      ? Math.max(
          startC?.kind === "scalar" ? startC.v : 0,
          atZero?.kind === "scalar" ? atZero.v : 0,
        ) || 1
      : 1;
  const threshold =
    p.type === "scale"
      ? Math.min(absThreshold, Math.max(ENACTMENT.scaleExecRel * refScale, ENACTMENT.scaleExecMin))
      : absThreshold;

  const farthestBaseline = (cand: Channel): { d: number; c: Channel | null } => {
    let bestI: Channel | null = null;
    let bestD = -1;
    for (const ic of initialCandidates) {
      const d = channelDist(ic, cand);
      if (d > bestD) {
        bestD = d;
        bestI = ic;
      }
    }
    return { d: bestD, c: bestI };
  };

  let target: Channel | null = null;
  let bestDelta = -1;
  let initial: Channel | null = null;
  for (const cand of [atC, postC, endC]) {
    if (!cand) continue;
    const base = farthestBaseline(cand);
    if (base.d >= threshold) {
      target = cand;
      bestDelta = base.d;
      initial = base.c;
      break;
    }
  }
  const detected = target !== null && bestDelta >= threshold;
  if (!detected) {
    // keep the largest observed (still sub-threshold) delta for honest evidence
    let maxD = -1;
    let maxI: Channel | null = null;
    let maxC: Channel | null = null;
    for (const cand of [atC, postC, endC]) {
      if (!cand) continue;
      const base = farthestBaseline(cand);
      if (base.d > maxD) {
        maxD = base.d;
        maxI = base.c;
        maxC = cand;
      }
    }
    bestDelta = Math.max(0, maxD);
    initial = maxI;
    target = maxC;
  }

  const before = snapshotOf(stateForSemanticId(scene, p.target, window.pre));
  const atState = snapshotOf(stateForSemanticId(scene, p.target, window.at));
  const after = snapshotOf(stateForSemanticId(scene, p.target, window.post));

  const shared: Partial<EventEvidence> = {
    before,
    at: atState,
    after,
    detected,
    confidence: 1, // every branch below is a verdict from measured state
  };

  // 5. executed at all?
  if (!detected) {
    const unit = deltaUnit(p.type);
    return {
      ...base,
      ...shared,
      confidence: 1,
      status: "event_not_executed",
      evidence: `${p.type} ${p.target}: state delta ${fmtChannel(p.type, initial)} -> ${fmtChannel(p.type, target)} = ${r3(bestDelta)}${unit} at ${p.atSeconds.toFixed(2)}s (min ${threshold}${unit})`,
    };
  }

  // 6. locate the crossing of the post-state (deterministic scan from the promised window,
  // no rendering). An execution that landed EARLIER than the window can only be observed at
  // the window start - which is still > tolerance because durationSec (0.35) > tolerance (0.30).
  let detectedAt: number | null = null;
  const step = ENACTMENT.scanStepSec;
  for (let t = windowStart; t <= scene.duration + 1e-9; t += step) {
    const c = channelAt(scene, p, Math.min(t, scene.duration));
    if (channelDist(c, target) <= settle) {
      detectedAt = r3(Math.min(t, scene.duration));
      break;
    }
  }
  const timingDelta = detectedAt === null ? null : r3(detectedAt - p.atSeconds);

  // 7. timing inside the documented tolerance?
  if (detectedAt === null || Math.abs(timingDelta ?? Infinity) > ENACTMENT.timingToleranceSec) {
    const planNote = planEvent.atSeconds !== p.atSeconds ? ` (plan carries ${planEvent.atSeconds.toFixed(2)}s)` : "";
    return {
      ...base,
      ...shared,
      detectedAt,
      timingDeltaSec: timingDelta,
      status: "event_timing_mismatch",
      evidence: `${p.type} ${p.target}: promised ${p.atSeconds.toFixed(2)}s, detected ${detectedAt === null ? "never" : `${detectedAt.toFixed(2)}s`} (delta ${timingDelta === null ? "n/a" : `${Math.abs(timingDelta).toFixed(2)}s`} > tolerance ${ENACTMENT.timingToleranceSec}s)${planNote}`,
    };
  }

  // 8. final state must match the promise (state_transition_failed)
  const afterState = after;
  let finalOk = true;
  let finalEvidence = "";
  if (afterState) {
    switch (goal.check) {
      case "opacity": {
        const want = goal.value;
        const got = afterState.opacity;
        // replace: also require the replacement to become visible
        finalOk = Math.abs(got - want) <= ENACTMENT.opacityFinalTol;
        if (p.type === "replace" && p.expected?.with) {
          const b = stateForSemanticId(scene, p.expected.with, window.post);
          if (b && b.opacity < 1 - ENACTMENT.opacityFinalTol) {
            finalOk = false;
            finalEvidence = `replacement "${p.expected.with}" opacity ${b.opacity.toFixed(2)} (expected >= ${(1 - ENACTMENT.opacityFinalTol).toFixed(2)})`;
          }
        }
        if (!finalOk && !finalEvidence) {
          finalEvidence = `opacity ${got.toFixed(2)}, expected ${want} (tolerance ${ENACTMENT.opacityFinalTol})`;
        }
        break;
      }
      case "reveal":
        finalOk = afterState.reveal >= 1 - ENACTMENT.revealSettle - 0.02;
        if (!finalOk) finalEvidence = `reveal ${afterState.reveal.toFixed(2)}, expected >= 1`;
        break;
      case "scale": {
        const initialScale = elementStateAt(scene, targetState.index, 0)?.scale ?? afterState.scale;
        const mult = initialScale !== 0 ? afterState.scale / initialScale : afterState.scale;
        finalOk = Math.abs(mult - goal.value) <= ENACTMENT.scaleFinalTol;
        if (!finalOk) finalEvidence = `scale x${mult.toFixed(2)}, expected x${goal.value} (tolerance ${ENACTMENT.scaleFinalTol})`;
        break;
      }
      case "rotate": {
        const initialRot = elementStateAt(scene, targetState.index, 0)?.rotation ?? afterState.rotation;
        const delta = afterState.rotation - initialRot;
        finalOk = Math.abs(delta - goal.value) <= ENACTMENT.rotateFinalTolDeg;
        if (!finalOk) finalEvidence = `rotation +${delta.toFixed(1)}deg, expected +${goal.value}deg (tolerance ${ENACTMENT.rotateFinalTolDeg})`;
        break;
      }
      case "progress": {
        const v = afterState.progress;
        finalOk = v !== null && Math.abs(v - goal.value) <= ENACTMENT.progressFinalTol;
        if (!finalOk) finalEvidence = `value ${v === null ? "n/a" : v.toFixed(2)}, expected ${goal.value} (tolerance ${ENACTMENT.progressFinalTol})`;
        break;
      }
      case "approach": {
        const dest = p.expected?.toward ?? "";
        const b = stateForSemanticId(scene, p.target, window.pre);
        const d0 = b && dest ? distanceBetween(scene, p.target, dest, window.pre) : null;
        const d1 = dest ? distanceBetween(scene, p.target, dest, window.post) : null;
        if (d0 !== null && d1 !== null) {
          finalOk = d0 - d1 >= ENACTMENT.approachPx;
          if (!finalOk) finalEvidence = `distance ${Math.round(d0)}px -> ${Math.round(d1)}px (approach ${Math.round(d0 - d1)}px, min ${ENACTMENT.approachPx}px)`;
        }
        break;
      }
      default:
        break;
    }
  }
  if (!finalOk) {
    return {
      ...base,
      ...shared,
      detectedAt,
      timingDeltaSec: timingDelta,
      status: "state_transition_failed",
      evidence: `${p.type} ${p.target} at ${p.atSeconds.toFixed(2)}s: ${finalEvidence || goal.text}`,
    };
  }

  return {
    ...base,
    ...shared,
    detectedAt,
    timingDeltaSec: timingDelta,
    status: "pass",
    confidence: 1,
    evidence: `${p.type} ${p.target}: ${fmtChannel(p.type, initial)} -> ${fmtChannel(p.type, target)} (${r3(bestDelta)}${deltaUnit(p.type)}), detected ${detectedAt?.toFixed(2)}s / promised ${p.atSeconds.toFixed(2)}s (delta ${(timingDelta ?? 0).toFixed(2)}s <= ${ENACTMENT.timingToleranceSec}s)`,
  };
}

function distanceBetween(scene: SceneSpec, fromId: string, toId: string, t: number): number | null {
  const a = stateForSemanticId(scene, fromId, t);
  const b = stateForSemanticId(scene, toId, t);
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/* ----------------------------- relationship checks -------------------------- */

function evaluateRelationship(
  scene: SceneSpec,
  rel: { from: string; to: string; type: RelationshipType; declared: string },
  ctx: { promisedIds: Set<string>; failedEventTargets: Set<string>; reportedIds: Set<string> },
): RelationshipEvidence {
  const base: RelationshipEvidence = {
    sceneId: scene.sceneId,
    from: rel.from,
    to: rel.to,
    type: rel.type,
    declared: rel.declared,
    status: "pass",
    suppressed: false,
    distanceBeforePx: null,
    distanceAfterPx: null,
    evidence: "",
  };

  const known = (id: string): boolean => ctx.promisedIds.has(id);
  const missing = (id: string): boolean => elementBySemanticId(scene, id) === null;

  if (!known(rel.from) || !known(rel.to)) {
    const unknown = !known(rel.from) ? rel.from : rel.to;
    return {
      ...base,
      status: "relationship_failed",
      evidence: `relationship ${rel.from} -${rel.type}-> ${rel.to}: unknown reference "${unknown}" (not a promised semantic object)`,
    };
  }
  if (missing(rel.from) || missing(rel.to)) {
    const gone = missing(rel.from) ? rel.from : rel.to;
    if (ctx.reportedIds.has(gone)) {
      // the missing object is already reported (missing_semantic_object) - no duplicate failure
      return { ...base, status: "pass", suppressed: true, evidence: `suppressed: endpoint "${gone}" missing (covered by missing_semantic_object)` };
    }
    return {
      ...base,
      status: "relationship_failed",
      evidence: `relationship ${rel.from} -${rel.type}-> ${rel.to}: endpoint "${gone}" has no element (semanticId=${gone})`,
    };
  }
  if (ctx.failedEventTargets.has(rel.from) || ctx.failedEventTargets.has(rel.to)) {
    return { ...base, status: "pass", suppressed: true, evidence: "suppressed: an endpoint's promised event already failed (root cause reported)" };
  }

  const endState = scene.duration;
  const d0 = distanceBetween(scene, rel.from, rel.to, 0);
  const d1 = distanceBetween(scene, rel.from, rel.to, endState);
  const rb = d0 === null ? null : r3(d0);
  const ra = d1 === null ? null : r3(d1);

  switch (rel.type) {
    case "movesToward": {
      if (d0 === null || d1 === null) {
        return { ...base, status: "relationship_failed", evidence: `movesToward ${rel.from}->${rel.to}: states unavailable` };
      }
      const approach = d0 - d1;
      if (approach < ENACTMENT.approachPx) {
        return {
          ...base,
          status: "relationship_failed",
          distanceBeforePx: rb,
          distanceAfterPx: ra,
          evidence: `movesToward ${rel.from}->${rel.to}: distance ${Math.round(d0)}px -> ${Math.round(d1)}px (approach ${Math.round(approach)}px, min ${ENACTMENT.approachPx}px)`,
        };
      }
      return { ...base, distanceBeforePx: rb, distanceAfterPx: ra, evidence: `movesToward ${rel.from}->${rel.to}: distance ${Math.round(d0)}px -> ${Math.round(d1)}px (approach ${Math.round(approach)}px >= ${ENACTMENT.approachPx}px)` };
    }
    case "near": {
      if (d1 === null) return { ...base, status: "relationship_failed", evidence: `near ${rel.from}-${rel.to}: states unavailable` };
      if (d1 > ENACTMENT.nearPx) {
        return {
          ...base,
          status: "relationship_failed",
          distanceBeforePx: rb,
          distanceAfterPx: ra,
          evidence: `near ${rel.from}-${rel.to}: final distance ${Math.round(d1)}px > ${ENACTMENT.nearPx}px`,
        };
      }
      return { ...base, distanceBeforePx: rb, distanceAfterPx: ra, evidence: `near ${rel.from}-${rel.to}: final distance ${Math.round(d1)}px <= ${ENACTMENT.nearPx}px` };
    }
    case "attachedTo": {
      const child = stateForSemanticId(scene, rel.from, endState);
      const attached = child?.attachedTo === rel.to;
      if (!attached) {
        return {
          ...base,
          evidence: `attachedTo ${rel.from}->${rel.to}: child attachedTo=${child?.attachedTo ?? "none"} (expected ${rel.to})`,
          status: "relationship_failed",
        };
      }
      return { ...base, evidence: `attachedTo ${rel.from}->${rel.to}: child follows parent transform` };
    }
    case "pointsTo": {
      // structural in Batch D: both endpoints exist and resolve (directional ink checks need pixels)
      return { ...base, evidence: `pointsTo ${rel.from}->${rel.to}: endpoints resolve (structural check)` };
    }
    case "overlapsIntentionally": {
      const a = elementBySemanticId(scene, rel.from) as { collisionIntent?: string } | null;
      const b = elementBySemanticId(scene, rel.to) as { collisionIntent?: string } | null;
      const declaredIntent = a?.collisionIntent === "intentional" || b?.collisionIntent === "intentional";
      if (!declaredIntent) {
        return {
          ...base,
          status: "relationship_failed",
          evidence: `overlapsIntentionally ${rel.from}/${rel.to}: no element declares collisionIntent=intentional`,
        };
      }
      return { ...base, evidence: `overlapsIntentionally ${rel.from}/${rel.to}: collisionIntent=intentional declared` };
    }
    default:
      return base;
  }
}

/* ------------------------------ per-scene gate ------------------------------ */

function summarizeScene(sc: Omit<SceneEnactment, "summary">): string {
  const parts: string[] = [];
  const total = sc.events.length;
  if (sc.objects.promised.length || sc.objects.missing.length) {
    parts.push(`objects=${sc.objects.present.length}/${sc.objects.promised.length}`);
  }
  if (total > 0) {
    const pass = sc.events.filter((e) => e.status === "pass").length;
    const detected = sc.events.filter((e) => e.detected).length;
    parts.push(`events=${pass}/${total}`);
    if (sc.objects.missing.length) parts.push(`missing=${sc.objects.missing.join(",")}`);
    if (pass < total) parts.push(`executed=${detected}/${total}`);
    const timing = sc.events.filter((e) => e.status === "event_timing_mismatch").length;
    if (timing > 0) parts.push(`timing=${timing} mismatch`);
    const unsupported = sc.events.filter((e) => e.status === "unsupported_event").length;
    if (unsupported > 0) parts.push(`unsupported=${unsupported}`);
  } else if (sc.objects.missing.length) {
    parts.push(`missing=${sc.objects.missing.join(",")}`);
  }
  const evaluated = sc.relationships.filter((r) => !r.suppressed);
  if (evaluated.length > 0) {
    const relPass = evaluated.filter((r) => r.status === "pass").length;
    parts.push(`relationships=${relPass}/${evaluated.length}`);
  }
  const categoryFails = sc.categories.filter((c) => c.status === "fail").length;
  if (categoryFails > 0) parts.push(`category=${categoryFails} mismatch`);
  if (parts.length === 0) parts.push(sc.contractActive ? "no promises" : "no semantic contract");
  return parts.join(" ");
}

function evaluateScene(scene: SceneSpec): SceneEnactment {
  const sb = scene.storyboard;
  const schedule = sb ? promisedEventSchedule(scene) : [];
  const promisedObjects = (sb?.semanticObjects ?? []).filter((o) => typeof o.id === "string" && o.id);
  const structuredRels = (sb?.relationships ?? []).filter(
    (r): r is { from: string; to: string; relationship: string; type: RelationshipType } =>
      typeof r.type === "string" && (RELATIONSHIP_TYPES as readonly string[]).includes(r.type),
  );
  const contractActive = promisedObjects.length > 0 || schedule.length > 0 || structuredRels.length > 0;

  if (!contractActive) {
    return {
      sceneId: scene.sceneId,
      contractActive: false,
      objects: { promised: [], present: [], missing: [] },
      categories: [],
      events: [],
      relationships: [],
      failures: [],
      summary: "no semantic contract",
    };
  }

  // required objects = storyboard ids + every event target (an event target is a promise too)
  const promisedIds = new Set(requiredSemanticIds(scene));
  const present: string[] = [];
  const missing: string[] = [];
  for (const id of [...promisedIds].sort()) {
    if (elementBySemanticId(scene, id)) present.push(id);
    else missing.push(id);
  }

  const reportedIds = new Set(missing);
  const failures: EnactmentFailure[] = [];
  for (const id of missing) {
    const obj = promisedObjects.find((o) => o.id === id);
    failures.push({
      type: "missing_semantic_object",
      severity: "hard",
      source: "deterministic-semantic",
      sceneId: scene.sceneId,
      evidence: obj
        ? `storyboard requires semantic object "${id}" (${obj.objectType}) but no element carries semanticId=${id}`
        : `event target "${id}" has no element carrying semanticId=${id}`,
      target: [id],
      magnitude: 1,
    });
  }

  // Batch E Phase 3: category validation for every present promised object
  const categories: ObjectCategoryCheck[] = [];
  for (const obj of promisedObjects) {
    const id = obj.id as string;
    const element = elementBySemanticId(scene, id);
    if (!element) continue; // absence is already reported as missing_semantic_object
    const assessment = assessSemanticCategory({
      objectType: obj.objectType,
      semanticRole: obj.semanticRole,
      primitive: element.primitive,
    });
    categories.push({
      id,
      objectType: obj.objectType,
      primitive: element.primitive,
      status: assessment.status,
      reason: assessment.reason,
    });
    if (assessment.status === "fail") {
      failures.push({
        type: "category_mismatch",
        severity: "hard",
        source: "deterministic-semantic",
        sceneId: scene.sceneId,
        evidence: `semantic object "${id}" (${obj.objectType}) rendered by ${element.primitive}: ${assessment.reason}`,
        target: [id, element.primitive],
        magnitude: 1,
      });
    }
  }

  const events: EventEvidence[] = schedule.map((p) => evaluateEvent(scene, p));
  const failedEventTargets = new Set<string>(
    events.filter((e) => e.status !== "pass").map((e) => e.target).filter(Boolean),
  );
  const plan = resolveExecutionPlan(scene);

  const seenFailureKeys = new Set<string>(failures.map((f) => `${f.sceneId}|${f.type}|${(f.target ?? []).join(",")}`));
  for (const ev of events) {
    if (ev.status === "pass") continue;
    const type = ev.status as EnactmentFailureType;
    if (!ENACTMENT_FAILURE_TYPES.includes(type)) continue;
    // an event whose target is already reported as a missing object must not double-report
    if (type === "missing_semantic_object" && ev.target && reportedIds.has(ev.target)) continue;
    // cascade: an event that cannot run because its DESTINATION object is missing is covered
    // by the (higher-priority) missing_semantic_object failure
    if (type === "event_not_executed") {
      const pe = plan.events.find((e) => e.id === ev.eventId);
      if (
        pe &&
        ((pe.destination && reportedIds.has(pe.destination)) ||
          (pe.withTarget && reportedIds.has(pe.withTarget)))
      ) {
        continue;
      }
    }
    const failureKey = `${ev.sceneId}|${type}|${type === "missing_semantic_object" ? ev.target : ev.eventId}`;
    if (seenFailureKeys.has(failureKey)) continue;
    seenFailureKeys.add(failureKey);
    failures.push({
      type,
      severity: "hard",
      source: "deterministic-semantic",
      sceneId: scene.sceneId,
      evidence: ev.evidence,
      target: [ev.eventId, ev.target].filter(Boolean),
      magnitude: type === "event_timing_mismatch" && ev.timingDeltaSec !== null ? Math.abs(ev.timingDeltaSec) : 1,
    });
  }

  const relationships: RelationshipEvidence[] = structuredRels.map((r) =>
    evaluateRelationship(
      scene,
      { from: r.from, to: r.to, type: r.type, declared: r.relationship },
      { promisedIds, failedEventTargets, reportedIds },
    ),
  );
  for (const rel of relationships) {
    if (rel.status !== "relationship_failed" || rel.suppressed) continue;
    const failureKey = `${rel.sceneId}|relationship_failed|${rel.from},${rel.to}`;
    if (seenFailureKeys.has(failureKey)) continue;
    seenFailureKeys.add(failureKey);
    failures.push({
      type: "relationship_failed",
      severity: "hard",
      source: "deterministic-semantic",
      sceneId: scene.sceneId,
      evidence: rel.evidence,
      target: [rel.from, rel.to],
      magnitude: 1,
    });
  }

  const partial: Omit<SceneEnactment, "summary"> = {
    sceneId: scene.sceneId,
    contractActive,
    objects: { promised: [...promisedIds].sort(), present, missing },
    categories,
    events,
    relationships,
    failures,
  };
  return { ...partial, summary: summarizeScene(partial) };
}

/** The semantic enactment gate (Batch D). Pure + deterministic: same scenes -> same report. */
export function evaluateSemanticEnactment(scenes: SceneSpec[]): SemanticEnactmentReport {
  const sceneEnactments = scenes.map(evaluateScene);
  const failures = sceneEnactments.flatMap((s) => s.failures);
  return {
    schema: "semantic-enactment/1",
    scenesHash: scenesFingerprint(scenes).scenesHash,
    toleranceSec: ENACTMENT.timingToleranceSec,
    ok: failures.length === 0,
    scenes: sceneEnactments,
    failures,
    compact: sceneEnactments.map((s) => `${s.sceneId}: ${s.summary}`),
  };
}

/** Compact judge-ready evidence lines (§26). Images remain the judge's primary evidence. */
export const enactmentEvidenceLines = (report: SemanticEnactmentReport | null | undefined): string[] =>
  report?.compact ?? [];

/** Zod shape for persisted reports (diagnostics/UI read the same contract). */
export const enactmentReportSchema = z
  .object({
    schema: z.literal("semantic-enactment/1"),
    scenesHash: z.string(),
    toleranceSec: z.number(),
    ok: z.boolean(),
    compact: z.array(z.string().max(300)),
  })
  .passthrough();

export { SUPPORTED_MOTION_EVENT_TYPES };
