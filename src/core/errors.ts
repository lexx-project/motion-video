export type ErrorStage =
  | "input"
  | "analysis"
  | "beats"
  | "concepts"
  | "artDirection"
  | "motion"
  | "timing"
  | "sceneGeneration"
  | "validation"
  | "render"
  | "qa"
  | "novelty"
  | "repair"
  | "audio"
  | "llm"
  | "internal";

export interface StudioErrorDetails {
  stage: ErrorStage;
  projectId?: string;
  sceneId?: string;
  recoverable: boolean;
  explanation: string;
  data?: unknown;
}

/**
 * Every stage fails clearly: stage + project + scene + human-readable explanation +
 * recoverable status (MASTER_SPEC section 29).
 */
export class StudioError extends Error {
  readonly stage: ErrorStage;
  readonly projectId?: string;
  readonly sceneId?: string;
  readonly recoverable: boolean;
  readonly data?: unknown;
  readonly explanation: string;

  constructor(details: StudioErrorDetails) {
    super(
      `[${details.stage}]${details.projectId ? ` project=${details.projectId}` : ""}${
        details.sceneId ? ` scene=${details.sceneId}` : ""
      }: ${details.explanation}`,
    );
    this.name = "StudioError";
    this.stage = details.stage;
    this.projectId = details.projectId;
    this.sceneId = details.sceneId;
    this.recoverable = details.recoverable;
    this.data = details.data;
    this.explanation = details.explanation;
  }

  toJSON(): StudioErrorDetails & { message: string } {
    return {
      message: this.message,
      stage: this.stage,
      projectId: this.projectId,
      sceneId: this.sceneId,
      recoverable: this.recoverable,
      explanation: this.explanation,
      data: this.data,
    };
  }
}

export function stageError(
  stage: ErrorStage,
  explanation: string,
  extra: Partial<Omit<StudioErrorDetails, "stage" | "explanation">> = {},
): StudioError {
  return new StudioError({
    stage,
    explanation,
    recoverable: extra.recoverable ?? false,
    ...extra,
  });
}
