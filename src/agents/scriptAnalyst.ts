import { completeJson, chatRaw, extractJson } from "./llm";
import { designBiblePrompt, readScript } from "./context";
import { analysisSchema, beatsSchema, type Analysis, type Beats } from "./schemas";
import { markStage, writeJson, updateManifest, wrapUnknown } from "../core/projectStore";
import type { ErrorStage } from "../core/errors";

export interface TimingBeat {
  id: string;
  text: string;
  start: number;
  end: number;
  duration: number;
  source: "word" | "phrase" | "estimated";
}

export interface Timestamps {
  source: "word" | "phrase" | "estimated" | "provided";
  audioDurationSec?: number;
  phrases: { text: string; start: number; end: number }[];
}

/** Stage 1a: meaning extraction (not sentence splitting). */
export async function runScriptAnalysis(projectId: string): Promise<Analysis> {
  markStage(projectId, "analysis", "running");
  try {
    const script = readScript(projectId);
    const analysis = await completeJson<Analysis>({
      stage: "analysis" as ErrorStage,
      projectId,
      temperature: 0.4,
      system: `You are the Script Analyst of a motion-design studio (MASTER_SPEC section 4).
${designBiblePrompt()}

Extract the COMMUNICATIVE MEANING of the script. Do not merely summarize sentences.
Output ONLY a JSON object with exactly these keys:
summary, themes[], emotions[], keyNouns[], keyVerbs[], abstractConcepts[], importantPhrases[], emphasisCandidates[], visualOpportunities[].
emphasisCandidates = phrases worth visual emphasis (not every word). visualOpportunities = concrete ideas for symbolic visuals derived from meaning.`,
      user: `# Script\n${script}`,
      parse: (obj) => analysisSchema.parse((obj as { analysis?: unknown }).analysis ?? obj),
    });
    writeJson(projectId, "analysis/script-analysis.json", analysis);
    markStage(projectId, "analysis", "done");
    updateManifest(projectId, { status: "analyzing" });
    return analysis;
  } catch (e) {
    markStage(projectId, "analysis", "failed", String(e));
    throw wrapUnknown(e, "analysis", projectId);
  }
}

/** Stage 1b: semantic story beats. */
export async function runBeatGeneration(
  projectId: string,
  analysis: Analysis,
): Promise<Beats> {
  markStage(projectId, "beats", "running");
  try {
    const script = readScript(projectId);
    const beats = await completeJson<Beats>({
      stage: "beats" as ErrorStage,
      projectId,
      temperature: 0.5,
      system: `You are the Story Beat Director (MASTER_SPEC section 4).
${designBiblePrompt()}

Split the script into SEMANTIC story beats - meaning units, not sentences. One sentence can be 2-3 beats (e.g. desire / repetition / contradiction). Produce 3-9 beats for a short script.
Each beat must stand alone as a communication unit: what is said, why it matters, emotion, abstract meaning, metaphor hints, priorities.
Mark beats that need multiple visual concepts with "important": true (the most meaning-dense 40-70%).
Output ONLY JSON: {"beats":[{id:"b1",text,why,emotion,metaphorHints[],abstractMeaning,visualPriority,typographyPriority,important,emphasisPhrase?}...]}.
ids must be b1..bN in script order. max 9 beats.`,
      user: `# Script\n${script}\n\n# Analysis\n${JSON.stringify(analysis, null, 1)}`,
      parse: (obj) => beatsSchema.parse(Array.isArray(obj) ? { beats: obj } : obj),
    });
    writeJson(projectId, "analysis/beats.json", beats);
    markStage(projectId, "beats", "done");
    return beats;
  } catch (e) {
    markStage(projectId, "beats", "failed", String(e));
    throw wrapUnknown(e, "beats", projectId);
  }
}
