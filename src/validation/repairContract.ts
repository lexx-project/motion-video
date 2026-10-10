import { z } from "zod";
import { composition, primitives } from "../core/designSystem";
import { validateScene } from "./validate";
import { collisionSemantics, HARD_COLLISION_RATIO } from "./collisionSemantics";
import { preRenderIssues } from "./preRenderGate";
import { executionPlanSchema, isSupportedEventType, EVENT_EASINGS, EVENT_ACTION, promisedEventId } from "./executionPlan";
import { elementSchema } from "./schema";
import { isKnownPrimitive } from "../core/designSystem";
import { assessSemanticCategory } from "./semanticCategories";
import type { SceneSpec } from "./schema";
import type { FailureType } from "../agents/repairContext";
import { isSemanticFailure } from "../agents/repairContext";

/**
 * Targeted repair contract (Batch C / §6 + §7, extended by Batch D / §23-§25).
 *
 * The repair model never returns a scene, never returns code and never sees the whole project:
 * it returns a TINY structured proposal (sceneId + changes + preserve). Code applies it
 * deterministically, then proves it is narrow:
 *   - only allow-listed properties for this failure type may change,
 *   - values are checked against the design-system ParamSpecs (enum/range),
 *   - everything not named must be byte-identical,
 *   - the candidate must still validate and must not introduce a new hard failure,
 *   - SEMANTIC (Batch D): the candidate must still contain every baseline semantic id,
 *     every baseline plan event and the unchanged storyboard - "pass by deletion" is
 *     structurally impossible (§24/§25).
 *
 * `scriptedRepairProvider` lives in repairProviders.ts so tests/E2E can drive this contract
 * without a model; production uses `llmRepairProvider`.
 */

export const repairProposalSchema = z
  .object({
    sceneId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    reason: z.string().min(3).max(400),
    changes: z
      .array(
        z
          .object({
            target: z.string().min(1).max(60),
            property: z.string().min(1).max(40),
            from: z.union([z.string(), z.number(), z.null()]).optional(),
            /** object payloads are only valid for addElement / addEvent (validated below) */
            to: z.union([z.string(), z.number(), z.record(z.unknown())]),
          })
          .strict(),
          )
      .min(1)
      .max(8),
    preserve: z.array(z.string().max(200)).min(1).max(12),
  })
  .strict();

export type RepairProposal = z.infer<typeof repairProposalSchema>;

/** Properties a repair may touch, per failure type (Batch C §7 allow-list + Batch D §23). */
export const ALLOWED_PROPERTIES: Record<FailureType, string[]> = {
  layout_clip: ["position", "offsetX", "offsetY", "scale", "size", "lengthPct", "thicknessPx", "diameterPct", "rotation", "order"],
  safe_area_overflow: ["position", "offsetX", "offsetY", "scale", "size", "lengthPct", "thicknessPx", "diameterPct", "rotation"],
  empty_visual_band: ["position", "offsetX", "offsetY", "scale", "size", "opacity", "lengthPct", "thicknessPx", "diameterPct"],
  unreadable_text: ["scale", "size", "opacity"],
  unintended_collision: ["position", "offsetX", "offsetY", "scale", "size", "collisionIntent", "order"],
  timing_issue: ["delay", "emphasisAt"],
  // Batch D: semantic repairs are structural but surgical
  missing_semantic_object: ["addElement"],
  // Batch E: swap the incompatible primitive for a category-compatible one
  category_mismatch: ["primitive"],
  missing_event: ["addEvent"],
  event_not_executed: ["event.toOffsetX", "event.toOffsetY", "event.to", "event.from", "event.destination", "event.durationSec", "event.easing"],
  event_timing_mismatch: ["event.atSeconds"],
  state_transition_failed: ["event.to", "event.toOffsetX", "event.toOffsetY", "event.from", "event.durationSec", "attachTo"],
  relationship_failed: ["attachTo", "event.destination", "event.toOffsetX", "event.toOffsetY", "offsetX", "offsetY", "position"],
  unsupported_event: ["event.type"],
  novelty_fixture: ["position", "offsetX", "offsetY", "scale", "size", "rotation", "accent", "variant", "composition"],
  judge_issue: ["position", "offsetX", "offsetY", "scale", "size", "opacity", "rotation", "accent", "text", "align"],
  unknown: ["position", "offsetX", "offsetY", "scale", "size", "opacity", "rotation"],
};

/** Scene-level properties a repair may ever touch (duration is never allow-listed). */
const SCENE_LEVEL_PROPERTIES = new Set(["composition", "purpose", "visualConcept", "addElement", "addEvent"]);

export interface ProposalValidation {
  ok: boolean;
  errors: string[];
  /** candidate scene when ok */
  scene?: SceneSpec;
}

interface ResolvedTarget {
  kind: "scene" | "headline" | "element" | "order" | "event";
  index?: number;
  object: Record<string, unknown> | null;
}

export function resolveTarget(scene: SceneSpec, target: string): ResolvedTarget | { error: string } {
  const t = target.trim();
  if (t === "scene") return { kind: "scene", object: scene as unknown as Record<string, unknown> };
  if (t === "headline") {
    if (!scene.headline) return { error: `target "${target}" but the scene has no headline` };
    return { kind: "headline", object: scene.headline as unknown as Record<string, unknown> };
  }
  // Batch D: execution plan event (`events:event_03`)
  const ev = /^events?[:\s]+(.+)$/i.exec(t);
  if (ev) {
    const id = ev[1].trim();
    const plan = scene.executionPlan as { events?: Record<string, unknown>[] } | undefined;
    const idx = (plan?.events ?? []).findIndex((e) => e.id === id);
    if (idx < 0) return { error: `target "${target}" but the execution plan has no event "${id}"` };
    return { kind: "event", index: idx, object: (plan!.events as Record<string, unknown>[])[idx] };
  }
  const m = /^(?:elements?|el)[:\[\s]*(\d+)\]?$/i.exec(t) ?? /^(\d+)$/.exec(t);
  if (m) {
    const idx = parseInt(m[1], 10);
    const el = (scene.elements ?? [])[idx];
    if (!el) return { error: `target "${target}" - scene has no element at index ${idx}` };
    return { kind: "element", index: idx, object: el as unknown as Record<string, unknown> };
  }
  // Batch D: bare semantic id (`person_01`) resolves to its element
  const semIdx = (scene.elements ?? []).findIndex(
    (el) => typeof (el as { semanticId?: string }).semanticId === "string" && (el as { semanticId?: string }).semanticId === t,
  );
  if (semIdx >= 0) {
    return { kind: "element", index: semIdx, object: (scene.elements as unknown as Record<string, unknown>[])[semIdx] };
  }
  return {
    error: `unrecognised target "${target}" (expected "scene", "headline", "elements:<index>", "events:<eventId>" or a semantic id like person_01)`,
  };
}

function paramSpecFor(element: Record<string, unknown>, property: string) {
  const common = (primitives.common as Record<string, { type: string } | undefined>)[property];
  if (common) return common as never;
  const name = typeof element.primitive === "string" ? element.primitive : "";
  const def = (primitives.primitives as Record<string, { params: Record<string, { type: string }> } | undefined>)[name];
  return def?.params?.[property] as never;
}

function checkParamValue(
  spec: { type: string; values?: string[]; min?: number; max?: number } | undefined,
  value: unknown,
): string | null {
  if (!spec) return `unknown property`;
  switch (spec.type) {
    case "enum":
      if (typeof value !== "string" || !(spec.values ?? []).includes(value))
        return `expected one of ${(spec.values ?? []).join("|")}`;
      return null;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "expected a number";
      if (typeof spec.min === "number" && value < spec.min) return `below minimum ${spec.min}`;
      if (typeof spec.max === "number" && value > spec.max) return `above maximum ${spec.max}`;
      return null;
    }
    case "string":
      if (typeof value !== "string") return "expected a string";
      if (typeof spec.max === "number" && value.length > spec.max) return `longer than ${spec.max} chars`;
      return null;
    case "boolean":
      if (typeof value !== "boolean") return "expected a boolean";
      return null;
    default:
      return null;
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Value rules for execution-plan event properties (Batch D §23). */
function checkEventValue(prop: string, value: unknown, scene: SceneSpec): string | null {
  switch (prop) {
    case "atSeconds": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "expected a number";
      if (value < 0.05) return "below minimum 0.05 (an event needs a pre-state to be provable)";
      if (value > scene.duration) return `above scene duration ${scene.duration}s`;
      return null;
    }
    case "toOffsetX":
    case "toOffsetY": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "expected a number";
      if (value < -100 || value > 100) return "outside [-100, 100]";
      return null;
    }
    case "to":
    case "from": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "expected a finite number";
      return null;
    }
    case "durationSec": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "expected a number";
      if (value < 0.05 || value > 5) return "outside [0.05, 5] seconds";
      return null;
    }
    case "easing": {
      if (typeof value !== "string" || !(EVENT_EASINGS as readonly string[]).includes(value)) {
        return `expected one of ${EVENT_EASINGS.join("|")}`;
      }
      return null;
    }
    case "destination": {
      if (typeof value !== "string" || !value.trim()) return "expected a semantic id string";
      if (value.length > 40) return "longer than 40 chars";
      return null;
    }
    case "type": {
      if (typeof value !== "string" || !value.trim()) return "expected an event type string";
      if (!isSupportedEventType(value)) return `unsupported event type "${value}" (a repair must move to a SUPPORTED type)`;
      return null;
    }
    default:
      return `unknown event property "${prop}"`;
  }
}

/** Fill deterministic defaults on a proposed plan event (apply runs before schema re-parse). */
function normalizePlanEvent(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ev = { ...(raw as Record<string, unknown>) };
  if (typeof ev.type !== "string" || !ev.type) return null;
  if (typeof ev.id !== "string" || !ev.id) return null;
  if (typeof ev.target !== "string" || !ev.target) return null;
  if (typeof ev.atSeconds !== "number" || !Number.isFinite(ev.atSeconds)) return null;
  if (typeof ev.durationSec !== "number") ev.durationSec = 0.35;
  if (typeof ev.easing !== "string") ev.easing = "easeInOut";
  if (typeof ev.provenance !== "string") ev.provenance = "explicit";
  if (typeof ev.action !== "string") {
    ev.action =
      ev.type === "enter"
        ? "appear"
        : ev.type === "exit"
          ? "disappear"
          : ev.type === "move"
            ? "moveTo"
            : ev.type === "scale"
              ? "setScale"
              : ev.type === "rotate"
                ? "setRotation"
                : ev.type === "fade"
                  ? "setOpacity"
                  : ev.type === "replace"
                    ? "replaceWith"
                    : ev.type === "reveal"
                      ? "reveal"
                      : ev.type === "progress"
                        ? "advanceTo"
                        : ev.type === "attach"
                          ? "attachTo"
                          : ev.type === "detach"
                            ? "detachFrom"
                            : "unsupported";
  }
  return ev;
}

/** Apply a validated proposal to a scene (pure - returns a new object). */
export function applyRepairProposal(scene: SceneSpec, proposal: RepairProposal): SceneSpec {
  const next = clone(scene) as unknown as Record<string, unknown>;
  const elements = next.elements as Record<string, unknown>[];
  for (const change of proposal.changes) {
    // resolve against the CLONE so the input scene is never mutated
    const resolved = resolveTarget(next as unknown as SceneSpec, change.target);
    if ("error" in resolved) continue;
    if (resolved.kind === "scene") {
      if (change.property === "order") {
        const idx = Number(change.to);
        if (Number.isInteger(idx) && idx >= 0 && idx < elements.length) {
          const [moved] = elements.splice(idx, 1);
          elements.splice(Math.max(0, Math.min(elements.length, Number(change.from ?? 0))), 0, moved);
        }
        continue;
      }
      if (change.property === "addElement" && change.to && typeof change.to === "object" && !Array.isArray(change.to)) {
        elements.push({ ...(change.to as Record<string, unknown>) });
        continue;
      }
      if (change.property === "addEvent" && change.to && typeof change.to === "object" && !Array.isArray(change.to)) {
        const ev = normalizePlanEvent(change.to);
        if (!ev) continue;
        const plan = (next.executionPlan ?? null) as { schema?: string; events?: Record<string, unknown>[] } | null;
        if (plan && Array.isArray(plan.events)) plan.events.push(ev);
        else next.executionPlan = { schema: "execution-plan/1", events: [ev] };
        continue;
      }
      next[change.property] = change.to;
      continue;
    }
    if (change.property === "order") continue;
    const target = resolved.object as Record<string, unknown>;
    const prop =
      resolved.kind === "event" && change.property.startsWith("event.")
        ? change.property.slice("event.".length)
        : change.property;
    // Batch D §23: an event TYPE is the storyboard promise itself - change it there
    // (narrow exception to storyboard immutability, only reachable via unsupported_event)
    // and keep the plan in sync. Everything else in the storyboard stays byte-identical.
    if (resolved.kind === "event" && prop === "type" && typeof change.to === "string") {
      target.type = change.to;
      target.action = EVENT_ACTION[change.to] ?? "unsupported";
      const sb = next.storyboard as
        | { motionBeats?: { id?: string; eventType?: string }[] }
        | undefined;
      const eventId = String(target.id ?? "");
      if (sb && Array.isArray(sb.motionBeats)) {
        for (const [i, beat] of sb.motionBeats.entries()) {
          const id = beat.id ?? `event_${String(i + 1).padStart(2, "0")}`;
          if (id === eventId) {
            beat.eventType = change.to;
            break;
          }
        }
      }
      continue;
    }
    target[prop] = change.to;
  }
  return next as unknown as SceneSpec;
}

const keyOf = (el: unknown): string => `${(el as { primitive?: string }).primitive ?? "?"}|${sha(el)}`;
const sha = (v: unknown): string => {
  const s = JSON.stringify(v);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `${h}:${s.length}`;
};

/**
 * Validate a proposal against the contract. Returns actionable errors instead of throwing so
 * the loop can record a structured rejection.
 *
 * `opts.implicated` narrows the repair to the objects the failure actually named (Batch C §7):
 * when the failure identifies element indices, changes to any other element are rejected; when
 * the failure is region-scoped (e.g. a dead band) any element in the scene may be adjusted.
 */
export function validateRepairProposal(
  scene: SceneSpec,
  proposal: RepairProposal,
  failureType: FailureType,
  opts: { implicated?: string[] } = {},
): ProposalValidation {
  const errors: string[] = [];

  if (proposal.sceneId !== scene.sceneId) {
    errors.push(`proposal targets "${proposal.sceneId}" but the failure belongs to "${scene.sceneId}"`);
    return { ok: false, errors };
  }

  const allowed = new Set(ALLOWED_PROPERTIES[failureType] ?? ALLOWED_PROPERTIES.unknown);
  const semanticMode = isSemanticFailure(failureType);
  const implicatedIdx = new Set<number>();
  let implicatedHeadline = false;
  let regionScoped = false;
  for (const t of opts.implicated ?? []) {
    const explicit = /^(?:elements?|el)\s*[:\[\s]\s*(\d+)\]?$/i.exec(t.trim());
    const rendererId = /^[A-Za-z]+\[(\d+)\]/.exec(t);
    const bare = /^(\d+)$/.exec(t.trim());
    const idx = explicit?.[1] ?? rendererId?.[1] ?? bare?.[1];
    if (idx !== undefined) implicatedIdx.add(parseInt(idx, 10));
    else if (/headline/i.test(t)) implicatedHeadline = true;
    else regionScoped = true; // region-only evidence (side/band) - do not over-constrain
  }
  const scoped = implicatedIdx.size > 0 || implicatedHeadline;
  if ((opts.implicated ?? []).length === 0) regionScoped = true;

  // Batch D: semantic failures name EVENT ids and OBJECT semantic ids (never indices)
  const implicatedEventIds = new Set<string>();
  const implicatedObjectIds = new Set<string>();
  if (semanticMode) {
    for (const t of opts.implicated ?? []) {
      if (/^event_/.test(t)) implicatedEventIds.add(t);
      else if (t && !/^\d+$/.test(t) && !/^elements?/i.test(t) && !/headline/i.test(t)) implicatedObjectIds.add(t);
    }
  }

  const targetedIndices = new Set<number>();
  let wantsAddElement = false;
  let wantsAddEvent = false;

  for (const change of proposal.changes) {
    const resolved = resolveTarget(scene, change.target);
    if ("error" in resolved) {
      errors.push(resolved.error);
      continue;
    }
    if (resolved.kind !== "event" && typeof resolved.index === "number") {
      if (scoped && !regionScoped && !implicatedIdx.has(resolved.index)) {
        errors.push(
          `target ${change.target} is unrelated to this failure (implicated: ${
            [...implicatedIdx].map((i) => `elements:${i}`).join(", ") || "headline"
          })`,
        );
        continue;
      }
    }
    if (resolved.kind === "headline" && scoped && !regionScoped && !implicatedHeadline) {
      errors.push("target headline is unrelated to this failure");
      continue;
    }
    // allow-list accepts both "event.atSeconds" and bare "atSeconds" on an event target
    const bareProp =
      resolved.kind === "event" && change.property.startsWith("event.") ? change.property.slice("event.".length) : change.property;
    if (!allowed.has(change.property) && !allowed.has(`event.${bareProp}`)) {
      errors.push(`property "${change.property}" is not allowed for ${failureType} (allowed: ${[...allowed].join(", ")})`);
      continue;
    }
    if (resolved.kind === "scene") {
      if (change.property === "addElement") {
        wantsAddElement = true;
        if (failureType !== "missing_semantic_object") {
          errors.push(`addElement is only allowed for missing_semantic_object (this failure is ${failureType})`);
          continue;
        }
        const obj = change.to;
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
          errors.push("addElement.to must be the full new element object (JSON object)");
          continue;
        }
        const parsedEl = elementSchema.safeParse(obj);
        if (!parsedEl.success) {
          errors.push(`addElement: invalid element - ${parsedEl.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
          continue;
        }
        const sid = (obj as { semanticId?: unknown }).semanticId;
        if (typeof sid !== "string" || !sid) {
          errors.push('addElement must carry semanticId="<missing id>" so the contract can resolve it');
          continue;
        }
        if (implicatedObjectIds.size > 0 && !implicatedObjectIds.has(sid)) {
          errors.push(`addElement semanticId "${sid}" is not the missing object (missing: ${[...implicatedObjectIds].join(", ")})`);
          continue;
        }
        if ((scene.elements ?? []).some((el) => (el as { semanticId?: string }).semanticId === sid)) {
          errors.push(`addElement: an element with semanticId "${sid}" already exists (no-op repair)`);
          continue;
        }
        // Batch E Phase 6: a missing object may never be "satisfied" by an obviously
        // incompatible primitive (Person-for-gate is rejected before any render)
        const promisedObject = (scene.storyboard?.semanticObjects ?? []).find((o) => o.id === sid);
        if (promisedObject) {
          const assessment = assessSemanticCategory({
            objectType: promisedObject.objectType,
            semanticRole: promisedObject.semanticRole,
            primitive: String((obj as { primitive?: unknown }).primitive ?? ""),
          });
          if (assessment.status === "fail") {
            errors.push(`addElement: incompatible primitive for promised object "${sid}" (${promisedObject.objectType}) - ${assessment.reason}`);
            continue;
          }
        }
        continue;
      }
      if (change.property === "addEvent") {
        wantsAddEvent = true;
        if (failureType !== "missing_event") {
          errors.push(`addEvent is only allowed for missing_event (this failure is ${failureType})`);
          continue;
        }
        const obj = change.to;
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
          errors.push("addEvent.to must be the full plan event object (JSON object)");
          continue;
        }
        const parsedPlan = executionPlanSchema.safeParse({ schema: "execution-plan/1", events: [obj] });
        if (!parsedPlan.success) {
          errors.push(`addEvent: invalid plan event - ${parsedPlan.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
          continue;
        }
        const evId = String((obj as { id?: unknown }).id);
        const existing = ((scene.executionPlan as { events?: { id: string }[] } | undefined)?.events ?? []).some((e) => e.id === evId);
        if (existing) {
          errors.push(`addEvent: event "${evId}" already exists in the plan (no-op repair)`);
          continue;
        }
        if (implicatedEventIds.size > 0 && !implicatedEventIds.has(evId)) {
          errors.push(`addEvent id "${evId}" is not the missing event (missing: ${[...implicatedEventIds].join(", ")})`);
          continue;
        }
        const at = Number((obj as { atSeconds?: unknown }).atSeconds);
        if (!Number.isFinite(at) || at < 0.05 || at > scene.duration) {
          errors.push(`addEvent: atSeconds ${String((obj as { atSeconds?: unknown }).atSeconds)} must be within [0.05, ${scene.duration}]s`);
          continue;
        }
        continue;
      }
      if (change.property === "composition") {
        if (typeof change.to !== "string" || !composition.grammars.includes(change.to)) {
          errors.push(`composition "${String(change.to)}" is not a known grammar`);
          continue;
        }
      } else if (!SCENE_LEVEL_PROPERTIES.has(change.property)) {
        errors.push(`scene-level property "${change.property}" is not allow-listed`);
        continue;
      }
    } else if (resolved.kind === "event") {
      const eventId = String((resolved.object as { id?: unknown } | null)?.id ?? "");
      if (semanticMode && implicatedEventIds.size > 0 && !implicatedEventIds.has(eventId)) {
        errors.push(`target ${change.target} is unrelated to this failure (implicated events: ${[...implicatedEventIds].join(", ")})`);
        continue;
      }
      const problem = checkEventValue(bareProp, change.to, scene);
      if (problem) {
        errors.push(`${change.target}.${change.property}: ${problem}`);
        continue;
      }
      const current = (resolved.object as Record<string, unknown>)[bareProp];
      if (JSON.stringify(current) === JSON.stringify(change.to)) {
        errors.push(`${change.target}.${change.property} is already ${JSON.stringify(change.to)} (no-op repair)`);
        continue;
      }
      continue; // event changes never touch element indices
    } else if (resolved.kind === "element" || resolved.kind === "headline") {
      // Batch D: semantic failures only allow changes to the objects they named
      if (semanticMode && resolved.kind === "element" && implicatedObjectIds.size > 0) {
        const sid = (resolved.object as { semanticId?: string } | null)?.semanticId;
        if (!sid || !implicatedObjectIds.has(sid)) {
          errors.push(
            `target ${change.target} is unrelated to this failure (implicated: ${[...implicatedObjectIds].join(", ")})`,
          );
          continue;
        }
      }
      // Batch E Phase 6: primitive replacement (category_mismatch only)
      if (change.property === "primitive") {
        if (failureType !== "category_mismatch") {
          errors.push(`property "primitive" is not allowed for ${failureType} (allowed: ${[...allowed].join(", ")})`);
          continue;
        }
        const next = change.to;
        if (typeof next !== "string" || !isKnownPrimitive(next)) {
          errors.push(`primitive "${String(next)}" is not a registered primitive`);
          continue;
        }
        const currentPrimitive = (resolved.object as { primitive?: string } | null)?.primitive;
        if (currentPrimitive === next) {
          errors.push(`${change.target}.primitive is already "${next}" (no-op repair)`);
          continue;
        }
        const sid = (resolved.object as { semanticId?: string } | null)?.semanticId;
        const promisedObject =
          typeof sid === "string" && sid ? (scene.storyboard?.semanticObjects ?? []).find((o) => o.id === sid) : undefined;
        if (promisedObject) {
          const assessment = assessSemanticCategory({
            objectType: promisedObject.objectType,
            semanticRole: promisedObject.semanticRole,
            primitive: next,
          });
          if (assessment.status === "fail") {
            errors.push(`${change.target}.primitive: replacement is still incompatible - ${assessment.reason}`);
            continue;
          }
        }
        if (typeof resolved.index === "number") targetedIndices.add(resolved.index);
        continue;
      }
      if (change.property === "order") {
        const to = Number(change.to);
        if (!Number.isInteger(to) || to < 0 || to >= (scene.elements?.length ?? 0)) {
          errors.push(`${change.target}.order: target index ${change.to} is out of range`);
          continue;
        }
        targetedIndices.add(resolved.index ?? -1);
        continue;
      }
      const spec =
        resolved.kind === "element" ? paramSpecFor(resolved.object!, change.property) : headlineParamSpec(change.property);
      if (!spec) {
        errors.push(`property "${change.property}" does not exist on this ${resolved.kind}`);
        continue;
      }
      const problem = checkParamValue(spec as never, change.to);
      if (problem) {
        errors.push(`${change.target}.${change.property}: ${problem}`);
        continue;
      }
      const current = (resolved.object as Record<string, unknown>)[change.property];
      if (JSON.stringify(current) === JSON.stringify(change.to)) {
        errors.push(`${change.target}.${change.property} is already ${JSON.stringify(change.to)} (no-op repair)`);
        continue;
      }
    }
    if (resolved.kind === "element" && typeof resolved.index === "number") targetedIndices.add(resolved.index);
  }
  if (errors.length) return { ok: false, errors };

  const candidate = applyRepairProposal(scene, proposal);

  // structural validation (the scene must still be a legal scene)
  const check = validateScene(candidate, scene.sceneId);
  if (!check.success) {
    return { ok: false, errors: [`candidate failed validation: ${check.errors.join("; ")}`] };
  }

  // narrowness: every element the proposal did NOT target must still exist unchanged
  const beforeHashes = (scene.elements ?? []).map((el) => keyOf(el));
  const untouched = beforeHashes.filter((_, i) => !targetedIndices.has(i));
  const remaining = (candidate.elements ?? []).map((el) => keyOf(el));
  for (const h of untouched) {
    const at = remaining.indexOf(h);
    if (at < 0) {
      errors.push("repair modified an element that was not targeted");
      break;
    }
    remaining.splice(at, 1);
  }
  if (candidate.duration !== scene.duration) errors.push("repair changed the scene duration");
  if (candidate.purpose !== scene.purpose) errors.push("repair changed scene.purpose");
  if (candidate.visualConcept !== scene.visualConcept) errors.push("repair changed scene.visualConcept");
  if (JSON.stringify(candidate.motion) !== JSON.stringify(scene.motion)) errors.push("repair changed the motion family");
  // Storyboard immutability (§25). Narrow exception: for `unsupported_event` the targeted
  // beat's eventType may move to a supported type - every other byte must match.
  const typeChangedIds = new Set(
    proposal.changes
      .filter((c) => (c.property === "event.type" || c.property === "type") && c.target.startsWith("event"))
      .map((c) => {
        const m = /^events?[:\s]+(.+)$/i.exec(c.target.trim());
        return m ? m[1].trim() : "";
      })
      .filter(Boolean),
  );
  const storyboardKey = (sb: unknown): string => {
    if (!sb || typeof sb !== "object") return "null";
    const clone = { ...(sb as Record<string, unknown>) };
    clone.motionBeats = ((clone.motionBeats as Record<string, unknown>[] | undefined) ?? []).map((b, i) =>
      typeChangedIds.size > 0 && typeChangedIds.has(promisedEventId(b as never, i))
        ? { ...b, eventType: "<type-change-allowed>" }
        : b,
    );
    return JSON.stringify(clone);
  };
  if (storyboardKey(candidate.storyboard) !== storyboardKey(scene.storyboard)) {
    errors.push("repair changed the storyboard (only the targeted event type may change, and only for unsupported_event)");
  }
  if (JSON.stringify(candidate.subtitle ?? null) !== JSON.stringify(scene.subtitle ?? null))
    errors.push("repair changed the subtitle contract");
  if (candidate.composition !== scene.composition && failureType !== "novelty_fixture")
    errors.push("repair changed the composition grammar");
  const elementDelta = (candidate.elements?.length ?? 0) - (scene.elements?.length ?? 0);
  if (elementDelta !== 0) {
    // Batch D §23: exactly ONE element may be added, and only to satisfy a missing object
    if (!(elementDelta === 1 && wantsAddElement && failureType === "missing_semantic_object")) {
      errors.push("repair added or removed elements (only property changes are allowed)");
    }
  }
  // Batch D §24/§25: requirements can never be deleted to make validation pass
  if (semanticMode) {
    const baseIds = (scene.elements ?? [])
      .map((el) => (el as { semanticId?: string }).semanticId)
      .filter((id): id is string => Boolean(id));
    if (scene.headline?.semanticId) baseIds.push(scene.headline.semanticId);
    const candIds = new Set(
      (candidate.elements ?? [])
        .map((el) => (el as { semanticId?: string }).semanticId)
        .filter((id): id is string => Boolean(id)),
    );
    if (candidate.headline?.semanticId) candIds.add(candidate.headline.semanticId);
    for (const id of baseIds) {
      if (!candIds.has(id)) {
        errors.push(`repair removed required semantic id "${id}" (storyboard requirements cannot be deleted to pass)`);
      }
    }
    const baseEvents = ((scene.executionPlan as { events?: { id: string }[] } | undefined)?.events ?? []).map((e) => e.id);
    const candEvents = new Set(
      ((candidate.executionPlan as { events?: { id: string }[] } | undefined)?.events ?? []).map((e) => e.id),
    );
    for (const id of baseEvents) {
      if (!candEvents.has(id)) {
        errors.push(`repair removed execution event "${id}" (events cannot be deleted to pass)`);
      }
    }
  }
  if (errors.length) return { ok: false, errors };

  // the repair must not introduce a NEW hard pre-render failure
  const hardKey = (i: { failureType: string; target?: string[] }): string =>
    `${i.failureType}|${(i.target ?? []).join(",")}`;
  const beforeHard = new Set(preRenderIssues(scene).filter((i) => i.severity === "hard").map(hardKey));
  for (const issue of preRenderIssues(candidate).filter((i) => i.severity === "hard")) {
    if (!beforeHard.has(hardKey(issue))) {
      errors.push(`repair introduces a new hard failure: ${hardKey(issue)} (${issue.evidence})`);
    }
  }
  // ...and must not create a fresh high-ratio unintended overlap
  const baseCollisions = collisionSemantics(scene).unintended.map((c) => `${c.a}|${c.b}`);
  for (const c of collisionSemantics(candidate).unintended) {
    if (c.ratio >= HARD_COLLISION_RATIO && !baseCollisions.includes(`${c.a}|${c.b}`)) {
      errors.push(`repair introduces an unintended overlap of ${Math.round(c.ratio * 100)}% (${c.a} x ${c.b})`);
    }
  }

  // NOTE (Batch D): new SEMANTIC failures are NOT rejected here. The contract proves
  // narrowness + requirement immutability; whether the candidate actually satisfies the
  // baseline storyboard promises is decided by the enactment evidence in the repair loop
  // (compareRepair -> KEEP / ROLLBACK), exactly like pixel evidence decides layout.

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], scene: candidate };
}

function headlineParamSpec(property: string): { type: string; values?: string[]; max?: number } | undefined {
  switch (property) {
    case "position":
      return {
        type: "enum",
        values: ["center", "left", "right", "top", "bottom", "topLeft", "topRight", "bottomLeft", "bottomRight"],
      };
    case "align":
      return { type: "enum", values: ["left", "center", "right"] };
    case "text":
      return { type: "string", max: 180 };
    default:
      return undefined;
  }
}
