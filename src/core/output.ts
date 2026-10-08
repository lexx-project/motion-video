/** Centralized output configuration (MASTER_SPEC 0, 21). No scattered constants.
 *  Pure constants only - safe to import in browser/render bundle (no node builtins). */
export const OUTPUT = {
  width: 1080,
  height: 1920,
  fps: 30,
  aspectRatio: "9:16" as const,
  videoCodec: "h264" as const,
  audioCodec: "aac" as const,
  crf: 18,
  imageFormat: "jpeg" as const,
} as const;

export const QA_THRESHOLDS = {
  overallQualityMin: 8,
  slopSeverityMax: 6,
  noveltySimilarityMax: 70,
  criticalTechnicalFailure: false,
} as const;

export const PIPELINE = {
  conceptsPerImportantBeat: [3, 5] as const,
  repairRoundsMax: 2,
  llmAttemptsMax: 2,
} as const;
