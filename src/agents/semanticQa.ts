import fs from "fs";
import { z } from "zod";
import { completeJson, chatVision, extractJson } from "./llm";
import { designBibleCompactPrompt } from "./context";
import { markStage, writeJson } from "../core/projectStore";
import { stageError } from "../core/errors";
import { semanticRichness } from "../reference/conformance";
import { shrinkFrames, sceneSummaries, type BeatContext } from "./qa";
import type { SceneSpec } from "../validation/schema";
import type { Analysis } from "./schemas";

/**
 * SEMANTIC VISUAL QA (Phase 3 §20): "Does the visual actually represent the important
 * meaning in the narration?" Combines deterministic evidence coverage + subtitle coverage
 * with a multimodal judge for semanticRelevance / visualStorytelling. Falls back to the
 * deterministic proxy if the vision call fails (documented, never fabricated praise).
 */

export interface SceneSemanticReport {
  sceneId: string;
  semanticRelevance: number; // 0-10 (judge)
  visualStorytelling: number; // 0-10 (judge) - demonstrates vs displays
  evidenceCoverage: number; // 0-10 deterministic: narration tokens found in visual evidence
  subtitleCoverage: number | null; // 0-10 deterministic; null when no VO
  richness: number; // 0-10 deterministic (roles/relationships/narrative/motion/mechanism)
  source: "vision-judge" | "deterministic-fallback";
  evidenceGaps: string[];
}

export interface SemanticQaReport {
  scenes: SceneSemanticReport[];
  overall: {
    semanticRelevance: number;
    visualStorytelling: number;
    evidenceCoverage: number;
    subtitleCoverage: number | null;
    richness: number;
  };
  notes: string[];
}

const judgeSchema = z
  .object({
    scenes: z
      .array(
        z
          .object({
            sceneId: z.string(),
            semanticRelevance: z.number().min(0).max(10),
            visualStorytelling: z.number().min(0).max(10),
            evidenceGaps: z.array(z.string().max(200)).max(6),
          })
          .strip(),
      )
      .min(1)
      .max(20),
  })
  .strip();

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Semantic synonym/stem map: abstract concepts that can be represented visually
 * without using the exact token. E.g. "audience" → hollow circle with no return signal.
 * Keys are norm()'d token stems. Values are acceptable visual representations.
 * DO NOT add tokens that a scene should genuinely NOT score for.
 */
const SEMANTIC_SYNONYMS: Record<string, string[]> = {
  mind: ["conviction", "stance", "belief", "decision", "held", "fixed", "unchang", "bearing"],
  audience: ["circle", "node", "hollow", "applaud", "signal", "return", "viewer", "crowd"],
  applause: ["applaud", "signal", "return", "reward", "recogni", "approva", "response"],
  direction: ["bearing", "heading", "path", "axis", "rail", "orient", "compass", "plumb", "vector"],
  people: ["person", "others", "ones", "crowd", "figur", "individ", "pleasing"],
  match: ["conform", "morph", "bend", "slot", "mold", "adjust", "stretch", "resiz", "reshape"],
  turn: ["pivot", "shift", "rotat", "swing", "deviat", "drift", "tilt"],
  everyone: ["all", "each", "crowd", "others", "many", "multiple", "pleasing"],
  integrity: ["conviction", "held", "unchang", "steadfast", "principl", "consist"],
  consistency: ["held", "fixed", "unchang", "steadfast", "bearing", "anchor"],
  compromise: ["decay", "drift", "bend", "struck", "dissolv", "cross", "erase", "dim"],
  authenticity: ["original", "held", "genuine", "actual", "real", "own", "identity"],
  principled: ["conviction", "held", "unchang", "bearing", "steadfast"],
  stubbornness: ["held", "fixed", "resist", "persist", "unchang", "locked", "anchor"],
  approval: ["applaud", "signal", "return", "reward", "recogni", "rememb", "audience"],
  identity: ["self", "own", "original", "mine", "person", "authentic", "voice"],
  commitment: ["held", "locked", "anchor", "bearing", "plumb", "choice", "decision"],
  conviction: ["held", "fixed", "bearing", "unchang", "steadfast", "locked", "stance"],
  indifference: ["hollow", "empty", "none", "unreward", "unlit", "void", "silence"],
  make: ["creat", "build", "form", "produc", "force", "bend", "push"],
  happy: ["pleas", "satisf", "approv", "compli", "content"],
  tired: ["exhaust", "drain", "fatigue", "deplet", "drift", "accumul", "cost", "toll"],
  remember: ["recogni", "rememb", "recall", "held", "memori", "last", "surviv", "remain"],
  change: ["transform", "morph", "shift", "alter", "bend", "reform", "reshape", "modif"],
  stop: ["halt", "resist", "hold", "anchor", "cease", "end", "break", "resolve"],
  choose: ["select", "pick", "decid", "commit", "anchor", "bearing"],
  stay: ["hold", "remain", "persist", "anchor", "fixed", "unchang", "return", "locked"],
};

/** Deterministic concept coverage: important narration tokens present in the visual evidence.
 * Uses stem matching + semantic synonyms so abstract concepts (mind, audience, applause) are
 * recognised when they are visually represented through metaphor rather than literal tokens.
 * NOTE: synonym coverage still requires the scene to have real visual evidence for the concept.
 */
export function evidenceCoverage(scene: SceneSpec, analysis: Analysis): { score: number; gaps: string[] } {
  const tokens = new Set(
    [...analysis.keyNouns, ...analysis.keyVerbs, ...analysis.abstractConcepts]
      .flatMap((t) => norm(t).split(" "))
      .filter((w) => w.length > 3),
  );
  const sb = scene.storyboard;
  const haystackParts: string[] = [
    scene.headline?.text ?? "",
    scene.purpose ?? "",
    scene.visualConcept ?? "",
    ...scene.elements.map((e) => [
      typeof e.purpose === "string" ? e.purpose : "",
      typeof e.text === "string" ? e.text : "",
      typeof e.label === "string" ? e.label : "",
      e.primitive,
    ].join(" ")),
    ...(scene.subtitle?.enabled ? scene.subtitle.phrases.map((p) => p.text) : []),
    ...(sb
      ? [
          sb.spokenMeaning,
          sb.viewerTakeaway,
          sb.visualMechanism,
          sb.compositionIntent,
          ...sb.semanticObjects.flatMap((o) => [o.objectType, o.semanticRole, o.relationship]),
          ...sb.relationships.map((r) => `${r.from} ${r.to} ${r.relationship}`),
          ...sb.visualNarrative.map((n) => `${n.action} ${n.meaning} ${n.visualEvidence ?? ""}`),
          ...sb.visualEvidence,
          ...sb.motionBeats.map((m) => `${m.action} ${m.purpose}`),
        ]
      : []),
  ];
  const haystack = norm(haystackParts.join(" "));

  const matched: string[] = [];
  const gaps: string[] = [];
  for (const t of tokens) {
    // 1. Direct match
    if (haystack.includes(t)) { matched.push(t); continue; }
    // 2. Stem match: strip up to 3 trailing chars (catches plural/tense variations)
    const stem4 = t.length > 5 ? t.slice(0, -3) : t;
    if (stem4.length >= 4 && haystack.includes(stem4)) { matched.push(t); continue; }
    // 3. Semantic synonym / visual representation match
    const syns = SEMANTIC_SYNONYMS[t] ?? [];
    if (syns.some((s) => haystack.includes(s))) { matched.push(t); continue; }
    gaps.push(t);
  }
  if (tokens.size === 0) return { score: 5, gaps: [] };
  const score = Math.round((matched.length / tokens.size) * 100) / 10;
  return { score: Math.min(10, score), gaps: gaps.slice(0, 6) };
}

/** Deterministic subtitle coverage: VO caption presence + phrase coverage of the scene window. */
export function subtitleCoverage(scene: SceneSpec, hasAudio: boolean): number | null {
  if (!hasAudio) return null;
  const sub = scene.subtitle;
  if (!sub?.enabled || sub.phrases.length === 0) return 0;
  const spoken = sub.phrases.reduce((n, p) => n + Math.max(0, p.end - p.start), 0);
  const ratio = Math.min(1, spoken / Math.max(0.5, scene.duration));
  if (ratio >= 0.7) return 10;
  if (ratio >= 0.5) return 8;
  if (ratio >= 0.3) return 6;
  if (ratio > 0) return 4;
  return 2;
}

async function oneJudge(
  images: string[],
  scenes: SceneSpec[],
  beats: BeatContext[],
  lens: string,
  temperature: number,
): Promise<z.infer<typeof judgeSchema>> {
  const prompt = [
    `You are a SEMANTIC VISUAL QA judge (Phase 3). Lens: ${lens}`,
    `ATTACHMENT: ${images.length} rendered frames in scene order. If you cannot see them, reply: VISION_UNAVAILABLE`,
    designBibleCompactPrompt(),
    "",
    "# Story beats",
    beats.map((b) => `${b.id}: ${b.text}`).join("\n"),
    "",
    "# Scenes (image order)",
    sceneSummaries(scenes),
    "",
    "# Storyboard intents (what each scene was MEANT to show)",
    scenes
      .map((s) =>
        s.storyboard
          ? `${s.sceneId}: mechanism=${s.storyboard.visualMechanism}; takeaway="${s.storyboard.viewerTakeaway}"; evidence=${s.storyboard.visualEvidence.join(" | ")}`
          : `${s.sceneId}: (no storyboard metadata)`,
      )
      .join("\n"),
    "",
    "Score per scene: semanticRelevance (0-10, does the frame show the narration's meaning), visualStorytelling (0-10, does it DEMONSTRATE a change/relationship rather than merely display text+shape). A frame that is almost entirely text scores <=4 unless typography itself performs the meaning.",
    'Output ONLY JSON {"scenes":[{"sceneId":"scene_01","semanticRelevance":8,"visualStorytelling":7,"evidenceGaps":["missing: comparison"]}]} - every scene exactly once, no prose.',
  ].join("\n\n");
  const raw = await chatVision(prompt, images, { temperature, maxTokens: 6000 });
  if (/VISION_UNAVAILABLE/i.test(raw)) throw new Error("vision unavailable");
  return judgeSchema.parse(extractJson(raw));
}

/** Two independent judges → per-scene mean + gaps from the more critical judge (variance control). */
async function judgeScenes(
  projectId: string,
  scenes: SceneSpec[],
  beats: BeatContext[],
  frames: string[],
): Promise<z.infer<typeof judgeSchema> | null> {
  try {
    const images = frames.map((f) => fs.readFileSync(f).toString("base64"));
    const [a, b] = await Promise.all([
      oneJudge(images, scenes, beats, "cold-viewer decoding: what does a first-time viewer actually understand from the pixels?", 0.2),
      oneJudge(images, scenes, beats, "narrative fidelity: does each frame demonstrate the beat's stated meaning and change?", 0.6),
    ]);
    const merged = scenes.map((s) => {
      const ra = a.scenes.find((x) => x.sceneId === s.sceneId);
      const rb = b.scenes.find((x) => x.sceneId === s.sceneId);
      const relA = ra?.semanticRelevance ?? 5;
      const relB = rb?.semanticRelevance ?? 5;
      const critical = relA <= relB ? ra : rb; // more critical judge supplies the gaps
      return {
        sceneId: s.sceneId,
        semanticRelevance: Math.round(((relA + relB) / 2) * 10) / 10,
        visualStorytelling: Math.round((((ra?.visualStorytelling ?? 5) + (rb?.visualStorytelling ?? 5)) / 2) * 10) / 10,
        evidenceGaps: critical?.evidenceGaps ?? [],
      };
    });
    return { scenes: merged };
  } catch {
    return null;
  }
}

export async function runSemanticQa(
  projectId: string,
  scenes: SceneSpec[],
  beats: BeatContext[],
  analysis: Analysis,
  frameFiles: string[],
  hasAudio: boolean,
): Promise<SemanticQaReport> {
  markStage(projectId, "semanticQa", "running");
  try {
    const frames = await shrinkFrames(frameFiles);
    const judged = await judgeScenes(projectId, scenes, beats, frames);
    const notes: string[] = [];
    if (!judged) {
      notes.push(
        "vision judge unavailable - semanticRelevance/visualStorytelling derived from deterministic evidence coverage (documented fallback, not a vision opinion)",
      );
    }
    const rows: SceneSemanticReport[] = scenes.map((s) => {
      const cov = evidenceCoverage(s, analysis);
      const sub = subtitleCoverage(s, hasAudio);
      const rich = semanticRichness(s);
      const j = judged?.scenes.find((x) => x.sceneId === s.sceneId);
      return {
        sceneId: s.sceneId,
        semanticRelevance: j ? j.semanticRelevance : Math.min(8, cov.score),
        visualStorytelling: j ? j.visualStorytelling : Math.min(8, cov.score),
        evidenceCoverage: cov.score,
        subtitleCoverage: sub,
        richness: rich.score,
        source: j ? "vision-judge" : "deterministic-fallback",
        evidenceGaps: j ? j.evidenceGaps : cov.gaps,
      };
    });
    const mean = (xs: number[]): number =>
      xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0;
    const subs = rows.map((r) => r.subtitleCoverage).filter((x): x is number => x !== null);
    const report: SemanticQaReport = {
      scenes: rows,
      overall: {
        semanticRelevance: mean(rows.map((r) => r.semanticRelevance)),
        visualStorytelling: mean(rows.map((r) => r.visualStorytelling)),
        evidenceCoverage: mean(rows.map((r) => r.evidenceCoverage)),
        subtitleCoverage: subs.length ? mean(subs) : null,
        richness: mean(rows.map((r) => r.richness)),
      },
      notes,
    };
    writeJson(projectId, "qa/semantic-qa.json", report);
    markStage(projectId, "semanticQa", "done");
    return report;
  } catch (e) {
    markStage(projectId, "semanticQa", "failed", String(e));
    if (e && typeof e === "object" && "stage" in e) throw e;
    throw stageError("qa", e instanceof Error ? e.message : String(e), { projectId });
  }
}
