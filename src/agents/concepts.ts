import { completeJson, chatRaw } from "./llm";
import { designBiblePrompt, designBibleCompactPrompt, memoryPrompt, candidateDiversityCheck, readScript } from "./context";
import {
  candidatesSchema,
  selectionsSchema,
  normalizeCandidates,
  normalizeSelections,
  type Analysis,
  type Beats,
  type Candidates,
  type Candidate,
  type Selections,
} from "./schemas";
import { markStage, writeJson, updateManifest, wrapUnknown } from "../core/projectStore";
import { stageError, type ErrorStage } from "../core/errors";
import { isKnownPrimitive } from "../core/designSystem";
import type { TimingBeat } from "./scriptAnalyst";

function assertPrimitivesKnown(candidates: Candidate[], projectId: string, beatId: string): void {
  const bad = candidates
    .flatMap((c) => c.primitiveSketch.map((p) => ({ c: c.id, p })))
    .filter(({ p }) => !isKnownPrimitive(p));
  if (bad.length > 0) {
    throw stageError(
      "concepts",
      `Candidate primitive sketches reference unknown primitives: ${bad
        .map((b) => `${b.c}->${b.p}`)
        .join(", ")}`,
      { projectId, sceneId: beatId, recoverable: true },
    );
  }
}

/** Stage 3a: 3-5 meaningfully different candidate concepts per important beat. */
export async function generateCandidatesForBeat(
  projectId: string,
  analysis: Analysis,
  beat: TimingBeat & { important?: boolean; metaphorHints?: string[]; abstractMeaning?: string },
  alternativesDirection?: string,
): Promise<Candidates> {
  const script = readScript(projectId);
  const result = await completeJson<Candidates>({
    stage: "concepts" as ErrorStage,
    projectId,
    temperature: 0.8,
    system: `You are the Visual Concept Designer (MASTER_SPEC section 5, Phase 2 section 9).
${designBiblePrompt()}

${memoryPrompt(projectId)}

For this beat, first answer silently:
1) What is the script saying here?
2) What is the emotional state?
3) What is the CENTRAL SEMANTIC RELATIONSHIP (e.g. repetition vs change, effort vs reward, now vs later)?
4) What visual metaphor can PHYSICALLY DEMONSTRATE that relationship?

ENACTMENT over ILLUSTRATION: the visual event itself must perform the meaning - two trajectories competing, a counter resetting, a loop closing, a balance tipping. A generic icon plus text that only NAMES the idea is weak. The frame should communicate meaning even if the viewer temporarily ignores the text.

Generate 3-5 CANDIDATE visual concepts. Candidates must be meaningfully different: distinct metaphor families, distinct composition grammar or distinct dominant object sets. Never five variations of one idea. Never copy the reference video or the memory entries (a new visual solution for the same meaning).
Each candidate: id (c1..c5), concept (SHORT NAME, max 80 chars), metaphor (max 300 chars), semanticMechanism (HOW the image performs the relationship, max 300 chars - REQUIRED), whyViewerUnderstandsIt (cold-viewer decode, max 300 chars - REQUIRED), composition (allowed grammar), objects (max 6), typographyStrategy (max 200), motionOpportunity (max 200), whyItWorks (max 300), complexity (low|medium|high), primitiveSketch (2-5 EXACT registry primitive names).
Field length limits are strict - keep every string comfortably under them.
Output ONLY JSON {"beatId":"...","candidates":[...]}.`,
    user: [
      alternativesDirection
        ? `# REJECTED previous candidates - direction for alternatives\n${alternativesDirection}`
        : "",
      `# Beat\n${JSON.stringify(beat, null, 1)}\n\n# Script context\n${script.slice(0, 1500)}\n\n# Script analysis summary\n${analysis.summary}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    parse: (obj) => {
      const parsed = candidatesSchema.parse(normalizeCandidates(obj, beat.id));
      assertPrimitivesKnown(parsed.candidates, projectId, beat.id);
      const dupes = candidateDiversityCheck(parsed.candidates);
      if (dupes.length > 0) {
        throw stageError("concepts", `Near-duplicate candidates: ${dupes.join("; ")}`, {
          projectId,
          sceneId: beat.id,
          recoverable: true,
        });
      }
      return parsed;
    },
  });
  return result;
}

/** Stage 3b: Art Director selects (or rejects all) using the 7 criteria. */
export async function artDirectBeat(
  projectId: string,
  beatId: string,
  candidates: Candidate[],
): Promise<Selections> {
  const selections = await completeJson<Selections>({
    stage: "artDirection" as ErrorStage,
    projectId,
    temperature: 0.4,
    maxTokens: 8000,
    system: `You are the Art Director (MASTER_SPEC section 5, Phase 2 section 10).
${designBibleCompactPrompt()}

${memoryPrompt(projectId)}

Score EACH candidate 0-10 on these exact keys: scriptRelevance, clarity, designConsistency, novelty, emotionalFit, motionPotential, technicalFeasibility.
Weights: scriptRelevance > clarity > emotionalFit > motionPotential > designConsistency > novelty > technicalFeasibility.

REJECT (rejected=true + rejectionReasons + directionForAlternatives) any candidate that is:
- generic or decorative (looks nice, says nothing)
- literal without meaning (names the idea instead of enacting it)
- overly complicated or hard to understand at a glance
- inconsistent with the Master Design Bible
- too similar to a memory entry (same metaphor+composition+objects)
- unable to state a convincing semanticMechanism AND whyViewerUnderstandsIt for a cold viewer.
Rule: if you cannot explain how the visual physically communicates the beat using its semanticMechanism, score scriptRelevance <= 4 (your own rejection threshold).
Otherwise pick exactly one existing candidate id via selectedCandidateId and cite its semanticMechanism in selectionRationale.

Output ONLY strict JSON, exactly this shape with real values (all 7 score keys present, no extra keys, selections has EXACTLY ONE element):
{"selections":[{"beatId":"${beatId}","selectedCandidateId":"c1","scores":{"scriptRelevance":9,"clarity":9,"designConsistency":9,"novelty":8,"emotionalFit":9,"motionPotential":8,"technicalFeasibility":9},"selectionRationale":"Two sentences max: cite the semanticMechanism that makes the pick work."}]}`,
    user: `# Beat id\n${beatId}\n\n# Candidates\n${JSON.stringify(candidates, null, 1)}`,
    parse: (obj) => selectionsSchema.parse(normalizeSelections(obj, beatId)),
  });
  return selections;
}

/** Full concept stage: candidates -> art direction -> (alternatives loop, max 2 rounds). */
export async function runConceptStage(
  projectId: string,
  analysis: Analysis,
  beats: Beats,
  beatsWithTiming: TimingBeat[],
): Promise<{ candidates: Candidates[]; selections: Selections }> {
  markStage(projectId, "concepts", "running");
  try {
    const allCandidates: Candidates[] = [];
    const allSelections: Selections = { selections: [] };
    const script = readScript(projectId);
    void script;

    for (let i = 0; i < beats.beats.length; i++) {
      const beat = { ...beats.beats[i], ...beatsWithTiming[i] };
      let direction: string | undefined;
      let round = 0;
      let chosen: { candidates: Candidates; selections: Selections } | null = null;

      while (round < 2) {
        round++;
        const cands = await generateCandidatesForBeat(projectId, analysis, beat, direction);
        const sel = await artDirectBeat(projectId, beat.id, cands.candidates);
        const s = sel.selections[0];
        if (s && s.rejected !== true && s.selectedCandidateId) {
          chosen = { candidates: cands, selections: sel };
          break;
        }
        direction = [
          ...(s?.rejectionReasons ?? []),
          s?.directionForAlternatives ?? "produce genuinely different metaphor families",
        ].join("; ");
        if (round >= 2) {
          // Budget exhausted: take the first candidate rather than failing the project.
          const fallback = cands.candidates[0];
          chosen = {
            candidates: cands,
            selections: {
              selections: [
                {
                  ...s!,
                  rejected: false,
                  selectedCandidateId: fallback.id,
                  selectionRationale: `(${round} rejection rounds exhausted - fallback to first candidate) ${s?.selectionRationale ?? ""}`,
                },
              ],
            },
          };
        }
      }

      if (chosen) {
        allCandidates.push(chosen.candidates);
        allSelections.selections.push(chosen.selections.selections[0]);
      }
    }

    writeJson(projectId, "concepts/candidates.json", { perBeat: allCandidates });
    writeJson(projectId, "concepts/selected.json", allSelections);
    markStage(projectId, "concepts", "done");
    updateManifest(projectId, { status: "directing" });
    return { candidates: allCandidates, selections: allSelections };
  } catch (e) {
    markStage(projectId, "concepts", "failed", String(e));
    throw wrapUnknown(e, "concepts", projectId);
  }
}

export async function regenerateCandidate(
  projectId: string,
  analysis: Analysis,
  beat: Parameters<typeof generateCandidatesForBeat>[2],
  direction: string,
): Promise<Candidates> {
  return generateCandidatesForBeat(projectId, analysis, beat, direction);
}

export { chatRaw };
