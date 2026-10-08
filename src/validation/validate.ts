import { sceneSchema, type SceneSpec } from "./schema";
import { stageError, StudioError } from "../core/errors";
import { motion } from "../core/designSystem";

export interface ValidationResult {
  success: boolean;
  sceneId?: string;
  errors: string[];
  scene?: SceneSpec;
}

const formatIssues = (issues: { path: (string | number)[]; message: string }[]): string[] =>
  issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);

/** Hard validation gate. Never silently repairs structurally invalid AI output. */
export function validateScene(input: unknown, sceneIdHint?: string): ValidationResult {
  const parsed = sceneSchema.safeParse(input);
  if (parsed.success) {
    return { success: true, sceneId: parsed.data.sceneId, errors: [], scene: parsed.data };
  }
  const candidate =
    input && typeof input === "object" && "sceneId" in input
      ? String((input as { sceneId: unknown }).sceneId)
      : sceneIdHint;
  return {
    success: false,
    sceneId: candidate,
    errors: formatIssues(parsed.error.issues),
  };
}

export function assertValidScene(input: unknown, projectId?: string, sceneIdHint?: string): SceneSpec {
  const result = validateScene(input, sceneIdHint);
  if (!result.success || !result.scene) {
    throw new StudioError({
      stage: "validation",
      projectId,
      sceneId: result.sceneId ?? sceneIdHint,
      recoverable: false,
      explanation: `Scene failed validation:\n- ${result.errors.join("\n- ")}`,
      data: { errors: result.errors },
    });
  }
  return result.scene;
}

export function validateScenes(
  inputs: unknown[],
  projectId?: string,
): { valid: SceneSpec[]; failures: { index: number; sceneId?: string; errors: string[] }[] } {
  const valid: SceneSpec[] = [];
  const failures: { index: number; sceneId?: string; errors: string[] }[] = [];
  inputs.forEach((input, index) => {
    const r = validateScene(input, `scene_${String(index + 1).padStart(2, "0")}`);
    if (r.success && r.scene) valid.push(r.scene);
    else failures.push({ index, sceneId: r.sceneId, errors: r.errors });
  });
  return { valid, failures };
}

/** Cross-scene checks: timeline continuity, motion system budget, accent discipline. */
export function validateProjectTimeline(scenes: SceneSpec[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  let accentUsage = new Map<string, string[]>();

  scenes.forEach((s, i) => {
    if (seen.has(s.sceneId)) errors.push(`duplicate sceneId "${s.sceneId}"`);
    seen.add(s.sceneId);
    if (s.duration < motion.durations.scene.min) {
      errors.push(
        `${s.sceneId}: duration ${s.duration}s below minimum ${motion.durations.scene.min}s (index ${i})`,
      );
    }
    const accents = s.elements
      .filter((e) => typeof e.accent === "string" && e.accent !== "none")
      .map((e) => e.accent as string);
    accentUsage.set(s.sceneId, accents);
    const unique = new Set(accents);
    if (unique.size > 2) {
      errors.push(`${s.sceneId}: more than 2 distinct accents in one scene (${[...unique].join(", ")})`);
    }
  });
  return errors;
}

export function totalDurationSec(scenes: SceneSpec[]): number {
  return scenes.reduce((n, s) => n + s.duration, 0);
}
