import { z } from "zod";
import {
  SUPPORTED_MOTION_EVENT_TYPES,
  type Storyboard,
} from "./storyboardSchema";
import type { SceneSpec } from "./schema";

/**
 * TEMPORAL EXECUTION PLAN (Batch D / §5-§8).
 *
 * The plan is the executable form of the storyboard's `motionBeats`:
 *
 *   AI decides WHAT happens (motion beat: target, event type, approximate time, expected state)
 *   CODE decides HOW  (this module compiles it into a deterministic event list;
 *                      src/scenes/execution.ts performs it; the gate measures it)
 *
 * The plan is either embedded in `scene.executionPlan` (deterministic embed by the scene
 * composer) or derived on the fly from `scene.storyboard` - both paths run the SAME pure
 * compile function, so a storyboard promise is always executable.
 *
 * Timing rules (§8): explicit `motionBeats[].atSeconds` is preserved when it lies inside the
 * scene window; otherwise the time is DERIVED deterministically from the beat distribution and
 * labelled `provenance: "derived"` - never presented as measured. VO word timestamps remain
 * the authority for scene windows; this plan never touches them.
 */

export const EXECUTION_PLAN_SCHEMA = "execution-plan/1";

/** Machine action executed for each event type (derived - never model-echoed). */
export const EVENT_ACTION: Record<string, string> = {
  enter: "appear",
  exit: "disappear",
  move: "moveTo",
  scale: "setScale",
  rotate: "setRotation",
  fade: "setOpacity",
  replace: "replaceWith",
  reveal: "reveal",
  progress: "advanceTo",
  attach: "attachTo",
  detach: "detachFrom",
};

export const SUPPORTED_EVENT_SET: ReadonlySet<string> = new Set(SUPPORTED_MOTION_EVENT_TYPES);

/** Event types the renderer cannot (yet) execute deterministically. */
export const isSupportedEventType = (type: string): boolean => SUPPORTED_EVENT_SET.has(type);

/** Human-readable taxonomy list for evidence strings. */
export const SUPPORTED_EVENT_LIST_TEXT = SUPPORTED_MOTION_EVENT_TYPES.join(", ");

/** Default transition window: the state change lands AT `atSeconds` (§16). */
export const TRANSITION_DEFAULT_SEC = 0.35;
/** Deterministic easing vocabulary - LLMs never invent easing functions (§17). */
export const EVENT_EASINGS = ["linear", "easeIn", "easeOut", "easeInOut"] as const;
export type EventEasing = (typeof EVENT_EASINGS)[number];

/** An explicit atSeconds is usable only inside the scene window with room for a pre-state. */
export const MIN_EVENT_SEC = 0.05;

export interface PlanEvent {
  /** stable event id (`event_01`, ...) - matches the storyboard motion beat */
  id: string;
  atSeconds: number;
  /** raw event type; may be unsupported (kept so the gate can report it honestly) */
  type: string;
  action: string;
  /** semantic id of the target element (bound at compile time) */
  target: string;
  /** replace: semantic id of the element that becomes visible */
  withTarget?: string;
  /** move: semantic id of the destination element */
  destination?: string;
  from?: number;
  to?: number;
  /** resolved absolute offsets for `move` (percent of canvas); runtime-resolved when absent */
  toOffsetX?: number;
  toOffsetY?: number;
  durationSec: number;
  easing: EventEasing;
  provenance: "explicit" | "derived";
  /** original motion beat order, for diagnostics */
  sourceOrder?: number;
}

export interface ExecutionPlan {
  schema: typeof EXECUTION_PLAN_SCHEMA;
  events: PlanEvent[];
}

const planEventSchema = z
  .object({
    id: z.string().min(2).max(40).regex(/^event_[A-Za-z0-9_]+$/, "event id must look like event_01"),
    atSeconds: z.number().min(0).max(60),
    type: z.string().min(1).max(24),
    action: z.string().min(1).max(32),
    target: z.string().min(1).max(40),
    withTarget: z.string().max(40).optional(),
    destination: z.string().max(40).optional(),
    from: z.number().finite().optional(),
    to: z.number().finite().optional(),
    toOffsetX: z.number().min(-100).max(100).optional(),
    toOffsetY: z.number().min(-100).max(100).optional(),
    durationSec: z.number().min(0.05).max(5).default(TRANSITION_DEFAULT_SEC),
    easing: z.enum(EVENT_EASINGS).default("easeInOut"),
    provenance: z.enum(["explicit", "derived"]).default("derived"),
    sourceOrder: z.number().int().min(1).max(12).optional(),
  })
  .strip();

export const executionPlanSchema = z
  .object({
    schema: z.literal(EXECUTION_PLAN_SCHEMA),
    events: z.array(planEventSchema).max(16),
  })
  .strip();

export type PlanEventSpec = z.infer<typeof planEventSchema>;

/** Stable event id for a motion beat: explicit id wins, otherwise the beat's array index. */
export function promisedEventId(beat: Storyboard["motionBeats"][number], index: number): string {
  return beat.id ?? `event_${String(index + 1).padStart(2, "0")}`;
}

/** One storyboard promise that the execution plan must fulfill. */
export interface PromisedEventSchedule {
  /** index inside storyboard.motionBeats (drives the default event id) */
  index: number;
  id: string;
  type: string;
  /** semantic target id, null when the beat never bound one (unexecutable promise) */
  target: string | null;
  /** the time the contract demands (explicit when usable, deterministic spread otherwise) */
  atSeconds: number;
  provenance: "explicit" | "derived";
  expected?: { from?: number; to?: number; toward?: string; with?: string; parent?: string };
}

/**
 * The executable promises of a scene's storyboard (pure, deterministic).
 * Shared by the plan compiler and the semantic enactment gate so "promise" and
 * "plan" can never disagree on ids or times.
 */
export function promisedEventSchedule(scene: SceneSpec): PromisedEventSchedule[] {
  const sb = scene.storyboard;
  if (!sb) return [];
  const typed = sb.motionBeats
    .map((beat, index) => ({ beat, index }))
    .filter(({ beat }) => typeof beat.eventType === "string" && beat.eventType.trim().length >= 2);
  const times = resolveEventTimes(typed, scene.duration);
  return typed.map(({ beat, index }, i) => {
    const target = typeof beat.target === "string" ? beat.target.trim() : "";
    return {
      index,
      id: promisedEventId(beat, index),
      type: beat.eventType!.trim(),
      target: target || null,
      atSeconds: times[i].atSeconds,
      provenance: times[i].provenance,
      ...(beat.expected ? { expected: beat.expected } : {}),
    };
  });
}

/** Promised (storyboard-side) event times: explicit when usable, else deterministic spread. */
function resolveEventTimes(
  beats: { beat: Storyboard["motionBeats"][number]; index: number }[],
  duration: number,
): { atSeconds: number; provenance: "explicit" | "derived" }[] {
  const n = Math.max(1, beats.length);
  return beats.map(({ beat, index }, i) => {
    const explicit = beat.atSeconds;
    const usable =
      typeof explicit === "number" &&
      Number.isFinite(explicit) &&
      explicit >= MIN_EVENT_SEC &&
      explicit <= duration;
    if (usable) return { atSeconds: explicit, provenance: "explicit" };
    // deterministic distribution inside the scene window (never called "measured")
    const derived = Math.min(duration, Math.max(MIN_EVENT_SEC, (duration * (i + 1)) / (n + 1)));
    void index;
    return { atSeconds: Number(derived.toFixed(3)), provenance: "derived" };
  });
}

/**
 * Compile the storyboard's executable motion beats into a plan (pure).
 *
 * - beats without `eventType` are descriptive metadata and are NOT promises;
 * - beats with `eventType` but no `target` cannot be bound and are dropped (the gate
 *   reports them as `missing_event` - the promise still exists);
 * - unsupported types are KEPT (type passed through) so the gate can surface
 *   `unsupported_event` instead of silently losing the promise.
 */
export function compileExecutionPlan(scene: SceneSpec): ExecutionPlan {
  const events: PlanEvent[] = [];
  if (!scene.storyboard) return { schema: EXECUTION_PLAN_SCHEMA, events };

  for (const p of promisedEventSchedule(scene)) {
    if (!p.target) continue; // unbound promise -> gate reports missing_event
    const expected = p.expected ?? {};
    const destination = expected.toward ?? expected.parent;
    events.push({
      id: p.id,
      atSeconds: p.atSeconds,
      type: p.type,
      action: EVENT_ACTION[p.type] ?? "unsupported",
      target: p.target,
      ...(expected.with ? { withTarget: expected.with } : {}),
      ...(destination ? { destination } : {}),
      ...(typeof expected.from === "number" ? { from: expected.from } : {}),
      ...(typeof expected.to === "number" ? { to: expected.to } : {}),
      durationSec: TRANSITION_DEFAULT_SEC,
      easing: "easeInOut",
      provenance: p.provenance,
      sourceOrder: scene.storyboard.motionBeats[p.index]?.order,
    });
  }

  events.sort((a, b) => a.atSeconds - b.atSeconds || a.id.localeCompare(b.id));
  return { schema: EXECUTION_PLAN_SCHEMA, events };
}

/**
 * The plan the renderer executes: the explicit embed when present, otherwise the
 * deterministic compile from the storyboard (same function, one source of truth).
 */
export function resolveExecutionPlan(scene: SceneSpec): ExecutionPlan {
  if (scene.executionPlan && Array.isArray(scene.executionPlan.events)) {
    return scene.executionPlan as ExecutionPlan;
  }
  return compileExecutionPlan(scene);
}
