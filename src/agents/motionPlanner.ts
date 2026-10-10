import { completeJson } from "./llm";
import { designBiblePrompt, designBibleCompactPrompt, primitiveSpecsFor, sceneRulesPrompt, memoryPrompt } from "./context";
import { sceneListSchema, normalizeScenes, type Beats } from "./schemas";
import { markStage, writeJson, updateManifest, wrapUnknown, readJson } from "../core/projectStore";
import { stageError, type ErrorStage } from "../core/errors";
import { validateScene, validateProjectTimeline } from "../validation/validate";
import { textCollisions } from "../reference/conformance";
import { motion } from "../core/designSystem";
import type { SceneSpec } from "../validation/schema";
import type { Storyboard } from "../validation/storyboardSchema";
import { compileExecutionPlan } from "../validation/executionPlan";
import type { TimingBeat, Timestamps } from "./scriptAnalyst";

export interface ScenePlanContext {
  projectId: string;
  analysisSummary: string;
  beats: Beats;
  beatsWithTiming: TimingBeat[];
  /** Selected + expanded visual storyboards (one per beat) — the semantic source (Phase 3). */
  storyboards: Storyboard[];
  timestamps: Timestamps;
  /** When set, only these sceneIds are (re)generated - resume invalidates only bad scenes. */
  only?: Set<string>;
}

interface BeatMeta {
  id: string;
  text: string;
  important?: boolean;
  visualPriority?: string;
  typographyPriority?: string;
  emphasisPhrase?: string;
  timing?: { start: number; end: number; duration: number; source: string };
}

const clampDuration = (d: number | undefined): number =>
  Math.min(motion.durations.scene.max, Math.max(motion.durations.scene.min, d ?? 3.5));

/**
 * Deterministic subtitle injection (Phase 3 §13-15): the model plans WHEN/WHY a caption
 * exists (subtitlePlan); the exact phrase text + times come from timestamps.json — never
 * invented, never fake word precision. Phrase-level only.
 */
function buildSubtitle(
  storyboard: Storyboard,
  timestamps: Timestamps | undefined,
  windowStart: number,
  duration: number,
): NonNullable<SceneSpec["subtitle"]> {
  const disabled = { enabled: false as const, role: "vo caption", phrases: [] };
  if (!timestamps || !timestamps.phrases.length || timestamps.source === "estimated") return disabled;
  const phrases = timestamps.phrases
    .filter((p) => p.end > windowStart + 0.05 && p.start < windowStart + duration - 0.05)
    .slice(0, 6)
    .map((p) => {
      const text = p.text.trim();
      const emphasis = (storyboard.subtitlePlan.text ?? "")
        ? storyboard.typographyPlan.emphasisWords.filter((w) =>
            text.toLowerCase().includes(w.toLowerCase()),
          )
        : [];
      return {
        text,
        start: Math.max(0, Number((p.start - windowStart).toFixed(2))),
        end: Math.min(duration, Number((p.end - windowStart).toFixed(2))),
        ...(emphasis.length ? { emphasisWords: emphasis.slice(0, 2) } : {}),
      };
    })
    .filter((p) => p.end - p.start > 0.15);
  if (phrases.length === 0) return disabled;
  return {
    enabled: true,
    role: (storyboard.subtitlePlan.role || "vo caption").slice(0, 80),
    phrases,
  };
}

/** Stage: STORYBOARD → Scene JSON (the Scene Composer / storyboard compiler, Phase 3 §29). */
export async function runSceneGeneration(ctx: ScenePlanContext): Promise<SceneSpec[]> {
  markStage(ctx.projectId, "sceneGeneration", "running");
  try {
    const scenes: SceneSpec[] = [];
    const beatMetas = ctx.beats.beats as BeatMeta[];
    let cursor = 0; // project timeline cursor for deterministic subtitle windows

    for (let i = 0; i < beatMetas.length; i++) {
      const beat = beatMetas[i];
      const timing = ctx.beatsWithTiming[i];
      const duration = clampDuration(timing?.duration);
      const windowStart = cursor;
      cursor += duration;
      const sceneId = `scene_${String(i + 1).padStart(2, "0")}`;
      const storyboard = ctx.storyboards.find((s) => s.beatId === beat.id);
      if (ctx.only && !ctx.only.has(sceneId)) continue;

      if (!storyboard) {
        throw stageError(
          "sceneGeneration",
          `No storyboard for beat ${beat.id} - cannot compile scene`,
          { projectId: ctx.projectId, sceneId, recoverable: false },
        );
      }

      let collisionRetries = 0;
      const scene = await completeJson<SceneSpec>({
        stage: "sceneGeneration" as ErrorStage,
        projectId: ctx.projectId,
        temperature: 0.4,
        maxTokens: 12000,
        attempts: 4,
        reasoningEffort: "none",
        system: `You are the SCENE COMPOSER (storyboard compiler) of a motion-design studio (Phase 3).
${designBibleCompactPrompt()}

Common element params (all optional unless noted): position(topLeft|topCenter... use: center|left|right|top|bottom|topLeft|topRight|bottomLeft|bottomRight), offsetX/offsetY(-50..50, inward-only on edges), scale(0.2..3), opacity, rotation, accent(none|teal|gold|orange|red), size(sm|md|lg|xl), delay(0-60s), entrance/emphasis/exit overrides, role(semantic|supporting|decorative), purpose(<=80). Primitive-specific params (text/label/value/items/...) and their enums are validated - if you guess wrong the validation error lists the ALLOWED values, so prefer common params and well-known shapes (text primitives take "text").

${sceneRulesPrompt()}

${memoryPrompt(ctx.projectId)}

Compile ONE visual storyboard into ONE scene JSON. AI decides WHAT it means (the storyboard
already did that); YOU decide how the primitives realize it deterministically.

Rules:
- Structure ONLY - never JSX/Remotion code. Do NOT output "storyboard", "subtitle" or
  "executionPlan" fields - the system embeds the storyboard verbatim, injects subtitle timing
  from VO data and compiles the execution plan from motionBeats.
- Fields: sceneId, duration (EXACT value given), purpose (<=200), visualConcept (<=80),
  composition (grammar that BEST serves storyboard.compositionIntent), headline
  (optional, from typographyPlan.headline; if the grammar puts the headline at a LEFT/RIGHT anchor keep it <=28 chars - only ~8 chars fit per rendered line there), elements[], motion, timing{entranceAt:0,...}.
- Elements: compile storyboard.semanticObjects + typographyPlan + visualNarrative into 3-10
  primitives (elementBudget from storyboard, guidelines simple 3-5 / normal 5-8 / complex 7-10).
  Every NON-TEXT element MUST carry: role ("semantic" for meaning-carriers, "supporting" for
  helpers; "decorative" is nearly forbidden) and purpose (<=120 chars: WHY this object exists -
  "to make it look interesting" is invalid). Text elements should also carry role when they do
  more than headline duty (subtitle-like caption text is FORBIDDEN - the system renders the VO
  subtitle band separately).
- SEMANTIC IDS (hard contract): every element compiled from a storyboard semanticObject MUST
  carry semanticId exactly matching that object's id (e.g. person_01, gate_01). The semantic
  gate fails the scene when a promised id has no element. Elements without a storyboard source
  must NOT carry a semanticId.
- ATTACHMENT/RELATIONSHIPS: when storyboard relationships are STRUCTURED (type attachedTo),
  set attachTo="<parentId>" on the child element. For overlapsIntentionally set
  collisionIntent="intentional" on one of the two elements.
- Relationships from storyboard must be VISIBLE: interacting objects placed to show their
  relationship (facing, linking, containing, opposing) - not merely adjacent.
- Compile motionBeats into element delays/emphasisAt (staggered 0-1.2s; emphasisAt ~ the beat's
  emphasis moment); scene entrance/exit from vocabulary. The system separately embeds the
  deterministic execution plan (executionPlan) from motionBeats - you never write that field.
- ONE dominant accent; max 4 elements may carry an accent.
- If scene.headline present, never duplicate it as an element.
OUTPUT DISCIPLINE: purpose/role strings <= 80 chars; keep every string terse; write the scene
JSON directly without deliberating in prose. Do NOT write chain-of-thought or internal thoughts.
Output ONLY JSON {"scenes":[ sceneObject ]} with exactly ONE scene, sceneId="${sceneId}".

Example shape (real values for THIS scene):
{"scenes":[{"sceneId":"${sceneId}","duration":${duration.toFixed(2)},"purpose":"...","visualConcept":"...","composition":"centered","headline":{"text":"SHORT IMPACT LINE","accentWords":["WORD"],"align":"left"},"elements":[{"primitive":"Person","position":"left","accent":"none","role":"semantic","purpose":"the person receiving judgment"},{"primitive":"SpeechBubble","position":"right","accent":"gold","role":"semantic","purpose":"external label changing","text":"..."}],"motion":{"entrance":"fade","emphasis":"subtleScale","exit":"fade"},"timing":{"entranceAt":0,"emphasisAt":1.4}}]}`,
        user: [
          `# Beat\n${JSON.stringify({ ...beat, timing }, null, 1)}`,
          `# Visual storyboard (semantic source of truth; trimmed to compile-relevant fields)\n${JSON.stringify(
            (({ subtitlePlan: _s, forbiddenInterpretations: _f, noveltyIntent: _n, ...rest }) => rest)(storyboard),
            null,
            1,
          )}`,
          `# Scene window on project timeline: ${windowStart.toFixed(2)}s..${(windowStart + duration).toFixed(2)}s (subtitle timing is injected from this)`,
        ].join("\n\n"),
        parse: (obj) => {
          const parsed = sceneListSchema.parse(normalizeScenes(obj));
          const scene = parsed.scenes[0];
          // deterministic embed: storyboard travels with the scene (never model-echoed)
          scene.storyboard = storyboard;
          scene.subtitle = buildSubtitle(storyboard, ctx.timestamps, windowStart, duration);
          // Batch D: deterministic temporal execution plan compiled from motionBeats
          scene.executionPlan = compileExecutionPlan(scene);
          let check = validateScene(scene, sceneId);
          if (!check.success && scene.headline) {
            // Deterministic narrow-column fallback: if the ONLY failures are headline
            // line/char rules at a narrow anchor, auto-anchor the headline to the wide
            // TOP band (logged, re-validated - never a silent structural bypass).
            const headlineOnly = check.errors.every((e) => /headline/.test(e) && /(lines|chars)/.test(e));
            if (headlineOnly) {
              const retryScene = { ...scene, headline: { ...scene.headline, position: "top" } };
              const retry = validateScene(retryScene, sceneId);
              if (retry.success && retry.scene) {
                console.warn(
                  `[${sceneId}] headline auto-anchored to top band (narrow-column overflow): "${scene.headline.text.slice(0, 40)}"`,
                );
                Object.assign(scene, retry.scene, { storyboard: scene.storyboard, subtitle: scene.subtitle });
                check = validateScene(scene, sceneId);
              }
            }
          }
          if (!check.success) {
            throw stageError("validation", `Scene failed validation:\n- ${check.errors.join("\n- ")}`, {
              projectId: ctx.projectId,
              sceneId,
              recoverable: true,
            });
          }
          const cols = textCollisions(scene);
          if (cols.length > 0 && collisionRetries === 0) {
            collisionRetries += 1;
            throw stageError(
              "validation",
              `Layout collisions detected:\n- ${cols.map((c) => `${c.a} overlaps ${c.b} (${Math.round(c.ratio * 100)}%)`).join("\n")}\nMove the colliding items to different bands or to the SAME anchor (renderer stacks same-anchor items safely).`,
              { projectId: ctx.projectId, sceneId, recoverable: true },
            );
          }
          if (cols.length > 0) {
            console.warn(
              `[${sceneId}] accepted with unresolved collisions: ${cols.map((c) => `${c.a} x ${c.b}`).join(", ")}`,
            );
          }
          if (scene.sceneId !== sceneId) scene.sceneId = sceneId;
          scene.duration = Number(duration.toFixed(2));
          return scene;
        },
      });
      scenes.push(scene);
      writeJson(ctx.projectId, `scenes/${sceneId}.json`, scene);
    }

    const timelineErrors = validateProjectTimeline(scenes);
    if (timelineErrors.length > 0) {
      throw stageError("validation", `Project timeline invalid:\n- ${timelineErrors.join("\n- ")}`, {
        projectId: ctx.projectId,
        recoverable: false,
      });
    }

    updateManifest(ctx.projectId, {
      status: "validating",
      sceneIds: scenes.map((s) => s.sceneId),
    });
    markStage(ctx.projectId, "sceneGeneration", "done");
    markStage(ctx.projectId, "validation", "done");
    return scenes;
  } catch (e) {
    markStage(ctx.projectId, "sceneGeneration", "failed", String(e));
    throw wrapUnknown(e, "sceneGeneration", ctx.projectId);
  }
}

/**
 * Regenerate a single scene from the UI (Phase 3 §43): notes may request an alternative
 * visual mechanism / stronger semantics / different composition while keeping beat meaning.
 */
export async function regenerateScene(
  projectId: string,
  sceneId: string,
  notes: string,
): Promise<SceneSpec> {
  const existing = readJson<SceneSpec>(projectId, `scenes/${sceneId}.json`);
  if (!existing) {
    throw stageError("sceneGeneration", `Scene ${sceneId} not found`, { projectId, sceneId });
  }
  const scene = await completeJson<SceneSpec>({
    stage: "sceneGeneration" as ErrorStage,
    projectId,
    temperature: 0.6,
    maxTokens: 14000,
    reasoningEffort: "none",
    system: `You are the SCENE COMPOSER regenerating ONE scene (Phase 3).
${designBiblePrompt()}

${sceneRulesPrompt()}

Rewrite ONE scene JSON following the user's regeneration notes. Notes may request: an
alternative visual mechanism, stronger semantic visualization, more visual richness, a different
composition/metaphor/object system, or better subtitle integration - while preserving the beat's
meaning. If the mechanism changes, you MAY update the scene.storyboard field consistently
(strict storyboard contract: beatId unchanged, all required keys). Keep sceneId and duration.
Every NON-TEXT element needs role+purpose. No subtitle-like caption elements (VO band is separate).
Structure only - no code. Output ONLY JSON {"scenes":[sceneObject]}.`,
    user: `# Current scene\n${JSON.stringify(existing, null, 1)}\n\n# Regeneration notes\n${notes || "Improve semantic clarity, visual storytelling and novelty while staying on-message."}`,
    parse: (obj) => {
      const parsed = sceneListSchema.parse(normalizeScenes(obj));
      const scene = parsed.scenes[0];
      scene.sceneId = sceneId;
      scene.duration = existing.duration;
      if (!scene.storyboard) scene.storyboard = existing.storyboard; // keep semantic source unless revised
      if (!scene.subtitle) scene.subtitle = existing.subtitle;
      // Batch D: deterministic execution plan follows the (possibly revised) storyboard
      scene.executionPlan = compileExecutionPlan(scene);
      const check = validateScene(scene, sceneId);
      if (!check.success) {
        throw stageError("validation", `Regenerated scene invalid:\n- ${check.errors.join("\n- ")}`, {
          projectId,
          sceneId,
          recoverable: true,
        });
      }
      const rc = textCollisions(scene);
      if (rc.length > 0) {
        throw stageError(
          "validation",
          `Layout collisions detected:\n- ${rc.map((c) => `${c.a} overlaps ${c.b} (${Math.round(c.ratio * 100)}%)`).join("\n")}\nMove the colliding items to different bands or the SAME anchor.`,
          { projectId, sceneId, recoverable: true },
        );
      }
      return scene;
    },
  });
  writeJson(projectId, `scenes/${sceneId}.json`, scene);
  return scene;
}
