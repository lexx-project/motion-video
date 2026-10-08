import { completeJson } from "./llm";
import { designBibleCompactPrompt, memoryPrompt, primitiveSpecsFor } from "./context";
import { markStage, writeJson, readJson } from "../core/projectStore";
import { stageError, type ErrorStage } from "../core/errors";
import { mechanisms } from "../core/designSystem";
import {
  storyboardCandidatesSchema,
  storyboardSelectionsSchema,
  storyboardSchema,
  type Storyboard,
  type StoryboardCandidates,
  type StoryboardSelections,
} from "../validation/storyboardSchema";
import type { Analysis, Beats } from "./schemas";
import type { TimingBeat, Timestamps } from "./scriptAnalyst";

/**
 * VISUAL STORYBOARD DIRECTOR (Phase 3 §6).
 * Designs semantic intent BEFORE primitive compilation: what is said → what the viewer must
 * understand → the strongest visual mechanism → objects/relationships/narrative/motion beats →
 * typography + subtitle plan. Candidates differ by MECHANISM, not by shape variants.
 */

const taxonomy = mechanisms.mechanisms.join(", ");

const storyboardFrame = (beat: { id: string; text: string; why?: string; emotion?: string }, analysis: Analysis): string =>
  [
    `# Beat ${beat.id}: "${beat.text}"`,
    beat.why ? `Why it matters: ${beat.why}` : "",
    beat.emotion ? `Emotion: ${beat.emotion}` : "",
    `# Script context: ${analysis.summary}`,
    `Key nouns: ${analysis.keyNouns.slice(0, 12).join(", ")}`,
    `Key verbs: ${analysis.keyVerbs.slice(0, 12).join(", ")}`,
    `Abstract concepts: ${analysis.abstractConcepts.slice(0, 8).join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");

/** Step 1: 3-5 mechanism-differentiated storyboard candidates. */
export async function runStoryboardCandidates(
  projectId: string,
  analysis: Analysis,
  beat: { id: string; text: string; why?: string; emotion?: string; abstractMeaning?: string },
): Promise<StoryboardCandidates> {
  return completeJson<StoryboardCandidates>({
    stage: "concepts" as ErrorStage,
    projectId,
    temperature: 0.8,
    maxTokens: 8000,
    system: `You are the VISUAL STORYBOARD DIRECTOR of a motion-design studio (Phase 3).
${designBibleCompactPrompt()}

${memoryPrompt(projectId)}

Mechanism taxonomy (choose one per candidate, or a clearly justified equivalent):
${taxonomy}

Before answering, work through: (1) what is being said (2) what it actually means (3) what the
viewer should understand (4) the strongest visual MECHANISM that physically demonstrates that
meaning (5) what changes over time.

RULES:
- Candidates must use DIFFERENT visual mechanisms (not shape variants of one idea).
- ENACTMENT over illustration: the visual event performs the meaning (labels change, objects
  separate, workloads accumulate, timelines advance). A person icon + arrow + headline is FORBIDDEN.
- Every candidate needs: id (c1..c5), visualMechanism (SHORT taxonomy label of 2-4 words, e.g. "socialPressure" - put any description in concept), concept (short name), compositionSketch,
  objects (symbolic primitives/actors needed), whyDifferent (how it differs from the others),
  strength (why it communicates without narration), complexity low|medium|high.
- Sparse composition does NOT mean sparse storytelling: plan the relationships the scene needs;
  density budget comes later.
Output ONLY JSON {"beatId":"${beat.id}","candidates":[...]}.`,
    user: storyboardFrame(beat, analysis),
    parse: (obj) => {
      const raw = Array.isArray((obj as { candidates?: unknown[] }).candidates)
        ? obj
        : Array.isArray(obj)
          ? { beatId: beat.id, candidates: obj }
          : { ...(obj as object), beatId: beat.id };
      const parsed = storyboardCandidatesSchema.parse(raw);
      const mechs = new Set(parsed.candidates.map((c) => c.visualMechanism));
      if (parsed.candidates.length >= 3 && mechs.size < 3) {
        throw stageError(
          "concepts",
          `Storyboard candidates must use at least 3 DIFFERENT visual mechanisms (got: ${[...mechs].join(", ")}). Regenerate with genuinely different mechanisms.`,
          { projectId, sceneId: beat.id, recoverable: true },
        );
      }
      return parsed;
    },
  });
}

export function normalizeStoryboardSelections(obj: unknown, beatId?: string): unknown {
  let o: Record<string, unknown> | null = Array.isArray(obj)
    ? { selections: obj }
    : (obj as Record<string, unknown>);
  if (o && !o.selections && ("selectedCandidateId" in o || "rejected" in o || "scores" in o)) {
    o = { selections: [o] };
  }
  if (o && Array.isArray(o.selections)) {
    let list = o.selections as Record<string, unknown>[];
    if (beatId) {
      const matching = list.filter((s) => !s.beatId || s.beatId === beatId);
      if (matching.length > 0) list = matching;
    }
    const defaultScores: Record<string, number> = {
      semanticRelevance: 7,
      viewerComprehension: 7,
      metaphorStrength: 7,
      visualStorytelling: 7,
      relationshipClarity: 7,
      motionOpportunity: 7,
      typographyHierarchy: 7,
      subtitleIntegration: 7,
      referenceConformance: 7,
      compositionQuality: 7,
      novelty: 7,
      semanticDensity: 7,
      antiSlop: 7,
    };
    list = list.slice(0, 1).map((s) => {
      const rawScores = (s.scores && typeof s.scores === "object" ? s.scores : {}) as Record<string, unknown>;
      const sanitizedScores: Record<string, number> = { ...defaultScores };
      for (const key of Object.keys(defaultScores)) {
        if (key in rawScores) {
          const val = Number(rawScores[key]);
          if (!Number.isNaN(val)) {
            sanitizedScores[key] = Math.max(0, Math.min(10, val));
          }
        }
      }
      const rawRationale =
        s.selectionRationale ??
        s.rationale ??
        s.reasoning ??
        s.reason ??
        "Selected candidate best aligns with semantic storytelling requirements.";
      let rationaleStr = String(rawRationale).trim();
      if (rationaleStr.length < 10) {
        rationaleStr = `${rationaleStr} (meets criteria)`;
      }
      if (rationaleStr.length > 900) {
        rationaleStr = rationaleStr.slice(0, 897) + "...";
      }

      const semanticMechanism =
        s.semanticMechanism ??
        rawScores.semanticMechanism ??
        undefined;

      return {
        beatId: beatId ?? (typeof s.beatId === "string" && s.beatId ? s.beatId : "beat_01"),
        selectedCandidateId: typeof s.selectedCandidateId === "string" ? s.selectedCandidateId : undefined,
        rejected: Boolean(s.rejected),
        rejectionReasons: Array.isArray(s.rejectionReasons) ? s.rejectionReasons.map(String) : undefined,
        directionForAlternatives: typeof s.directionForAlternatives === "string" ? s.directionForAlternatives : undefined,
        semanticMechanism: typeof semanticMechanism === "string" ? String(semanticMechanism).slice(0, 400) : undefined,
        scores: sanitizedScores,
        selectionRationale: rationaleStr,
      };
    });
    o = { selections: list };
  }
  return o;
}

export function normalizeStoryboard(obj: unknown, beatId?: string): unknown {
  if (!obj || typeof obj !== "object") return obj;
  const o = { ...(obj as Record<string, unknown>) };
  if (beatId && !o.beatId) o.beatId = beatId;
  if (typeof o.spokenMeaning === "string" && o.spokenMeaning.length > 550) {
    o.spokenMeaning = o.spokenMeaning.slice(0, 547) + "...";
  }
  if (typeof o.viewerTakeaway === "string" && o.viewerTakeaway.length > 450) {
    o.viewerTakeaway = o.viewerTakeaway.slice(0, 447) + "...";
  }
  if (typeof o.visualMechanism === "string" && o.visualMechanism.length > 110) {
    o.visualMechanism = o.visualMechanism.slice(0, 107) + "...";
  }
  if (typeof o.compositionIntent === "string" && o.compositionIntent.length > 750) {
    o.compositionIntent = o.compositionIntent.slice(0, 747) + "...";
  }
  if (typeof o.noveltyIntent === "string" && o.noveltyIntent.length > 450) {
    o.noveltyIntent = o.noveltyIntent.slice(0, 447) + "...";
  }
  if (o.subtitlePlan && typeof o.subtitlePlan === "object") {
    const sp = { ...(o.subtitlePlan as Record<string, unknown>) };
    sp.enabled = Boolean(sp.enabled ?? true);
    if (typeof sp.timing === "string" && sp.timing.length > 280) {
      sp.timing = sp.timing.slice(0, 277) + "...";
    }
    if (typeof sp.text === "string" && sp.text.length > 280) {
      sp.text = sp.text.slice(0, 277) + "...";
    }
    if (typeof sp.role === "string" && sp.role.length > 230) {
      sp.role = sp.role.slice(0, 227) + "...";
    }
    o.subtitlePlan = sp;
  }
  if (o.typographyPlan && typeof o.typographyPlan === "object") {
    const tp = { ...(o.typographyPlan as Record<string, unknown>) };
    if (typeof tp.headline === "string" && tp.headline.length > 110) {
      tp.headline = tp.headline.slice(0, 107) + "...";
    }
    if (Array.isArray(tp.emphasisWords)) {
      tp.emphasisWords = tp.emphasisWords.slice(0, 6).map((w) => String(w).slice(0, 55));
    }
    if (Array.isArray(tp.supportingText)) {
      tp.supportingText = tp.supportingText.slice(0, 6).map((w) => String(w).slice(0, 110));
    }
    o.typographyPlan = tp;
  }
  if (Array.isArray(o.visualNarrative)) {
    o.visualNarrative = o.visualNarrative.slice(0, 8).map((step, idx) => {
      const s = typeof step === "object" && step ? { ...(step as Record<string, unknown>) } : { order: idx + 1, action: "action", meaning: "meaning", visualEvidence: "evidence" };
      return {
        order: typeof s.order === "number" ? Math.max(1, Math.min(12, Math.round(s.order))) : idx + 1,
        action: String(s.action ?? "action").slice(0, 240),
        meaning: String(s.meaning ?? "meaning").slice(0, 240),
        visualEvidence: String(s.visualEvidence ?? "evidence").slice(0, 240),
      };
    });
  }
  if (Array.isArray(o.semanticObjects)) {
    o.semanticObjects = o.semanticObjects.slice(0, 10).map((item) => {
      const ob = typeof item === "object" && item ? { ...(item as Record<string, unknown>) } : { objectType: "Actor", semanticRole: "role", relationship: "relationship", importance: 3 };
      return {
        objectType: String(ob.objectType ?? "Actor").slice(0, 55),
        semanticRole: String(ob.semanticRole ?? "role").slice(0, 240),
        relationship: String(ob.relationship ?? "rel").slice(0, 190),
        importance: typeof ob.importance === "number" ? Math.max(1, Math.min(5, Math.round(ob.importance))) : 3,
      };
    });
  }
  if (Array.isArray(o.motionBeats)) {
    o.motionBeats = o.motionBeats.slice(0, 10).map((mb, idx) => {
      const m = (typeof mb === "object" && mb ? mb : {}) as Record<string, unknown>;
      return {
        order: typeof m.order === "number" ? Math.max(1, Math.min(12, Math.round(m.order))) : idx + 1,
        action: String(m.action ?? "motion").slice(0, 190),
        purpose: String(m.purpose ?? "purpose").slice(0, 190),
        atSeconds: typeof m.atSeconds === "number" ? m.atSeconds : undefined,
      };
    });
  }
  if (Array.isArray(o.visualEvidence)) {
    o.visualEvidence = o.visualEvidence.slice(0, 8).map((ve) => String(ve).slice(0, 280));
  }
  if (Array.isArray(o.forbiddenInterpretations)) {
    o.forbiddenInterpretations = o.forbiddenInterpretations.slice(0, 8).map((fi) => String(fi).slice(0, 280));
  }
  if (o.elementBudget && typeof o.elementBudget === "object") {
    const eb = { ...(o.elementBudget as Record<string, unknown>) };
    let min = typeof eb.min === "number" ? Math.round(eb.min) : 3;
    let max = typeof eb.max === "number" ? Math.round(eb.max) : 6;
    min = Math.max(1, Math.min(10, min));
    max = Math.max(1, Math.min(10, max));
    if (min > max) {
      const tmp = min;
      min = max;
      max = tmp;
    }
    o.elementBudget = { min, max };
  }
  if (Array.isArray(o.relationships) && o.relationships.length > 8) {
    o.relationships = o.relationships.slice(0, 8);
  }
  return o;
}

/** Step 2: Art Director picks with the 13 Phase-3 criteria; may reject all. */
export async function runStoryboardSelection(
  projectId: string,
  beatId: string,
  candidates: StoryboardCandidates["candidates"],
): Promise<StoryboardSelections> {
  return completeJson<StoryboardSelections>({
    stage: "artDirection" as ErrorStage,
    projectId,
    temperature: 0.4,
    maxTokens: 8000,
    system: `You are the ART DIRECTOR of a motion-design studio (Phase 3, 13 criteria).
${designBibleCompactPrompt()}

${memoryPrompt(projectId)}

Score EACH candidate 0-10 on exactly these keys: semanticRelevance, viewerComprehension,
metaphorStrength, visualStorytelling, relationshipClarity, motionOpportunity, typographyHierarchy,
subtitleIntegration, referenceConformance, compositionQuality, novelty, semanticDensity, antiSlop.
A scene must EXPLAIN THE NARRATION - aesthetic consistency alone never passes.
REJECT all (rejected=true + rejectionReasons + directionForAlternatives) if candidates are
generic, decorative, literal-without-meaning, overly complicated, hard to understand, off the
design bible, too similar to memory, or weak on semanticRelevance/viewerComprehension (<=4).
Otherwise pick exactly one selectedCandidateId; selectionRationale must cite the semanticMechanism - MAX 2 SENTENCES (keep it under ~600 chars; long rationales are rejected).
IMPORTANT: "scores" must contain ONLY numeric scores for the criteria. Do NOT place "semanticMechanism" or notes inside "scores".
Output ONLY JSON {"selections":[{"beatId":"${beatId}","selectedCandidateId":"c1","scores":{13 keys},"selectionRationale":"..."}]}.`,
    user: `# Beat ${beatId}\n\n# Candidates\n${JSON.stringify(candidates, null, 1)}`,
    parse: (obj) => storyboardSelectionsSchema.parse(normalizeStoryboardSelections(obj, beatId)),
  });
}

/** Step 3: expand the selected candidate into the full storyboard contract. */
export async function runStoryboardExpansion(
  projectId: string,
  analysis: Analysis,
  beat: { id: string; text: string; why?: string; emotion?: string; abstractMeaning?: string },
  timing: TimingBeat | undefined,
  candidate: { concept: string; visualMechanism: string; compositionSketch: string; objects: string[] },
  budget: { min: number; max: number },
): Promise<Storyboard> {
  return completeJson<Storyboard>({
    stage: "concepts" as ErrorStage,
    projectId,
    temperature: 0.5,
    maxTokens: 12000,
    system: `You are the VISUAL STORYBOARD DIRECTOR expanding a selected storyboard (Phase 3).
${designBibleCompactPrompt()}

${memoryPrompt(projectId)}

Produce the FULL storyboard - specific enough that a human understands it WITHOUT seeing a render:
"person stands between two groups; labels switch as the person repeats the action" level of
specificity, NOT "person + arrows".

Requirements:
- visualNarrative: ordered steps {order, action, meaning, visualEvidence} - what happens and why.
- semanticObjects: each needed actor/object with semanticRole (why it exists), relationship,
  importance 1-5. At least one relationship should ACT (interact), not merely coexist.
- relationships: from/to/relationship triples for interacting pairs.
- typographyPlan: headline (<=48 chars, fits the composition), emphasisWords (<=2), supportingText (<=4 short lines).
- subtitlePlan: enabled=true when the VO should be captioned (typical), text = a VERBATIM spoken
  fragment for this beat (<=160 chars - do not invent words), timing = which part of the beat,
  role = what the caption does (e.g. "spoken line", "punchline echo").
- motionBeats: ordered {order, action, purpose} - each motion answers "why is this moving?".
- compositionIntent: ONE OR TWO SENTENCES (max 500 chars) - how the frame should be composed.
- visualEvidence: what in the frame proves the meaning (each <= 250 chars).
- forbiddenInterpretations: what this must NOT degenerate into (e.g. "generic circle diagram").
- noveltyIntent: ONE SENTENCE (max 350 chars) on how this stays distinct from memory.
- elementBudget {min,max} within ${budget.min}-${budget.max}
  (simple 3-5 / normal 5-8 / complex 7-10 meaningful elements; 3 meaningful > 10 decorative).
VERBOSITY KILLS: these prose fields must be short - long fields are rejected and the whole
generation fails. Output ONLY JSON matching the storyboard contract (strict keys).`,
    user: `${storyboardFrame(beat, analysis)}\n\n# Selected candidate\n${JSON.stringify(candidate, null, 1)}${timing ? `\n\n# Beat timing: ${timing.start.toFixed(2)}s-${timing.end.toFixed(2)}s (${timing.source})` : ""}`,
    parse: (obj) => storyboardSchema.parse(normalizeStoryboard(obj, beat.id)),
  });
}

/** Full storyboard stage: candidates → selection (reject loop) → expansion, per beat. */
export async function runStoryboardStage(
  projectId: string,
  analysis: Analysis,
  beats: Beats,
  beatsWithTiming: TimingBeat[],
  budgetFor: (beatId: string) => { min: number; max: number },
  onProgress?: (detail: string) => void,
): Promise<Storyboard[]> {
  markStage(projectId, "concepts", "running");
  try {
    const allCandidates: StoryboardCandidates[] = [];
    const allSelections: StoryboardSelections["selections"] = [];
    const storyboards: Storyboard[] = [];

    for (const [i, beat] of beats.beats.entries()) {
      onProgress?.(`beat ${beat.id} (${i + 1}/${beats.beats.length})`);
      const existingSb = readJson<Storyboard>(projectId, `scenes/storyboard-${beat.id}.json`);
      if (existingSb && existingSb.beatId === beat.id && existingSb.visualMechanism) {
        storyboards.push(existingSb);
        continue;
      }
      let direction: string | undefined;
      let chosen: StoryboardCandidates["candidates"][number] | null = null;
      for (let round = 1; round <= 2 && !chosen; round++) {
        const cands = await runStoryboardCandidates(projectId, analysis, beat);
        allCandidates.push(cands);
        const sel = await runStoryboardSelection(projectId, beat.id, cands.candidates);
        const s = sel.selections[0];
        allSelections.push(s);
        if (s && s.rejected !== true && s.selectedCandidateId) {
          chosen = cands.candidates.find((c) => c.id === s.selectedCandidateId) ?? null;
        } else {
          direction = [...(s?.rejectionReasons ?? []), s?.directionForAlternatives ?? ""].join("; ");
        }
        if (!chosen && round === 2) chosen = cands.candidates[0]; // budget fallback + note
      }
      if (!chosen) {
        throw stageError("concepts", `No storyboard candidate for beat ${beat.id}`, {
          projectId,
          sceneId: beat.id,
          recoverable: false,
        });
      }
      const sb = await runStoryboardExpansion(
        projectId,
        analysis,
        beat,
        beatsWithTiming[i],
        chosen,
        budgetFor(beat.id),
      );
      storyboards.push(sb);
      writeJson(projectId, `scenes/storyboard-${beat.id}.json`, sb);
    }

    writeJson(projectId, "concepts/storyboard-candidates.json", { perBeat: allCandidates });
    writeJson(projectId, "concepts/storyboard-selected.json", { selections: allSelections });
    writeJson(projectId, "concepts/storyboard.json", { storyboards });
    markStage(projectId, "concepts", "done");
    return storyboards;
  } catch (e) {
    markStage(projectId, "concepts", "failed", String(e));
    throw e instanceof Error && "stage" in e
      ? e
      : stageError("concepts", e instanceof Error ? e.message : String(e), { projectId });
  }
}

export function loadStoryboards(projectId: string): Storyboard[] | null {
  const data = readJson<{ storyboards: Storyboard[] }>(projectId, "concepts/storyboard.json");
  return data?.storyboards ?? null;
}

/** Regenerate the storyboard for one beat (semantic-level repair, Phase 3 §41). */
export async function regenerateStoryboard(
  projectId: string,
  analysis: Analysis,
  beat: { id: string; text: string; why?: string; emotion?: string; abstractMeaning?: string },
  notes: string,
  budget: { min: number; max: number },
): Promise<Storyboard> {
  const existing = readJson<{ storyboards: Storyboard[] }>(projectId, "concepts/storyboard.json");
  const prev = existing?.storyboards.find((s) => s.beatId === beat.id);
  const sb = await completeJson<Storyboard>({
    stage: "concepts" as ErrorStage,
    projectId,
    temperature: 0.7,
    maxTokens: 12000,
    system: `You are the VISUAL STORYBOARD DIRECTOR redesigning ONE storyboard (Phase 3).
${designBibleCompactPrompt()}

${memoryPrompt(projectId)}

Regenerate the storyboard for this beat with a STRONGER/DIFFERENT visual mechanism per the
requested direction, keeping the beat's meaning identical. visualMechanism MUST be a SHORT
taxonomy-style label (<=60 chars, e.g. "expectationReality") - descriptions go in other fields.
Full storyboard contract, strict keys, elementBudget ${budget.min}-${budget.max}.
Keep ALL prose fields short (compositionIntent<=500, noveltyIntent<=350, steps<=250 chars) - long fields are rejected.
Output ONLY JSON.`,
    user: `${storyboardFrame(beat, analysis)}\n\n# Direction\n${notes}\n\n# Previous storyboard (fix its weaknesses, keep its meaning)\n${JSON.stringify(prev ?? {}, null, 1)}`,
    parse: (obj) => storyboardSchema.parse(normalizeStoryboard(obj, beat.id)),
  });
  const all = (existing?.storyboards ?? []).filter((s) => s.beatId !== sb.beatId);
  all.push(sb);
  writeJson(projectId, "concepts/storyboard.json", { storyboards: all });
  writeJson(projectId, `scenes/storyboard-${sb.beatId}.json`, sb);
  return sb;
}

/** Dynamic semantic-density budget (Phase 3 §11): complexity-driven guidelines. */
export function densityBudgetFor(analysis: Analysis, beat: { important?: boolean; abstractMeaning?: string }): { min: number; max: number } {
  const complex =
    (beat.important ?? false) ||
    (beat.abstractMeaning?.length ?? 0) > 60 ||
    analysis.abstractConcepts.length >= 5;
  if (complex) return { min: 6, max: 10 };
  const simple = analysis.keyNouns.length <= 4 && (beat.abstractMeaning?.length ?? 0) < 30;
  return simple ? { min: 3, max: 6 } : { min: 4, max: 8 };
}
