import { elementExecutionAt, elementAnchorPoint, headlineElementFor, CANVAS, NEUTRAL_EXECUTION } from "./execution";
import { elementMotionStyle, curOpacity } from "../primitives/motion";
import { primitiveRegistry } from "../primitives/registry";
import { sizeScale } from "../primitives/sizing";
import { OUTPUT } from "../core/output";
import type { SceneSpec, SceneElement } from "../validation/schema";

/**
 * DETERMINISTIC STATE EXTRACTION (Batch D / §11).
 *
 * Reads the state the renderer WILL paint at scene time `t` without rendering a single
 * frame: wrapper execution transform (execution.ts) x primitive entrance/exit motion
 * (primitives/motion.ts - the exact function every primitive calls).
 *
 * Position uses the same anchor-point model the plan compiler uses (documented
 * approximation): centre = anchor percent + reference box + declared/executed offsets.
 * Deltas over time are exact; absolute inter-object distance is approximate.
 *
 * Node-only helper for the semantic enactment gate and event evidence. Never calls an LLM,
 * never opens a browser, never decodes pixels.
 */

export interface ElementState {
  index: number;
  semanticId: string | null;
  primitive: string;
  /** canvas px, anchor-point model */
  x: number;
  y: number;
  /** absolute scale multiplier (declared scale x size scale x execution scale) */
  scale: number;
  /** absolute rotation in degrees */
  rotation: number;
  /** combined opacity: execution wrapper x primitive motion */
  opacity: number;
  /** clip reveal 0..1 */
  reveal: number;
  /** driven progress value when a progress event applies, else the declared value (or null) */
  progress: number | null;
  /** effective parent after attach/detach events (null = detached) */
  attachedTo: string | null;
  /** opacity >= visibility floor */
  visible: boolean;
}

export const VISIBLE_OPACITY_FLOOR = 0.15;

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

const clockFor = (scene: SceneSpec, t: number) => {
  const fps = OUTPUT.fps;
  return {
    time: Math.max(0, Math.min(scene.duration, t)),
    frame: Math.round(Math.max(0, Math.min(scene.duration, t)) * fps),
    fps,
    durationSec: scene.duration,
    durationFrames: Math.max(1, Math.round(scene.duration * fps)),
  };
};

/** State of ONE element at scene time `t`. Null when the index does not exist. */
export function elementStateAt(scene: SceneSpec, index: number, t: number): ElementState | null {
  const el = index === -1 ? headlineElementFor(scene) : (scene.elements ?? [])[index] as SceneElement | undefined;
  if (!el) return null;
  const exec = elementExecutionAt(scene, index, t);
  const base = elementAnchorPoint(scene, el);

  // primitive-internal entrance/emphasis/exit motion (identical inputs as the renderer)
  const internalMotion = primitiveRegistry[el.primitive]?.internalMotion ?? false;
  const inner = elementMotionStyle({
    clock: clockFor(scene, t),
    sceneMotion: scene.motion,
    delay: num(el.delay, 0),
    entranceOverride: el.entrance as string | undefined,
    emphasisOverride: el.emphasis as string | undefined,
    exitOverride: el.exit as string | undefined,
    emphasisAtOverride: el.emphasisAt as number | undefined,
    glowAccent: el.accent,
    internalMotion,
  });

  const scale = num(el.scale, 1) * sizeScale(el.size as string | undefined) * exec.scaleMul;
  const opacity = round4(exec.opacity * curOpacity(inner));
  const baseValue = typeof el.value === "number" ? el.value : null;
  // a progress event only manifests when the primitive actually exposes a value channel
  const progress = exec.progress !== null && baseValue !== null ? round4(exec.progress) : baseValue;

  return {
    index,
    semanticId: typeof el.semanticId === "string" ? el.semanticId : null,
    primitive: el.primitive,
    x: round4(base.x + (exec.dx / 100) * CANVAS.width),
    y: round4(base.y + (exec.dy / 100) * CANVAS.height),
    scale: round4(scale),
    rotation: round4(num(el.rotation, 0) + exec.rotation),
    opacity,
    reveal: round4(exec.reveal),
    progress: exec.progress !== null ? round4(exec.progress) : baseValue,
    attachedTo: exec.attached,
    visible: opacity >= VISIBLE_OPACITY_FLOOR,
  };
}

/** State of every element at scene time `t` (index order). */
export function sceneStateAt(scene: SceneSpec, t: number): ElementState[] {
  const out: ElementState[] = [];
  const els = scene.elements ?? [];
  for (let i = 0; i < els.length; i++) {
    const s = elementStateAt(scene, i, t);
    if (s) out.push(s);
  }
  return out;
}

/** State of the element bound to a semantic id (null when the object does not exist). */
export function stateForSemanticId(scene: SceneSpec, semanticId: string, t: number): ElementState | null {
  const els = scene.elements ?? [];
  for (let i = 0; i < els.length; i++) {
    if ((els[i] as { semanticId?: string }).semanticId === semanticId) {
      return elementStateAt(scene, i, t);
    }
  }
  return scene.headline?.semanticId === semanticId ? elementStateAt(scene, -1, t) : null;
}

/** Compact, JSON-friendly snapshot used in event evidence (before/at/after). */
export interface StateSnapshot {
  semanticId: string | null;
  primitive: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  reveal: number;
  progress: number | null;
  attachedTo: string | null;
  visible: boolean;
}

export function snapshotOf(state: ElementState | null): StateSnapshot | null {
  if (!state) return null;
  return {
    semanticId: state.semanticId,
    primitive: state.primitive,
    x: state.x,
    y: state.y,
    scale: state.scale,
    rotation: state.rotation,
    opacity: state.opacity,
    reveal: state.reveal,
    progress: state.progress,
    attachedTo: state.attachedTo,
    visible: state.visible,
  };
}

export { NEUTRAL_EXECUTION };
