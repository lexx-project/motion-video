import { completeJson } from "./llm";
import { repairContextBlock, type RepairContext, isSemanticFailure } from "./repairContext";
import { repairProposalSchema, type RepairProposal } from "../validation/repairContract";
import type { SceneSpec } from "../validation/schema";

/**
 * Repair providers (Batch C / §6, §15, §23 - extended by Batch D §35).
 *
 * The loop talks to a narrow interface; production uses `llmRepairProvider` (a SMALL prompt),
 * tests and E2E use `scriptedRepairProvider`. Test behaviour never leaks into production: the
 * pipeline imports only `llmRepairProvider`.
 */

export interface RepairProviderRequest {
  context: RepairContext;
  /** full prompt text (also used for the duplicate-prompt guard) */
  prompt: string;
}

export interface RepairProvider {
  name: string;
  propose(req: RepairProviderRequest): Promise<RepairProposal>;
}

/** Compact digest: only the properties a repair may touch (Batch C §15 prompt economy). */
export function sceneDigest(scene: SceneSpec, allowed: string[], opts: { semantic?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`scene=${scene.sceneId} composition=${scene.composition} duration=${scene.duration}s`);
  if (scene.headline) {
    const fields = ["position", "text", "align"].filter((f) => allowed.includes(f) || f === "text" || f === "position");
    const kept: Record<string, unknown> = {};
    for (const f of fields) kept[f] = (scene.headline as unknown as Record<string, unknown>)[f];
    lines.push(`headline: ${JSON.stringify(kept)}`);
  }
  // semantic repairs additionally see how existing elements are shaped (so a new element matches)
  const semanticFields = opts.semantic
    ? ["position", "scale", "size", "accent", "role", "purpose", "diameterPct", "label", "delay", "entrance"]
    : [];
  const keep = new Set([...allowed, "primitive", "text", "semanticId", "attachTo", ...semanticFields]);
  (scene.elements ?? []).forEach((el, i) => {
    const src = el as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = { primitive: src.primitive };
    for (const [k, v] of Object.entries(src)) {
      if (keep.has(k) && k !== "primitive") out[k] = v;
    }
    lines.push(`  ${i}: ${JSON.stringify(out)}`);
  });
  // Batch D: compact execution-plan digest (events are the repair target for semantic failures)
  const plan = scene.executionPlan as { events?: Record<string, unknown>[] } | undefined;
  if (plan?.events?.length) {
    lines.push("  plan:");
    for (const ev of plan.events) {
      const bits = [
        `${String(ev.id)} ${String(ev.type)} ${String(ev.target)} at ${String(ev.atSeconds)}s`,
        ev.destination ? `dest=${String(ev.destination)}` : "",
        typeof ev.to === "number" ? `to=${ev.to}` : "",
        typeof ev.from === "number" ? `from=${ev.from}` : "",
        typeof ev.toOffsetX === "number" ? `toX=${ev.toOffsetX}` : "",
        typeof ev.toOffsetY === "number" ? `toY=${ev.toOffsetY}` : "",
        typeof ev.durationSec === "number" ? `dur=${ev.durationSec}s` : "",
      ].filter(Boolean);
      lines.push(`    ${bits.join(" ")}`);
    }
  }
  // Batch E: what each promised object IS (category source - the contract checks compatibility)
  if (opts.semantic) {
    const promises = (scene.storyboard?.semanticObjects ?? [])
      .filter((o) => typeof o.id === "string" && o.id)
      .map((o) => `${o.id}=<${o.objectType}>`)
      .join(", ");
    if (promises) lines.push(`  promises: ${promises}`);
  }
  return lines.join("\n");
}

/** The complete (still small) prompt for a targeted repair. */
export function buildRepairPrompt(ctx: RepairContext, scene: SceneSpec): string {
  const semantic = isSemanticFailure(ctx.failureType);
  const rules = semantic
    ? 'Rules: 1-2 changes; target must be "scene" (property "addElement"/"addEvent" with the full JSON object), "events:<eventId>" (property "event.<name>") or a semantic id like person_01; property must be from the allowed list; for addElement copy a primitive + params style from the scene digest (registered primitives only - never invent one), the primitive MUST be able to represent the promised object type shown in "promises:" (a Person is never a gate; a Circle/Target is), and carry semanticId="<the missing id>"; do not delete or rewrite any element, event, relationship or the storyboard.'
    : 'Rules: 1-3 changes; target must be "scene", "headline" or "elements:<index>"; property must be from the allowed list; "to" must be a different value inside its design range; do not add, remove or rewrite elements.';
  return [
    "You are a TARGETED REPAIR module for a motion-design studio.",
    "Fix ONE measured defect with the smallest possible change. You do not write code and you never see the whole project.",
    "",
    repairContextBlock(ctx),
    "",
    semantic ? "# Scene digest (existing elements + plan; change only what the allowed list names)" : "# Scene digest (only properties you may change are listed)",
    sceneDigest(scene, ctx.allowedProperties, { semantic }),
    "",
    'Return ONLY JSON: {"sceneId":"...","reason":"...","changes":[{"target":"elements:0","property":"scale","from":2.2,"to":1.85}],"preserve":["..."]}',
    rules,
  ].join("\n");
}

/** Production provider: one small structured LLM call. */
export const llmRepairProvider: RepairProvider = {
  name: "llm",
  async propose(req) {
    const ctx = req.context;
    return completeJson<RepairProposal>({
      stage: "repair",
      temperature: 0.2,
      maxTokens: 900,
      attempts: 2,
      reasoningEffort: "minimal",
      system:
        "You output ONLY a compact JSON repair proposal. No prose, no code, no scene rewrite. " +
        "You are given a measured failure, the allowed properties and a digest of the scene: propose the minimum change.",
      user: req.prompt,
      parse: (obj) => repairProposalSchema.parse(obj),
    });
  },
};

export type ScriptedStep =
  | { proposal: RepairProposal }
  | { error: string }
  | { stall: true };

/**
 * Deterministic provider for tests/E2E (Batch C §23). It consumes one step per call and fails
 * loudly when exhausted - which is what keeps test loops finite.
 */
export function scriptedRepairProvider(steps: ScriptedStep[]): RepairProvider {
  const queue = [...steps];
  return {
    name: "scripted",
    async propose(req) {
      const step = queue.shift() ?? { error: "scripted provider exhausted (no more steps)" };
      if ("stall" in step) {
        return new Promise<RepairProposal>(() => {
          /* never resolves - exercises the loop's timeout policy */
        });
      }
      if ("error" in step) throw new Error(step.error);
      if (step.proposal.sceneId !== req.context.sceneId) {
        throw new Error(
          `scripted proposal targets ${step.proposal.sceneId} but the failure belongs to ${req.context.sceneId}`,
        );
      }
      return step.proposal;
    },
  };
}
