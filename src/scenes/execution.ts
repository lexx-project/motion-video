import { anchor, headlinePositionFor } from "./layout";
import type { SceneSpec, SceneElement } from "../validation/schema";
import {
  resolveExecutionPlan,
  isSupportedEventType,
  type PlanEvent,
} from "../validation/executionPlan";

/**
 * DETERMINISTIC EVENT EXECUTION (Batch D / §15-§17).
 *
 * Pure function of (scene JSON, time): the execution plan in, the element's execution
 * transform out. The SAME math drives:
 *   - the renderer (src/scenes/SceneRenderer.tsx applies it to the element wrapper), and
 *   - the state extractor (src/scenes/state.ts) used by the semantic enactment gate,
 * so "what was promised" and "what was rendered" can never drift apart.
 *
 * Every transition completes AT its `atSeconds` (§16):
 *   t < at - durationSec  -> pre-state
 *   t = at                -> post-state reached
 *   t > at                -> post-state held
 *
 * Attachment (§15) is implemented at this layer: a child with `attachTo` inherits its
 * parent's execution offset (one relation graph, cycle-safe), while keeping its own
 * local offset. No primitive was rewritten for this.
 */

export interface ExecutionState {
  /** execution offset in percent of canvas (added to element.offsetX/offsetY) */
  dx: number;
  dy: number;
  /** multiplicative scale (1 = unchanged) */
  scaleMul: number;
  /** additive rotation in degrees */
  rotation: number;
  /** multiplicative opacity (0..1) */
  opacity: number;
  /** clip reveal 0..1 (1 = fully revealed) */
  reveal: number;
  /** driven `progress` value when a progress event applies, else null (keep base value) */
  progress: number | null;
  /** effective parent semantic id after attach/detach events (null = detached) */
  attached: string | null;
}

export const NEUTRAL_EXECUTION: ExecutionState = {
  dx: 0,
  dy: 0,
  scaleMul: 1,
  rotation: 0,
  opacity: 1,
  reveal: 1,
  progress: null,
  attached: null,
};

export const CANVAS = { width: 1080, height: 1920 };

/** Reference box for the anchor-point model (documented approximation, see state.ts). */
export const REF_BOX = { w: 320, h: 240 };

/** A move stops this many px short of the destination centre so objects approach, not overlap. */
export const MOVE_STOP_SHORT_PX = 170;

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/* ---------------------------------- easing ---------------------------------- */

/**
 * Deterministic easing vocabulary (§17). LLMs choose a name; code computes the curve.
 */
export const EVENT_EASING_FN: Record<string, (p: number) => number> = {
  linear: (p) => p,
  easeIn: (p) => p * p,
  easeOut: (p) => 1 - (1 - p) * (1 - p),
  easeInOut: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
};

/** Eased progress of one event at scene time `t`: 0 before the window, 1 at/after `atSeconds`. */
export function eventProgress(event: PlanEvent, t: number): number {
  const duration = clamp(num(event.durationSec, 0.35), 0.05, 5);
  const end = num(event.atSeconds, 0);
  const start = Math.max(0, end - duration);
  if (end <= start) return t >= end ? 1 : 0;
  const raw = clamp((t - start) / (end - start), 0, 1);
  const ease = EVENT_EASING_FN[event.easing ?? "easeInOut"] ?? EVENT_EASING_FN.easeInOut;
  return ease(raw);
}

/* ------------------------------ semantic id lookup --------------------------- */

export function elementIndexBySemanticId(scene: SceneSpec, id: string): number {
  const els = scene.elements ?? [];
  for (let i = 0; i < els.length; i++) {
    if ((els[i] as { semanticId?: string }).semanticId === id) return i;
  }
  return -1;
}

export function elementBySemanticId(scene: SceneSpec, id: string): SceneElement | null {
  const i = elementIndexBySemanticId(scene, id);
  return i >= 0 ? scene.elements[i] : scene.headline?.semanticId === id ? headlineElementFor(scene) : null;
}

/** The existing synthetic headline, shared by rendering and state extraction. */
export function headlineElementFor(scene: SceneSpec): SceneElement | null {
  if (!scene.headline) return null;
  return {
    primitive: "Headline", text: scene.headline.text,
    accentWords: scene.headline.accentWords ?? [], align: scene.headline.align,
    position: scene.headline.position ?? headlinePositionFor(scene.composition),
    accent: "none", opacity: 1, scale: 1,
    ...(scene.headline.semanticId ? { semanticId: scene.headline.semanticId } : {}),
  };
}

/**
 * Anchor-point model: where an element's centre sits on the canvas (px).
 * Deterministic approximation (anchor percent + reference box + declared offsets).
 * Used for relationship distances and move destinations - deltas and directions are exact
 * because both endpoints use the same model; absolute distance is approximate.
 */
export function elementAnchorPoint(scene: SceneSpec, el: SceneElement): { x: number; y: number } {
  void scene;
  const pos = (el.position as string | undefined) ?? "center";
  const a = anchor(pos);
  const leftPx = (parseFloat(a.left) / 100) * CANVAS.width;
  const topPx = (parseFloat(a.top) / 100) * CANVAS.height;
  const ox = num(el.offsetX, 0);
  const oy = num(el.offsetY, 0);
  return {
    x: leftPx + ((a.tx + 50) / 100) * REF_BOX.w + (ox / 100) * CANVAS.width,
    y: topPx + ((a.ty + 50) / 100) * REF_BOX.h + (oy / 100) * CANVAS.height,
  };
}

/**
 * Absolute target offsets (percent of canvas) for a `move` event.
 * `toOffsetX/Y` win when present; otherwise the destination is resolved through the
 * anchor-point model. Batch G (WS-C): when the source is CLOSER to the destination
 * than the stop-short distance, the old code moved zero pixels (a silent no-op that
 * the live runs reported as `event_not_executed`). Close pairs now cover half the
 * available gap - visible travel without ever overlapping the destination.
 */
export function resolveMoveTarget(scene: SceneSpec, event: PlanEvent): { x: number; y: number } | null {
  const el = elementBySemanticId(scene, event.target);
  if (!el) return null;
  const baseX = num(el.offsetX, 0);
  const baseY = num(el.offsetY, 0);
  const hasX = typeof event.toOffsetX === "number";
  const hasY = typeof event.toOffsetY === "number";
  if (hasX || hasY) {
    return { x: hasX ? (event.toOffsetX as number) : baseX, y: hasY ? (event.toOffsetY as number) : baseY };
  }
  if (!event.destination) return null;
  const dst = elementBySemanticId(scene, event.destination);
  if (!dst) return null;
  const from = elementAnchorPoint(scene, el);
  const to = elementAnchorPoint(scene, dst);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const k = dist > MOVE_STOP_SHORT_PX ? (dist - MOVE_STOP_SHORT_PX) / dist : dist > 0 ? 0.5 : 0;
  const targetX = from.x + dx * k;
  const targetY = from.y + dy * k;
  return {
    x: clamp(baseX + ((targetX - from.x) / CANVAS.width) * 100, -100, 100),
    y: clamp(baseY + ((targetY - from.y) / CANVAS.height) * 100, -100, 100),
  };
}

/**
 * Maximum travel (px) the executor can produce for a destination-resolved move event.
 * The semantic gate uses this for a distance-aware execution threshold: requiring a
 * fixed 150px of movement from objects that are only ~150px apart is impossible by
 * construction (the move stops short of the destination). Null = not destination-resolved.
 */
export function maxMoveTravelPx(scene: SceneSpec, event: PlanEvent): number | null {
  if (typeof event.toOffsetX === "number" || typeof event.toOffsetY === "number") return null;
  if (!event.destination) return null;
  const el = elementBySemanticId(scene, event.target);
  const dst = elementBySemanticId(scene, event.destination);
  if (!el || !dst) return null;
  const from = elementAnchorPoint(scene, el);
  const to = elementAnchorPoint(scene, dst);
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const k = dist > MOVE_STOP_SHORT_PX ? (dist - MOVE_STOP_SHORT_PX) / dist : dist > 0 ? 0.5 : 0;
  return dist * k;
}

/* -------------------------------- execution --------------------------------- */

interface ExecContext {
  visited: Set<string>;
}

/**
 * Execution transform of one element at scene time `t`.
 * Supported events only; unsupported types are ignored here and reported by the gate.
 */
export function elementExecutionAt(
  scene: SceneSpec,
  index: number,
  t: number,
  ctx?: ExecContext,
): ExecutionState {
  const el = index === -1 ? headlineElementFor(scene) : scene.elements?.[index];
  if (!el) return NEUTRAL_EXECUTION;
  const plan = resolveExecutionPlan(scene);
  const events = plan.events.filter((e) => isSupportedEventType(e.type));
  if (events.length === 0) return NEUTRAL_EXECUTION;

  const id = typeof el.semanticId === "string" ? el.semanticId : null;
  const baseX = num(el.offsetX, 0);
  const baseY = num(el.offsetY, 0);

  const mine = events
    .filter(
      (e) =>
        (id !== null && e.target === id) ||
        (e.type === "replace" && id !== null && e.withTarget === id),
    )
    .sort((a, b) => a.atSeconds - b.atSeconds || a.id.localeCompare(b.id));

  if (mine.length === 0 && !el.attachTo) return NEUTRAL_EXECUTION;

  let opacity = 1;
  let scaleMul = 1;
  let rotation = 0;
  let curX = baseX;
  let curY = baseY;
  let progress: number | null = null;
  let hasReveal = false;
  let revealAcc = 0;
  let attached: string | null = typeof el.attachTo === "string" ? el.attachTo : null;

  for (const ev of mine) {
    const p = eventProgress(ev, t);
    switch (ev.type) {
      case "enter":
        opacity *= p;
        break;
      case "exit":
        opacity *= 1 - p;
        break;
      case "fade": {
        const to = typeof ev.to === "number" ? ev.to : 0;
        const from = typeof ev.from === "number" ? ev.from : to >= 0.5 ? 0 : 1;
        opacity *= from + (to - from) * p;
        break;
      }
      case "replace":
        // target (A) disappears while withTarget (B) becomes visible
        opacity *= ev.target === (id ?? "") ? 1 - p : p;
        break;
      case "reveal":
        hasReveal = true;
        revealAcc = Math.max(revealAcc, p);
        break;
      case "scale": {
        // Batch G (WS-C): `to` is the ABSOLUTE final multiplier of the declared size
        // (storyboardSchema: "numeric end value the post-event state must reach").
        // The old `scaleMul *= 1+(to-1)*p` COMPOUNDED chained events (0.5 then 0.75
        // yielded 0.375, failing the gate's absolute mult check) and made
        // `from:0,to:1` grow-ins silent no-ops. Rules:
        //  - before the event window: leave scaleMul unchanged (t=0 baseline stays 1);
        //  - during the window: ramp to the absolute `to`;
        //  - when the ramp from the current value would be a no-op (entry === to) and
        //    the storyboard declared a different `from`, ramp from `from` instead so
        //    the promise is observable (`from` is otherwise evidence-only, per schema).
        if (typeof ev.to !== "number") break;
        const start = Math.max(0, ev.atSeconds - (ev.durationSec ?? 0.35));
        if (t < start) break;
        const base = ev.to === scaleMul && typeof ev.from === "number" && ev.from !== ev.to ? ev.from : scaleMul;
        scaleMul = base + (ev.to - base) * p;
        break;
      }
      case "rotate":
        rotation += (typeof ev.to === "number" ? ev.to : 90) * p;
        break;
      case "progress": {
        if (typeof ev.to !== "number") break;
        const base = typeof el.value === "number" ? el.value : 0;
        const from = typeof ev.from === "number" ? ev.from : base;
        const start = Math.max(0, ev.atSeconds - (ev.durationSec ?? 0.35));
        if (t >= start) progress = from + (ev.to - from) * p;
        break;
      }
      case "move": {
        const target = resolveMoveTarget(scene, ev);
        if (target) {
          curX += (target.x - curX) * p;
          curY += (target.y - curY) * p;
        }
        break;
      }
      case "attach":
        if (p >= 1 && ev.destination) attached = ev.destination;
        break;
      case "detach":
        if (p >= 1) attached = null;
        break;
      default:
        break;
    }
  }

  const state: ExecutionState = {
    dx: curX - baseX,
    dy: curY - baseY,
    scaleMul,
    rotation,
    opacity,
    reveal: hasReveal ? revealAcc : 1,
    progress,
    attached,
  };

  // Attachment (§15): the child follows its parent's execution offset (cycle-safe).
  if (attached && attached !== id) {
    const visited = ctx?.visited ?? new Set<string>();
    if (!visited.has(attached)) {
      visited.add(attached);
      const parentIdx = elementIndexBySemanticId(scene, attached);
      if (parentIdx >= 0 && parentIdx !== index) {
        const parent = elementExecutionAt(scene, parentIdx, t, { visited });
        state.dx += parent.dx;
        state.dy += parent.dy;
      }
    }
  }

  return state;
}
