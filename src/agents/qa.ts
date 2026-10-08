import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { chatVision, extractJson } from "./llm";
import { designBibleCompactPrompt } from "./context";
import {
  visualQaSchema,
  evaluatorResultSchema,
  qaIssuesSchema,
  slopQaSchema,
  type VisualQa,
  type SlopQa,
  type EvaluatorResult,
  type ScoreStats,
} from "./schemas";
import { markStage, writeJson } from "../core/projectStore";
import { stageError } from "../core/errors";
import { forbiddenPatterns } from "../core/designSystem";
import { QA_THRESHOLDS } from "../core/output";
import { extractSceneFrames, probeRender, type TechnicalQaResult } from "../render/renderProject";
import type { SceneSpec } from "../validation/schema";
import type { NoveltyReport } from "./novelty";
import type { ConformanceReport } from "../reference/conformance";
import type { SemanticQaReport } from "./semanticQa";

const execFileAsync = promisify(execFile);

export interface BeatContext {
  id: string;
  text: string;
}

/**
 * Independent QA evaluators (Phase 2 §11). Different lenses + temperatures so the
 * aggregate median is robust to any single judge's outlier scoring.
 */
export const QA_EVALUATORS = [
  { id: "A", lens: "script-communication: does each frame express its story beat visually, without relying on the narration?", temperature: 0.2 },
  { id: "B", lens: "design-craft: typography quality, composition, hierarchy, and consistency with the Master Design Bible", temperature: 0.4 },
  { id: "C", lens: "cold-viewer skeptic: first-impression clarity, phone-size readability, and sensitivity to AI-slop aesthetics", temperature: 0.6 },
] as const;

const QUALITY_DIMS = [
  "scriptRelevance",
  "visualClarity",
  "designConsistency",
  "typography",
  "composition",
  "motionQuality",
  "novelty",
] as const;

type QualityDim = (typeof QUALITY_DIMS)[number];

export const sceneSummaries = (scenes: SceneSpec[]): string =>
  scenes
    .map(
      (s) =>
        `- ${s.sceneId}: purpose="${s.purpose}" concept="${s.visualConcept}" composition=${s.composition} headline="${s.headline?.text ?? "-"}" primitives=[${s.elements
          .map((e) => e.primitive)
          .join(",")}] motion=${s.motion.entrance}/${s.motion.emphasis}/${s.motion.exit} duration=${s.duration}s`,
    )
    .join("\n");

/** Downscale stills so vision calls stay fast (frames are review artifacts, not render output). */
export async function shrinkFrames(files: string[]): Promise<string[]> {
  const small: string[] = [];
  for (const f of files) {
    const out = f.replace(/\.png$/, ".small.jpg");
    try {
      await execFileAsync("ffmpeg", ["-y", "-i", f, "-vf", "scale=384:-2", "-q:v", "6", out]);
      small.push(out);
    } catch {
      small.push(f);
    }
  }
  return small;
}

const b64 = (f: string): string => fs.readFileSync(f).toString("base64");

export interface QaBundle {
  technical: TechnicalQaResult;
  visual: VisualQa;
  slop: SlopQa;
  novelty: NoveltyReport;
  conformance?: ConformanceReport;
  semantic?: SemanticQaReport;
  overallQuality: number;
  /** judge confidence (1 - variance/6) from multi-sample evaluation */
  confidence: number;
  variance: number;
  status: "pass" | "needs_repair" | "fail";
  reasons: string[];
}

/** Technical QA - deterministic (MASTER_SPEC 11). */
export async function technicalQa(
  renderFile: string,
  scenes: SceneSpec[],
  hasAudio: boolean,
): Promise<TechnicalQaResult> {
  const expected = scenes.reduce((n, s) => n + s.duration, 0);
  const result = await probeRender(renderFile, expected);
  if (hasAudio && !result.hasAudio) result.errors.push("expected audio stream missing");
  if (!hasAudio) result.errors.push("no VO audio provided (silent render)");
  return result;
}

async function visionJsonCall<T>(
  prompt: string,
  images: string[],
  parse: (obj: unknown) => T,
  temperature = 0.3,
  maxTokens = 10000,
): Promise<T> {
  let lastErr = "";
  let visionUnavailable = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 5000 * attempt));
    const text =
      attempt === 0
        ? prompt
        : `${prompt}\n\nYour previous response was invalid:\n${lastErr}\nRespond again with ONLY the corrected JSON object.`;
    let raw: string;
    try {
      raw = await chatVision(text, images, { temperature, maxTokens });
    } catch (e) {
      // transient provider failures: outer loop retries with backoff
      lastErr = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (/^\s*VISION_UNAVAILABLE\s*$/i.test(raw)) {
      // One "I can't see them" is often a model shortcut, not a real provider failure:
      // re-ask with explicit attachment facts before giving up (still never fake scores).
      visionUnavailable += 1;
      if (visionUnavailable >= 3) {
        throw stageError(
          "qa",
          "Vision provider repeatedly reported VISION_UNAVAILABLE - image attachments not accepted. Cannot fake vision scores; fix provider image support and retry.",
          { recoverable: false },
        );
      }
      lastErr = `You replied VISION_UNAVAILABLE, but ${images.length} frame images ARE attached as base64 data URLs in this very message. Look at them again and complete the JSON task.`;
      continue;
    }
    try {
      return parse(extractJson(raw));
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw stageError("qa", `Vision QA failed after retries: ${lastErr}`, { recoverable: false });
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** mean/median/variance/confidence across evaluator scores (Phase 2 §11-12). */
export function statsOf(values: number[]): ScoreStats {
  if (values.length === 0) return { mean: 0, median: 0, variance: 0, confidence: 0 };
  const avg = mean(values);
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const variance = mean(values.map((v) => (v - avg) ** 2));
  const confidence = clamp01(1 - variance / 6);
  return {
    mean: Number(avg.toFixed(2)),
    median: Number(median.toFixed(2)),
    variance: Number(variance.toFixed(3)),
    confidence: Number(confidence.toFixed(2)),
  };
}

const qualityMean = (scores: Record<QualityDim, number>): number =>
  mean(QUALITY_DIMS.map((d) => scores[d]));

function buildEvaluatorPrompt(
  scenes: SceneSpec[],
  beats: BeatContext[],
  frameCount: number,
  evaluator: { id: string; lens: string },
): string {
  return [
    `You are Vision QA Evaluator ${evaluator.id} of a motion-design studio (MASTER_SPEC section 11). Your assigned lens: ${evaluator.lens}`,
    `Images: exactly ${frameCount} rendered frames attached as base64 data URLs (they load reliably - study them first). Only if they genuinely fail to render, reply: VISION_UNAVAILABLE`,
    designBibleCompactPrompt(),
    "",
    "# Story beats (what each scene must communicate)",
    beats.map((b) => `${b.id}: ${b.text}`).join("\n"),
    "",
    "# Images: one rendered frame per scene, in this order",
    scenes.map((s, i) => `${i + 1}. ${s.sceneId}`).join("\n"),
    "",
    "# Scene specs",
    sceneSummaries(scenes),
    "",
    "Score EVERY scene 0-10 on: scriptRelevance, visualClarity, designConsistency, typography, composition, motionQuality, novelty, aiSlopSeverity (LOWER=better).",
    "Calibration: 8-10 = would ship; 6-7 = minor issues; 4-5 = noticeable problems; 0-3 = fails your lens. Be decisive - use the full range; do not cluster everything at 7.",
    "Work efficiently: keep reasoning brief, then output the JSON immediately.",
    "Output ONLY JSON, numbers only (no issue text): " +
      '{"scenes":[{"sceneId":"scene_01","scores":{"scriptRelevance":8,"visualClarity":8,"designConsistency":8,"typography":8,"composition":8,"motionQuality":8,"novelty":8,"aiSlopSeverity":2}}],"overall":{"scriptRelevance":8,"visualClarity":8,"designConsistency":8,"typography":8,"composition":8,"motionQuality":8,"novelty":8,"aiSlopSeverity":2}}',
    "All 8 score keys required per scene and in overall; every scene exactly once.",
  ].join("\n\n");
}

function buildIssuesPrompt(
  flagged: { sceneId: string; scores: Record<string, number> }[],
  scenes: SceneSpec[],
  beats: BeatContext[],
  frameCount: number,
): string {
  const flaggedIds = new Set(flagged.map((f) => f.sceneId));
  return [
    "You are the QA Issue Analyst of a motion-design studio. For the FLAGGED scenes below, identify concrete issues and minimal repairs. You may also report technicalCorrectness=fail for unreadable/missing/overlapping content.",
    `Images: exactly ${frameCount} rendered frames attached as base64 data URLs (load reliably). Only if they genuinely fail to render, reply: VISION_UNAVAILABLE`,
    designBibleCompactPrompt(),
    "",
    "# Story beats",
    beats.map((b) => `${b.id}: ${b.text}`).join("\n"),
    "",
    "# Images: one rendered frame per scene, in this order",
    scenes.map((s, i) => `${i + 1}. ${s.sceneId}`).join("\n"),
    "",
    "# Scene specs",
    sceneSummaries(scenes),
    "",
    "# Flagged scenes (median scores across evaluators)",
    flagged.map((f) => `${f.sceneId}: ${JSON.stringify(f.scores)}`).join("\n"),
    "",
    `Return an entry for each flagged scene ONLY (ignore others): ${[...flaggedIds].join(", ")}.`,
    "issues must cite concrete frame evidence; recommendedRepair must be minimal and actionable (preserve what already works).",
    "BREVITY IS REQUIRED: max 4 issues and max 4 repairs per scene; each issue <= 180 chars; each repair <= 140 chars. Verbose responses get truncated and fail.",
    'Output ONLY JSON: {"scenes":[{"sceneId":"scene_01","technicalCorrectness":"pass|fail","issues":["evidence string"],"recommendedRepair":["minimal fix"]}]}',
  ].join("\n\n");
}

/** Multi-sample Vision QA: 3 independent evaluators -> median decisions + variance/confidence. */
export async function visionQa(
  projectId: string,
  scenes: SceneSpec[],
  beats: BeatContext[],
  frameFiles: string[],
): Promise<VisualQa> {
  markStage(projectId, "visionQa", "running");
  try {
    const frames = await shrinkFrames(frameFiles);
    const images = frames.map(b64);

    const rawResults: EvaluatorResult[] = [];
    for (const [i, ev] of QA_EVALUATORS.entries()) {
      const prompt = buildEvaluatorPrompt(scenes, beats, frames.length, ev);
      const result = await visionJsonCall<EvaluatorResult>(
        prompt,
        images,
        (obj) => evaluatorResultSchema.parse(obj),
        ev.temperature,
        8000,
      );
      // verify evaluator scored every scene; pad missing with worst-case? No - fail loudly
      const missing = scenes.filter((s) => !result.scenes.some((r) => r.sceneId === s.sceneId));
      if (missing.length > 0) {
        throw stageError(
          "qa",
          `Evaluator ${ev.id} missing scenes: ${missing.map((m) => m.sceneId).join(", ")}`,
          { projectId, recoverable: true },
        );
      }
      rawResults.push(result);
      writeJson(projectId, `qa/evaluator-${i + 1}.json`, { evaluator: ev, result });
    }

    // aggregate: per-dim medians + per-scene stats across evaluators
    const sceneAgg = scenes.map((s) => {
      const perEvaluatorQuality: number[] = [];
      const perDimValues: Record<string, number[]> = {};
      for (const r of rawResults) {
        const rs = r.scenes.find((x) => x.sceneId === s.sceneId)!;
        perEvaluatorQuality.push(qualityMean(rs.scores as Record<QualityDim, number>));
        for (const [k, v] of Object.entries(rs.scores)) {
          (perDimValues[k] ??= []).push(v);
        }
      }
      const scores = Object.fromEntries(
        Object.entries(perDimValues).map(([k, vs]) => [k, statsOf(vs).median]),
      ) as unknown as VisualQa["scenes"][number]["scores"];
      return {
        sceneId: s.sceneId,
        scores,
        stats: statsOf(perEvaluatorQuality),
      };
    });

    const overallPerDimValues: Record<string, number[]> = {};
    const overallQuality: number[] = [];
    for (const r of rawResults) {
      overallQuality.push(qualityMean(r.overall as Record<QualityDim, number>));
      for (const [k, v] of Object.entries(r.overall)) (overallPerDimValues[k] ??= []).push(v);
    }
    const overallScores = Object.fromEntries(
      Object.entries(overallPerDimValues).map(([k, vs]) => [k, statsOf(vs).median]),
    ) as unknown as VisualQa["overall"];

    // decide whether the detailed issue analysis is needed (median-driven, outlier-immune)
    const flagged = sceneAgg.filter(
      (s) =>
        s.scores.scriptRelevance < 6 ||
        s.scores.visualClarity < 6 ||
        s.scores.typography < 6 ||
        s.scores.composition < 6 ||
        s.scores.designConsistency < 6 ||
        s.scores.aiSlopSeverity > QA_THRESHOLDS.slopSeverityMax ||
        s.stats.median < 7,
    );
    const overallStats = statsOf(overallQuality);
    const needsIssues =
      flagged.length > 0 ||
      overallStats.median < QA_THRESHOLDS.overallQualityMin;

    let issuesByScene = new Map<string, { technicalCorrectness: "pass" | "fail"; issues: string[]; recommendedRepair: string[] }>();
    if (needsIssues && flagged.length > 0) {
      // surgical: only flagged scenes + only their frames (smaller request => stays under gateway timeout)
      const flaggedIds = new Set(flagged.map((f) => f.sceneId));
      const flaggedScenes = scenes.filter((s) => flaggedIds.has(s.sceneId));
      const flaggedImages = scenes
        .map((s, i) => (flaggedIds.has(s.sceneId) ? images[i] : null))
        .filter((x): x is string => x !== null);
      try {
        const issuesResult = await visionJsonCall(
          buildIssuesPrompt(
            flagged.map((f) => ({ sceneId: f.sceneId, scores: f.scores as unknown as Record<string, number> })),
            flaggedScenes,
            beats,
            flaggedImages.length,
          ),
          flaggedImages,
          (obj) => qaIssuesSchema.parse(obj),
          0.3,
          8000,
        );
        issuesByScene = new Map(
          issuesResult.scenes.map((s) => [
            s.sceneId,
            {
              technicalCorrectness: s.technicalCorrectness,
              issues: s.issues,
              recommendedRepair: s.recommendedRepair,
            },
          ]),
        );
      } catch (e) {
        console.warn(`[visionQa] issues extraction failed (${e instanceof Error ? e.message : e}), using score-derived fallback`);
        issuesByScene = new Map(
          flagged.map((f) => [
            f.sceneId,
            {
              technicalCorrectness: "pass" as const,
              issues: Object.entries(f.scores)
                .filter(([k, v]) => k !== "aiSlopSeverity" && (v as number) < 6)
                .map(([k, v]) => `Low score in ${k} (${v}/10)`),
              recommendedRepair: [
                `Improve ${Object.entries(f.scores)
                  .filter(([k, v]) => k !== "aiSlopSeverity" && (v as number) < 6)
                  .map(([k]) => k)
                  .join(", ") || "visual hierarchy"}`,
              ],
            },
          ]),
        );
      }
    }

    const qa: VisualQa = {
      evaluatorCount: QA_EVALUATORS.length,
      projectStatus: needsIssues ? "needs_repair" : "pass",
      overall: {
        ...overallScores,
        technicalCorrectness: [...issuesByScene.values()].some((s) => s.technicalCorrectness === "fail")
          ? "fail"
          : "pass",
        stats: overallStats,
      },
      scenes: sceneAgg.map((s) => ({
        sceneId: s.sceneId,
        scores: s.scores,
        stats: s.stats,
        technicalCorrectness: issuesByScene.get(s.sceneId)?.technicalCorrectness ?? "pass",
        issues: issuesByScene.get(s.sceneId)?.issues ?? [],
        recommendedRepair: issuesByScene.get(s.sceneId)?.recommendedRepair ?? [],
      })),
    };
    const validated = visualQaSchema.parse(qa);
    writeJson(projectId, "qa/visual-qa.json", validated);
    writeJson(projectId, "qa/visual-qa-raw.json", { evaluators: QA_EVALUATORS, rawResults });
    markStage(projectId, "visionQa", "done");
    return validated;
  } catch (e) {
    markStage(projectId, "visionQa", "failed", String(e));
    if (e && typeof e === "object" && "stage" in e) throw e;
    throw stageError("qa", e instanceof Error ? e.message : String(e), { projectId });
  }
}

/** Slop Critic - adversarial review against forbidden-patterns.json (MASTER_SPEC 11). */
export async function slopCritic(
  projectId: string,
  scenes: SceneSpec[],
  frameFiles: string[],
): Promise<SlopQa> {
  markStage(projectId, "slop", "running");
  try {
    const frames = await shrinkFrames(frameFiles);
    const prompt = [
      "You are the Slop Critic of a motion-design studio (MASTER_SPEC section 1, rule 12).",
      "# Forbidden patterns (score against these ids)",
      JSON.stringify(forbiddenPatterns.patterns.map((p) => ({ id: p.id, rule: p.rule, severity: p.severity }))),
      "",
      "# Images: one rendered frame per scene, in this order",
      scenes.map((s, i) => `${i + 1}. ${s.sceneId}`).join("\n"),
      "",
      "# Scene specs",
      sceneSummaries(scenes),
      "",
      "Hunt for: generic AI aesthetics, meaningless decoration, visual clutter, random effects, repetitive layouts, unnecessary glow, bad typography, weak metaphor, over-animation, rainbow palettes.",
      "Do NOT flag restrained atmospheric use the design language allows (single subordinate glow, low-opacity grain).",
      'Output ONLY JSON in exactly this shape: {"projectSeverity":2,"verdict":"acceptable","findings":[{"sceneId":"scene_01","type":"unnecessary-glow","evidence":"three stacked glows behind the headline","severity":6}]}. Use an empty findings array when clean. verdict: severity <4 acceptable, 4-6 needs_repair, >6 severe.',
    ].join("\n\n");

    const slop = await visionJsonCall<SlopQa>(
      prompt,
      frames.map(b64),
      (obj) => slopQaSchema.parse(obj),
      0.4,
    );
    writeJson(projectId, "qa/slop-qa.json", slop);
    markStage(projectId, "slop", slop.verdict === "acceptable" ? "done" : "failed");
    return slop;
  } catch (e) {
    markStage(projectId, "slop", "failed", String(e));
    if (e && typeof e === "object" && "stage" in e) throw e;
    throw stageError("qa", e instanceof Error ? e.message : String(e), { projectId });
  }
}

/** Aggregate all QA dimensions into the Master Spec scoring result (scene-level medians first). */
export function aggregateQa(
  technical: TechnicalQaResult,
  visual: VisualQa,
  slop: SlopQa,
  novelty: NoveltyReport,
  conformance?: ConformanceReport,
  semantic?: SemanticQaReport,
): Pick<QaBundle, "overallQuality" | "confidence" | "variance" | "status" | "reasons"> {
  const reasons: string[] = [];
  const sceneScores = visual.scenes.map((s) => qualityMean(s.scores as Record<QualityDim, number>));
  const qualityParts = [
    ...sceneScores,
    mean(sceneScores),
    mean([10 - visual.overall.aiSlopSeverity, 10 - slop.projectSeverity]),
  ];
  if (conformance) qualityParts.push(conformance.overall);
  if (semantic) {
    qualityParts.push(
      semantic.overall.semanticRelevance,
      semantic.overall.visualStorytelling,
      semantic.overall.evidenceCoverage,
      semantic.overall.richness,
    );
    if (semantic.overall.subtitleCoverage !== null) qualityParts.push(semantic.overall.subtitleCoverage);
  }
  const overallQuality = mean(qualityParts);
  const confidence = visual.overall.stats.confidence;
  const variance = visual.overall.stats.variance;

  if (technical.errors.length > 0) reasons.push(`technical: ${technical.errors.join("; ")}`);
  if (overallQuality < QA_THRESHOLDS.overallQualityMin)
    reasons.push(`overall quality ${overallQuality.toFixed(1)} < ${QA_THRESHOLDS.overallQualityMin}`);
  if (slop.projectSeverity > QA_THRESHOLDS.slopSeverityMax)
    reasons.push(`slop severity ${slop.projectSeverity} > ${QA_THRESHOLDS.slopSeverityMax}`);
  if (novelty.status !== "pass") reasons.push(`novelty rejects: ${novelty.rejectedSceneIds.join(", ")}`);
  if (conformance && conformance.overall < 6)
    reasons.push(`reference conformance ${conformance.overall} < 6`);
  if (semantic) {
    if (semantic.overall.semanticRelevance < 6.5)
      reasons.push(`semantic relevance ${semantic.overall.semanticRelevance} < 6.5 (visuals not carrying the narration's meaning)`);
    if (semantic.overall.visualStorytelling < 6.5)
      reasons.push(`visual storytelling ${semantic.overall.visualStorytelling} < 6.5 (scenes display instead of demonstrate)`);
    if (semantic.overall.evidenceCoverage < 5)
      reasons.push(`evidence coverage ${semantic.overall.evidenceCoverage} < 5 (important narration concepts missing visual evidence)`);
    if (semantic.overall.richness < 5)
      reasons.push(`visual richness ${semantic.overall.richness} < 5 (too few meaningful roles/relationships/motion beats)`);
    if (semantic.overall.subtitleCoverage !== null && semantic.overall.subtitleCoverage < 5)
      reasons.push(`subtitle coverage ${semantic.overall.subtitleCoverage} < 5 (VO not adequately captioned)`);
    for (const s of semantic.scenes) {
      if (s.semanticRelevance < 5)
        reasons.push(`${s.sceneId}: semantic relevance ${s.semanticRelevance} - ${s.evidenceGaps.slice(0, 2).join("; ") || "visual does not represent the beat"}`);
    }
  }
  if (confidence < 0.5)
    reasons.push(`judge confidence low (variance ${variance}) - scores unstable, weight down`);

  for (const s of visual.scenes) {
    if (s.technicalCorrectness === "fail") reasons.push(`${s.sceneId}: technical correctness fail`);
    if (s.scores.aiSlopSeverity > QA_THRESHOLDS.slopSeverityMax)
      reasons.push(`${s.sceneId}: aiSlopSeverity ${s.scores.aiSlopSeverity} (median)`);
    if ((s.scores.scriptRelevance < 6 || s.scores.visualClarity < 6) && s.stats.median < 6.5)
      reasons.push(
        `${s.sceneId}: severe relevance/clarity issue (median relevance ${s.scores.scriptRelevance}, clarity ${s.scores.visualClarity}, scene median ${s.stats.median})`,
      );
    const critical = s.issues.filter((i) => /overlap|unreadable|illegible|cut off|out of frame/i.test(i));
    if (critical.length > 0) reasons.push(`${s.sceneId}: severe readability - ${critical[0]}`);
  }

  const technicalFail =
    technical.errors.filter((e) => !e.includes("silent render")).length > 0 ||
    visual.overall.technicalCorrectness === "fail";
  if (technicalFail) {
    return { overallQuality, confidence, variance, status: "fail", reasons };
  }
  return { overallQuality, confidence, variance, status: reasons.length > 0 ? "needs_repair" : "pass", reasons };
}

export async function collectFrames(
  projectId: string,
  scenes: SceneSpec[],
  audioPath: string | undefined,
  label: string,
): Promise<string[]> {
  const dir = path_join(projectId, "qa", "frames", label);
  const frames = await extractSceneFrames(scenes, audioPath, dir, label);
  return frames.map((f) => f.file);
}

const path_join = (...parts: string[]): string =>
  [process.cwd(), "projects", ...parts].join("/");
