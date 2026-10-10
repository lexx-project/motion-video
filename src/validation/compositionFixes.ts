import { resolveExecutionPlan } from "./executionPlan";
import { validateScene } from "./validate";
import type { SceneSpec } from "./schema";

/**
 * DETERMINISTIC COMPOSITION FIXES (Batch G / WS-A + WS-C).
 *
 * Two confirmed live-run defects are corrected at composition time with narrow,
 * deterministic rules - no model call, no layout invention:
 *
 *   1. ENTER/FDE masked by entrance delay: an element targeted by a timed enter/fade
 *      event whose declared `delay` lands AFTER the event can never become visible
 *      (inner motion holds opacity at 0 while the executor ramps). The delay is
 *      clamped so the inner entrance has begun by the end of the event window.
 *   2. Static attachTo duplicating a timed attach event: an element statically attached
 *      to the same parent an attach event targets makes the event a guaranteed no-op
 *      (state delta on -> on), which the semantic gate honestly reports as
 *      event_not_executed. The static binding is removed so the TIMED event performs
 *      the attachment when the storyboard promised it.
 *
 * Both fixes are idempotent, preserve every storyboard promise, and refuse to apply
 * when the resulting scene would fail schema validation (the original is returned).
 */

export interface CompositionFix {
  sceneId: string;
  kind: "delay_clamped" | "attach_dedup";
  target: string;
  before: number | string;
  after: number | string;
  evidence: string;
}

export interface CompositionFixResult {
  scene: SceneSpec;
  fixes: CompositionFix[];
  /** true when the scene bytes changed */
  applied: boolean;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Apply the deterministic composition corrections to one scene. Pure: the input scene
 * is never mutated; the candidate is schema-validated before it is returned, and the
 * original scene is returned untouched if validation fails.
 */
export function applyCompositionFixes(scene: SceneSpec): CompositionFixResult {
  if (!scene.storyboard || !Array.isArray(scene.elements)) {
    return { scene, fixes: [], applied: false };
  }
  const plan = scene.executionPlan ?? resolveExecutionPlan(scene);
  const candidate = clone(scene) as unknown as Record<string, unknown>;
  const elements = candidate.elements as Record<string, unknown>[];
  const fixes: CompositionFix[] = [];

  const elementBySid = (sid: unknown): Record<string, unknown> | undefined =>
    typeof sid === "string" ? elements.find((e) => e.semanticId === sid) : undefined;

  for (const ev of plan.events) {
    const el = elementBySid(ev.target);
    if (!el) continue;

    // 1. enter/fade masked by a later entrance delay
    if (ev.type === "enter" || ev.type === "fade") {
      const delay = typeof el.delay === "number" ? el.delay : 0;
      const eventStart = Math.max(0, ev.atSeconds - ev.durationSec);
      if (delay > eventStart) {
        fixes.push({
          sceneId: scene.sceneId,
          kind: "delay_clamped",
          target: String(ev.target),
          before: delay,
          after: eventStart,
          evidence: `entrance delay ${delay}s starts after ${ev.type} event ${ev.id} window start ${eventStart.toFixed(2)}s - the event could never be seen`,
        });
        el.delay = eventStart;
      }
    }

    // 2. static attachTo duplicating a timed attach event to the same parent
    if (ev.type === "attach" && typeof ev.destination === "string" && el.attachTo === ev.destination) {
      fixes.push({
        sceneId: scene.sceneId,
        kind: "attach_dedup",
        target: String(ev.target),
        before: el.attachTo as string,
        after: "(removed - attach event performs it)",
        evidence: `element was statically attached to ${ev.destination} AND attach event ${ev.id} targets the same parent - the timed event was a guaranteed no-op`,
      });
      delete el.attachTo;
    }
  }

  if (fixes.length === 0) return { scene, fixes: [], applied: false };

  const parsed = validateScene(candidate as unknown as SceneSpec, scene.sceneId);
  if (!parsed.success || !parsed.scene) {
    // never corrupt: original scene returned, fixes discarded
    return { scene, fixes: [], applied: false };
  }
  return { scene: parsed.scene, fixes, applied: true };
}
