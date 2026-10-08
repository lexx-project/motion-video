import { z } from "zod";
import { composition, primitives } from "../core/designSystem";
import { sceneSchema } from "../validation/schema";

export const analysisSchema = z
  .object({
    summary: z.string().min(10).max(600),
    themes: z.array(z.string().max(80)).min(1).max(10),
    emotions: z.array(z.string().max(60)).min(1).max(8),
    keyNouns: z.array(z.string().max(60)).min(1).max(20),
    keyVerbs: z.array(z.string().max(60)).min(1).max(20),
    abstractConcepts: z.array(z.string().max(80)).min(1).max(12),
    importantPhrases: z.array(z.string().max(120)).min(1).max(12),
    emphasisCandidates: z.array(z.string().max(120)).max(8),
    visualOpportunities: z.array(z.string().max(160)).max(12),
  })
  .strict();

export const beatSchema = z
  .object({
    id: z.string().regex(/^b\d+$/, "beat id must look like b1, b2, ..."),
    text: z.string().min(3).max(300),
    why: z.string().max(300),
    emotion: z.string().max(80),
    metaphorHints: z.array(z.string().max(120)).max(6),
    abstractMeaning: z.string().max(200),
    visualPriority: z.enum(["high", "medium", "low"]),
    typographyPriority: z.enum(["high", "medium", "low"]),
    important: z.boolean(),
    emphasisPhrase: z.string().max(120).optional(),
  })
  .strict();

export const beatsSchema = z.object({ beats: z.array(beatSchema).min(1).max(14) }).strict();

export const candidateSchema = z
  .object({
    id: z.string().min(2).max(40),
    concept: z.string().min(3).max(160),
    metaphor: z.string().min(10).max(400),
    semanticMechanism: z
      .string()
      .min(10)
      .max(400)
      .describe("HOW the visual physically demonstrates the beat's semantic relationship (enactment, not illustration)"),
    whyViewerUnderstandsIt: z
      .string()
      .min(10)
      .max(400)
      .describe("Why a cold viewer decodes the meaning from the image alone"),
    composition: z.enum(composition.grammars as [string, ...string[]]),
    objects: z.array(z.string().max(40)).min(1).max(6),
    typographyStrategy: z.string().min(5).max(300),
    motionOpportunity: z.string().min(5).max(300),
    whyItWorks: z.string().min(10).max(400),
    complexity: z.enum(["low", "medium", "high"]),
    primitiveSketch: z.array(z.string().max(40)).min(2).max(6),
  })
  .strict();

export const candidatesSchema = z
  .object({
    beatId: z.string(),
    candidates: z.array(candidateSchema).min(3).max(5),
  })
  .strict();

export const selectionSchema = z
  .object({
    beatId: z.string(),
    selectedCandidateId: z.string().optional(),
    rejected: z.boolean().optional(),
    rejectionReasons: z.array(z.string().max(200)).optional(),
    directionForAlternatives: z.string().max(400).optional(),
    semanticMechanism: z.string().max(400).optional(),
    scores: z
      .object({
        scriptRelevance: z.number().min(0).max(10),
        clarity: z.number().min(0).max(10),
        designConsistency: z.number().min(0).max(10),
        novelty: z.number().min(0).max(10),
        emotionalFit: z.number().min(0).max(10),
        motionPotential: z.number().min(0).max(10),
        technicalFeasibility: z.number().min(0).max(10),
      })
      .strip(),
    selectionRationale: z.string().max(400),
  })
  .strip()
  .superRefine((v, ctx) => {
    const rejected = v.rejected === true;
    if (!rejected && !v.selectedCandidateId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedCandidateId"], message: "must select a candidate or set rejected=true" });
    }
    if (rejected && (!v.rejectionReasons || v.rejectionReasons.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rejectionReasons"], message: "rejection requires reasons" });
    }
  });

export const selectionsSchema = z
  .object({ selections: z.array(selectionSchema).min(1).max(14) })
  .strip();

/** Scene JSON from the Remotion planner - the full Master Spec section 8 contract. */
export const sceneListSchema = z
  .object({ scenes: z.array(sceneSchema).min(1).max(20) })
  .strict();

export const sceneQaScores = z
  .object({
    scriptRelevance: z.number().min(0).max(10),
    visualClarity: z.number().min(0).max(10),
    designConsistency: z.number().min(0).max(10),
    typography: z.number().min(0).max(10),
    composition: z.number().min(0).max(10),
    motionQuality: z.number().min(0).max(10),
    novelty: z.number().min(0).max(10),
    aiSlopSeverity: z.number().min(0).max(10),
  })
  .strict();

/** Multi-sample statistics: median is the decision statistic; variance exposes judge instability. */
export const scoreStatsSchema = z
  .object({
    mean: z.number().min(0).max(10),
    median: z.number().min(0).max(10),
    variance: z.number().min(0),
    confidence: z.number().min(0).max(1),
  })
  .strict();

/** Scores-only output from one independent evaluator (numbers, no prose - keeps calls fast). */
export const evaluatorResultSchema = z
  .object({
    scenes: z
      .array(z.object({ sceneId: z.string(), scores: sceneQaScores }).strict())
      .min(1)
      .max(20),
    overall: sceneQaScores,
  })
  .strict();

/** Detailed issue analysis - only run when aggregate medians say repair is needed. */
export const qaIssuesSchema = z
  .object({
    scenes: z
      .array(
        z
          .object({
            sceneId: z.string(),
            technicalCorrectness: z.enum(["pass", "fail"]),
            issues: z.array(z.string().max(400)).max(12),
            recommendedRepair: z.array(z.string().max(300)).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

/** Aggregated multi-evaluator visual QA (scene-level first, medians with confidence). */
export const visualQaSchema = z
  .object({
    evaluatorCount: z.number().min(1).max(5),
    projectStatus: z.enum(["pass", "needs_repair", "fail"]),
    overall: sceneQaScores.extend({
      technicalCorrectness: z.enum(["pass", "fail"]),
      stats: scoreStatsSchema,
    }),
    scenes: z
      .array(
        z
          .object({
            sceneId: z.string(),
            scores: sceneQaScores,
            stats: scoreStatsSchema,
            technicalCorrectness: z.enum(["pass", "fail"]),
            issues: z.array(z.string().max(400)).max(12),
            recommendedRepair: z.array(z.string().max(300)).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export const slopFinding = z
  .object({
    sceneId: z.string(),
    type: z.string().max(60),
    evidence: z.string().min(8).max(400),
    severity: z.number().min(0).max(10),
  })
  .strict();

export const slopQaSchema = z
  .object({
    projectSeverity: z.number().min(0).max(10),
    verdict: z.enum(["acceptable", "needs_repair", "severe"]),
    findings: z.array(slopFinding).max(40),
  })
  .strict();

export const repairReportSchema = z
  .object({
    issue: z.string().min(5).max(500),
    rootCause: z.string().min(5).max(500),
    scope: z.enum(["minimal", "conceptReplacement"]),
    changesMade: z.array(z.string().max(400)).min(1).max(12),
    preserve: z.array(z.string().max(300)).min(1).max(10),
    expectedEffect: z.string().min(5).max(400),
    scene: sceneSchema,
  })
  .strip();

export type Analysis = z.infer<typeof analysisSchema>;
export type Beat = z.infer<typeof beatSchema>;
export type Beats = z.infer<typeof beatsSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type Candidates = z.infer<typeof candidatesSchema>;
export type Selection = z.infer<typeof selectionSchema>;
export type Selections = z.infer<typeof selectionsSchema>;
export type VisualQa = z.infer<typeof visualQaSchema>;
export type EvaluatorResult = z.infer<typeof evaluatorResultSchema>;
export type QaIssues = z.infer<typeof qaIssuesSchema>;
export type ScoreStats = z.infer<typeof scoreStatsSchema>;
export type SlopQa = z.infer<typeof slopQaSchema>;
export type RepairReport = z.infer<typeof repairReportSchema>;

/* ---------------------------------------------------------------------------
 * Normalizers: tolerate common shape drift from the model (arrays without
 * wrappers, single objects, extra commentary keys) BEFORE strict validation.
 * Structure is still enforced - these only fix envelope/shape, never content.
 * ------------------------------------------------------------------------- */

const stripKeys = <T extends Record<string, unknown>>(o: T, keys: string[]): T => {
  const clone = { ...o };
  for (const k of keys) delete clone[k];
  return clone;
};

const SCENE_COMMENT_KEYS = ["rationale", "notes", "comment", "comments", "explanation", "reasoning", "analysis", "why", "thoughts"];

export function normalizeScenes(obj: unknown): unknown {
  let o: unknown = obj;
  if (Array.isArray(o)) o = { scenes: o };
  if (o && typeof o === "object" && "sceneId" in (o as object)) o = { scenes: [o] };
  if (o && typeof o === "object" && Array.isArray((o as { scenes?: unknown[] }).scenes)) {
    const wrapped = o as { scenes: Record<string, unknown>[] };
    o = {
      ...wrapped,
      scenes: wrapped.scenes.map((s) => {
        const cleaned = stripKeys(s, SCENE_COMMENT_KEYS);
        // Models often emit element-ish keys inside scene.headline (position, delay, ...)
        // which the strict headline schema rejects - whitelist the real headline fields.
        if (cleaned.headline && typeof cleaned.headline === "object") {
          const h = cleaned.headline as Record<string, unknown>;
          const whitelist: Record<string, unknown> = {};
          if (typeof h.text === "string") whitelist.text = h.text;
          if (Array.isArray(h.accentWords)) whitelist.accentWords = h.accentWords;
          if (typeof h.align === "string") whitelist.align = h.align;
          if (typeof h.position === "string") whitelist.position = h.position;
          cleaned.headline = whitelist;
        }
        if (Array.isArray(cleaned.elements)) {
          cleaned.elements = (cleaned.elements as Record<string, unknown>[]).map((el) => {
            if (!el || typeof el !== "object") return el;
            const primName = typeof el.primitive === "string" ? el.primitive : "";
            const def = primitives.primitives[primName];
            if (!def) return el;
            const allowed = new Set([
              "primitive",
              ...Object.keys(primitives.common),
              ...Object.keys(def.params),
            ]);
            const sanitized: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(el)) {
              if (allowed.has(k)) {
                sanitized[k] = v;
              } else if (k === "label" && def.params.text && !el.text) {
                // If model put 'label' instead of 'text' on a primitive expecting 'text'
                sanitized.text = String(v);
              }
            }
            return sanitized;
          });
        }
        return cleaned;
      }),
    };
  }
  return o;
}

export function normalizeCandidates(obj: unknown, beatId?: string): unknown {
  let o: Record<string, unknown> = Array.isArray(obj)
    ? { candidates: obj }
    : (obj as Record<string, unknown>);
  if (o && Array.isArray(o.candidates)) {
    o = {
      ...o,
      beatId: typeof o.beatId === "string" ? o.beatId : (beatId ?? ""),
      candidates: (o.candidates as Record<string, unknown>[]).map((c) =>
        stripKeys(c, ["rationale", "notes", "comment", "explanation", "reasoning"]),
      ),
    };
  }
  return o;
}

export function normalizeSelections(obj: unknown, beatId?: string): unknown {
  let o: Record<string, unknown> | null = Array.isArray(obj)
    ? { selections: obj }
    : (obj as Record<string, unknown>);
  if (o && !o.selections && ("selectedCandidateId" in o || "rejected" in o)) {
    o = { selections: [o] };
  }
  if (o && Array.isArray(o.selections)) {
    let list = o.selections as Record<string, unknown>[];
    if (beatId) {
      const matching = list.filter((s) => !s.beatId || s.beatId === beatId);
      if (matching.length > 0) list = matching;
    }
    list = list.slice(0, 1).map((s) => {
      const picked = stripKeys(s, ["rationale", "notes", "comment", "explanation", "reasoning", "why"]);
      if (picked.scores && typeof picked.scores === "object") {
        const sc = { ...(picked.scores as Record<string, unknown>) };
        delete sc.semanticMechanism;
        delete sc.mechanism;
        delete sc.notes;
        delete sc.rationale;
        delete sc.explanation;
        picked.scores = sc;
      }
      return {
        beatId: beatId ?? (typeof picked.beatId === "string" ? picked.beatId : ""),
        selectionRationale: "",
        ...picked,
      };
    });
    o = { selections: list };
  }
  return o;
}
