import fs from "fs";
import path from "path";
import { initProject, readJson, updateManifest, markStage, writeJson, readManifest, wrapUnknown, listScenes } from "../core/projectStore";
import { stageError, StudioError } from "../core/errors";
import { PIPELINE } from "../core/output";
import { runScriptAnalysis, runBeatGeneration } from "./scriptAnalyst";
import type { TimingBeat, Timestamps } from "./scriptAnalyst";
import { runVoTiming } from "./voTiming";
import { runStoryboardStage, loadStoryboards, densityBudgetFor, regenerateStoryboard } from "./storyboard";
import { runSceneGeneration, regenerateScene } from "./motionPlanner";
import { noveltyStage, commitProjectMemory, runNoveltyCheck } from "./novelty";
import { technicalQa, visionQa, slopCritic, aggregateQa, collectFrames, type BeatContext, type QaBundle } from "./qa";
import { buildRepairPlan, repairScene, sceneBeat } from "./repair";
import { runSemanticQa } from "./semanticQa";
import { renderProject } from "../render/renderProject";
import { validateScene } from "../validation/validate";
import { runConformance } from "../reference/conformance";
import type { SceneSpec } from "../validation/schema";
import type { Storyboard } from "../validation/storyboardSchema";
import type { Analysis, Beats, Candidates, Selections } from "./schemas";

export interface GenerateOptions {
  projectId?: string;
  script: string;
  /** absolute path to an audio file to copy into the project as VO */
  voicePath?: string;
  title?: string;
  /** reuse finished stage artifacts from a previous failed run (Phase 7 caching) */
  resume?: boolean;
  onProgress?: (stage: string, detail?: string) => void;
}

export interface GenerateResult {
  projectId: string;
  status: "complete" | "failed";
  sceneIds: string[];
  qa?: QaBundle;
  previewFile?: string;
  finalFile?: string;
  error?: string;
}

const copyInto = (projectId: string, src: string): string => {
  const ext = path.extname(src) || ".mp3";
  const dest = path.join(process.cwd(), "projects", projectId, "input", `voice${ext}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return dest;
};

const projectFile = (projectId: string, ...parts: string[]): string =>
  path.join(process.cwd(), "projects", projectId, ...parts);

/**
 * Orchestrator (MASTER_SPEC section 9): analysis -> beats -> timing -> concepts ->
 * art direction -> scene JSON -> validation -> render -> QA (technical/vision/slop/novelty)
 * -> local repair loop -> final render -> project memory.
 */
export async function generateProject(opts: GenerateOptions): Promise<GenerateResult> {
  const projectId =
    opts.projectId ?? `proj_${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12)}`;
  const progress = opts.onProgress ?? (() => {});
  const resume = opts.resume === true;
  const existing = readJson<{ projectId: string }>(projectId, "manifest.json");
  if (!existing) {
    initProject(projectId, opts.script, opts.title);
  }
  if (opts.voicePath) copyInto(projectId, opts.voicePath);

  type BeatWithTiming = Beats["beats"][number] & { timing?: TimingBeat };

  try {
    progress("analysis", "analyzing script");
    const analysis: Analysis =
      (resume ? readJson<Analysis>(projectId, "analysis/script-analysis.json") : null) ??
      (await runScriptAnalysis(projectId));
    if (resume) markStage(projectId, "analysis", "done");

    progress("beats", "extracting semantic beats");
    let beats: Beats;
    let beatsWithTiming: TimingBeat[];
    let timestamps: Timestamps;
    const storedBeats = resume
      ? readJson<{ beats: BeatWithTiming[] }>(projectId, "analysis/beats.json")
      : null;
    const hasTiming = Boolean(storedBeats?.beats?.[0]?.timing);
    if (storedBeats && hasTiming) {
      beats = { beats: storedBeats.beats.map(({ timing: _t, ...b }) => b) };
      beatsWithTiming = storedBeats.beats.map((b) => b.timing as TimingBeat);
      timestamps =
        readJson<Timestamps>(projectId, "analysis/timestamps.json") ??
        ({ source: "estimated", phrases: [] } as Timestamps);
      markStage(projectId, "beats", "done");
      markStage(projectId, "timing", "done");
      progress("timing", "using stored VO timing");
    } else {
      beats = await runBeatGeneration(projectId, analysis);
      progress("timing", "aligning VO timing");
      const timing = await runVoTiming(projectId, beats);
      beatsWithTiming = timing.beatsWithTiming;
      timestamps = timing.timestamps;
    }

    progress("concepts", "visual storyboards (Phase 3 director)");
    const budgetFor = (beatId: string): { min: number; max: number } =>
      densityBudgetFor(analysis, beats.beats.find((b) => b.id === beatId) ?? {});
    let storyboards: Storyboard[] | null = resume ? loadStoryboards(projectId) : null;
    const storyboardsReady =
      Boolean(storyboards?.length) &&
      beats.beats.every((b) => storyboards!.some((s) => s.beatId === b.id));
    if (storyboardsReady) {
      markStage(projectId, "concepts", "done");
      progress("concepts", "using stored storyboards");
    } else {
      storyboards = await runStoryboardStage(
        projectId,
        analysis,
        beats,
        beatsWithTiming,
        budgetFor,
        (detail) => progress("concepts", detail),
      );
    }
    let sbList: Storyboard[] = storyboards ?? [];

    progress("sceneGeneration", "writing scene JSON");
    // Resume: keep every stored scene that still validates (e.g. under tightened rules),
    // regenerate ONLY the invalid/missing ones (Phase 2 §16 - invalidate the affected stage).
    const allStored = resume ? listScenes(projectId).map((s) => s.data as SceneSpec) : [];
    const validStored: SceneSpec[] = [];
    for (const s of allStored) {
      const v = validateScene(s);
      if (v.success && v.scene) validStored.push(v.scene);
    }
    const expectedIds = beats.beats.map((_, i) => `scene_${String(i + 1).padStart(2, "0")}`);
    const toGenerate = new Set(expectedIds.filter((id) => !validStored.some((s) => s.sceneId === id)));
    const genCtx = {
      projectId,
      analysisSummary: analysis.summary,
      beats,
      beatsWithTiming,
      storyboards: sbList,
      timestamps,
    };
    let scenes: SceneSpec[];
    if (allStored.length > 0 && toGenerate.size < expectedIds.length) {
      if (toGenerate.size > 0) {
        progress("sceneGeneration", `regenerating ${toGenerate.size} invalid scene(s): ${[...toGenerate].join(", ")}`);
        const fresh = await runSceneGeneration({ ...genCtx, only: toGenerate });
        scenes = [...validStored, ...fresh].sort((a, b) => a.sceneId.localeCompare(b.sceneId));
      } else {
        scenes = validStored.sort((a, b) => a.sceneId.localeCompare(b.sceneId));
      }
      markStage(projectId, "sceneGeneration", "done");
      markStage(projectId, "validation", "done");
      progress("sceneGeneration", `using ${scenes.length - toGenerate.size} stored scene(s), regenerated ${toGenerate.size}`);
    } else {
      scenes = await runSceneGeneration(genCtx);
    }

    progress("novelty", "novelty gate (pre-render)");
    let novelty = noveltyStage(projectId, scenes);
    if (novelty.status !== "pass") {
      scenes = await repairPass(projectId, scenes, novelty, beats);
      novelty = noveltyStage(projectId, scenes);
    }

    progress("rendering", "rendering preview");
    const previewFile = await renderWithProgress(projectId, scenes, progress, "preview");

    progress("qa", "technical QA + frame extraction");
    const technical = await technicalQa(previewFile, scenes, readManifest(projectId).hasAudio);

    const beatContexts: BeatContext[] = beats.beats.map((b) => ({ id: b.id, text: b.text }));
    progress("qa", "reference conformance");
    let frames = await collectFrames(projectId, scenes, audioRelPath(projectId), "r1");
    let conformance = await runConformance(projectId, scenes, frameMap(scenes, frames));
    progress("qa", "vision QA (3 independent evaluators)");
    const visual = await visionQa(projectId, scenes, beatContexts, frames);
    progress("qa", "slop critic");
    const sop = await slopCritic(projectId, scenes, frames);
    progress("qa", "semantic visual QA (Phase 3)");
    let semantic = await runSemanticQa(projectId, scenes, beatContexts, analysis, frames, readManifest(projectId).hasAudio);
    let qa = assembleQa(technical, visual, sop, novelty, conformance, semantic);

    let round = 0;
    while (qa.status !== "pass" && round < PIPELINE.repairRoundsMax) {
      round++;
      progress("repairing", `repair round ${round} (median-driven): ${qa.reasons.join(" | ")}`);
      const plan = buildRepairPlan(scenes, visual, sopGuard(sop), novelty, conformance, semantic);
      if (plan.length === 0) break;
      for (const item of plan.slice(0, 6)) {
        const current = scenes.find((s) => s.sceneId === item.sceneId);
        if (!current) continue;
        const beatIdx = Math.max(0, parseInt(item.sceneId.replace(/\D/g, ""), 10) - 1);
        const beatMeta = beats.beats[beatIdx];
        const beat = sceneBeat(
          item.sceneId,
          beats.beats.map((b) => ({ id: b.id, text: b.text, emphasisPhrase: b.emphasisPhrase })),
        );
        const vq = visual.scenes.find((s) => s.sceneId === item.sceneId);
        const sq = sopGuard(sop).findings.filter((f) => f.sceneId === item.sceneId);
        const nr = novelty.results.find((r) => r.sceneId === item.sceneId);
        const cf = conformance?.scenes.find((c) => c.sceneId === item.sceneId);

        // SEMANTIC-level repair (Phase 3 §41): weak meaning => regenerate the STORYBOARD
        // for this beat, then recompile ONLY this scene from the new storyboard.
        const sem = semantic?.scenes.find((r) => r.sceneId === item.sceneId);
        const semanticIssue =
          item.category === "semantic" ||
          (sem !== undefined && (sem.semanticRelevance < 6 || sem.visualStorytelling < 6));
        if (semanticIssue && current.storyboard && beatMeta) {
          try {
            const sb = await regenerateStoryboard(
              projectId,
              analysis,
              beatMeta,
              item.reason,
              budgetFor(beatMeta.id),
            );
            sbList = sbList.map((s) => (s.beatId === sb.beatId ? sb : s));
            const [fresh] = await runSceneGeneration({
              ...genCtx,
              storyboards: sbList,
              only: new Set([item.sceneId]),
            });
            if (fresh) {
              scenes = scenes.map((s) => (s.sceneId === fresh.sceneId ? fresh : s));
              progress("repairing", `${item.sceneId}: storyboard + scene regenerated (semantic root cause)`);
              continue;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            progress("repairing", `${item.sceneId} semantic repair failed, falling back to scene repair: ${msg.slice(0, 300)}`);
            // fall through to the scene-level repair below
          }
        }

        try {
          const { scene } = await repairScene({
            projectId,
            scene: current,
            beat,
            visualIssues: [
              ...(vq?.issues ?? []),
              ...(item.category !== "composition" ? [item.reason] : vq?.issues?.length ? [] : [item.reason]),
            ],
            visualRepairs: vq?.recommendedRepair ?? [],
            slopFindings: sq,
            novelty: nr?.verdict !== "accept" ? nr : undefined,
            conformance:
              cf && (cf.overall < 6 || cf.evidence.some((e) => e.startsWith("COLLISION") || e.startsWith("SUBTITLE_COLLISION")))
                ? cf
                : undefined,
            category: item.category,
          });
          scenes = scenes.map((s) => (s.sceneId === scene.sceneId ? scene : s));
        } catch (e) {
          // Repair is best-effort per scene: LLM/timeout failures must not invalidate
          // completed upstream stages (Phase 2 §15). The scene stays as-is; QA re-checks it.
          const msg = e instanceof Error ? e.message : String(e);
          progress("repairing", `scene ${item.sceneId} repair skipped: ${msg.slice(0, 500)}`);
          continue;
        }
      }
      novelty = noveltyStage(projectId, scenes);
      progress("rendering", `re-rendering preview after repair round ${round}`);
      await renderWithProgress(projectId, scenes, progress, "preview");
      const t2 = await technicalQa(previewFile, scenes, readManifest(projectId).hasAudio);
      frames = await collectFrames(projectId, scenes, audioRelPath(projectId), `r${round + 1}`);
      conformance = await runConformance(projectId, scenes, frameMap(scenes, frames));
      const visual2 = await visionQa(projectId, scenes, beatContexts, frames);
      const sop2 = await slopCritic(projectId, scenes, frames);
      semantic = await runSemanticQa(projectId, scenes, beatContexts, analysis, frames, readManifest(projectId).hasAudio);
      Object.assign(technical, t2);
      Object.assign(visual, visual2);
      Object.assign(sop, sop2);
      qa = assembleQa(t2, visual2, sop2, novelty, conformance, semantic);
    }

    writeJson(projectId, "qa/qa-summary.json", qa);

    if (qa.status === "fail" && qa.reasons.some((r) => r.startsWith("technical"))) {
      updateManifest(projectId, { status: "failed", lastError: qa.reasons.join("; ") });
      return { projectId, status: "failed", sceneIds: scenes.map((s) => s.sceneId), qa, previewFile, error: qa.reasons.join("; ") };
    }

    progress("qa", "finalizing");
    const finalFile = projectFile(projectId, "renders", "final.mp4");
    fs.mkdirSync(path.dirname(finalFile), { recursive: true });
    fs.copyFileSync(previewFile, finalFile);

    commitProjectMemory(projectId, scenes);
    markStage(projectId, "final", "done");
    updateManifest(projectId, { status: "complete", lastError: undefined });
    progress("complete", `project ${projectId} complete (${qa.status})`);

    return {
      projectId,
      status: "complete",
      sceneIds: scenes.map((s) => s.sceneId),
      qa,
      previewFile,
      finalFile,
    };
  } catch (e) {
    const err = wrapUnknown(e, "internal", projectId);
    try {
      const m = readManifest(projectId);
      if (m?.stages) {
        for (const [st, val] of Object.entries(m.stages)) {
          if (val.status === "running") {
            markStage(projectId, st as Parameters<typeof markStage>[1], "failed", err.message);
          }
        }
      }
    } catch {
      // ignore secondary errors during failure cleanup
    }
    updateManifest(projectId, { status: "failed", lastError: err.message });
    progress("failed", err.message);
    throw err;
  }
}

const sopGuard = (slop: QaBundle["slop"]): QaBundle["slop"] => slop;

/**
 * Novelty-only repair pass (MASTER_SPEC section 10: reject -> request alternative -> re-evaluate).
 * Repairs only the rejected scenes; everything else stays untouched.
 */
async function repairPass(
  projectId: string,
  scenes: SceneSpec[],
  novelty: ReturnType<typeof noveltyStage>,
  beats: Beats,
): Promise<SceneSpec[]> {
  let next = scenes;
  for (const r of novelty.results.filter((x) => x.verdict === "reject")) {
    const current = next.find((s) => s.sceneId === r.sceneId);
    if (!current) continue;
    const beat = sceneBeat(
      r.sceneId,
      beats.beats.map((b) => ({ id: b.id, text: b.text, emphasisPhrase: b.emphasisPhrase })),
    );
    try {
      const { scene } = await repairScene({
        projectId,
        scene: current,
        beat,
        visualIssues: [],
        visualRepairs: [
          `Provide a genuinely different visual solution for the same meaning. Prior change matched ${r.against} on: ${r.matchedDimensions.join(", ")}.`,
        ],
        slopFindings: [],
        novelty: r,
      });
      next = next.map((s) => (s.sceneId === scene.sceneId ? scene : s));
    } catch (e) {
      // novelty repair is best-effort: a failed alternative must not kill the run
      const msg = e instanceof Error ? e.message : String(e);
      void msg;
      continue;
    }
  }
  return next;
}

function frameMap(scenes: SceneSpec[], frameFiles: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of scenes) {
    const hit = frameFiles.find((f) => f.includes(s.sceneId));
    if (hit) map.set(s.sceneId, hit);
  }
  return map;
}

function assembleQa(
  technical: QaBundle["technical"],
  visual: QaBundle["visual"],
  slop: QaBundle["slop"],
  novelty: QaBundle["novelty"],
  conformance?: QaBundle["conformance"],
  semantic?: QaBundle["semantic"],
): QaBundle {
  const agg = aggregateQa(technical, visual, slop, novelty, conformance, semantic);
  return { technical, visual, slop, novelty, conformance, semantic, ...agg };
}

function audioRelPath(projectId: string): string | undefined {
  const hasAudio = readManifest(projectId).hasAudio;
  if (!hasAudio) return undefined;
  const dir = projectFile(projectId, "input");
  const f = fs.readdirSync(dir).find((x) => /\.(mp3|wav|m4a|ogg|webm|aac|flac)$/i.test(x));
  if (!f) return undefined;
  // public dir is the staticFile root; copy the VO there under the project id
  const pubDir = path.join(process.cwd(), "public", projectId);
  fs.mkdirSync(pubDir, { recursive: true });
  const dest = path.join(pubDir, path.basename(f));
  if (!fs.existsSync(dest)) fs.copyFileSync(path.join(dir, f), dest);
  return `${projectId}/${path.basename(f)}`;
}

async function renderWithProgress(
  projectId: string,
  scenes: SceneSpec[],
  progress: (s: string, d?: string) => void,
  name: string,
): Promise<string> {
  markStage(projectId, "render", "running");
  try {
    const audioPath = audioRelPath(projectId);
    const file = await renderProject({
      scenes,
      audioPath,
      outputName: "render-tmp.mp4",
      onProgress: (p) => progress("rendering", `${name} ${Math.round(p * 100)}%`),
    });
    const dest = projectFile(projectId, "renders", `${name}.mp4`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    markStage(projectId, "render", "done");
    return dest;
  } catch (e) {
    markStage(projectId, "render", "failed", String(e));
    throw stageError("render", e instanceof Error ? e.message : String(e), { projectId, recoverable: false });
  }
}

/** Scene-level regeneration entry point used by the UI. */
export async function regenerateOneScene(
  projectId: string,
  sceneId: string,
  notes: string,
): Promise<SceneSpec> {
  return regenerateScene(projectId, sceneId, notes);
}

export async function rerunQa(projectId: string): Promise<QaBundle> {
  const manifest = readManifest(projectId);
  const sceneFiles = fs.readdirSync(projectFile(projectId, "scenes")).filter((f) => /^scene_\d+\.json$/.test(f));
  const scenes = sceneFiles
    .sort()
    .map((f) => readJson<SceneSpec>(projectId, `scenes/${f}`))
    .filter((s): s is SceneSpec => Boolean(s));
  const beats = readJson<Beats>(projectId, "analysis/beats.json");
  const beatContexts: BeatContext[] = (beats?.beats ?? []).map((b) => ({ id: b.id, text: b.text }));
  const analysis = readJson<Analysis>(projectId, "analysis/script-analysis.json");
  const novelty = noveltyStage(projectId, scenes);
  const preview = projectFile(projectId, "renders", "preview.mp4");
  const technical = await technicalQa(preview, scenes, manifest.hasAudio);
  const frames = await collectFrames(projectId, scenes, audioRelPath(projectId), "qa");
  const conformance = await runConformance(projectId, scenes, frameMap(scenes, frames));
  const visual = await visionQa(projectId, scenes, beatContexts, frames);
  const slop = await slopCritic(projectId, scenes, frames);
  const semantic = analysis ? await runSemanticQa(projectId, scenes, beatContexts, analysis, frames, manifest.hasAudio) : undefined;
  const qa = assembleQa(technical, visual, slop, novelty, conformance, semantic);
  writeJson(projectId, "qa/qa-summary.json", qa);
  return qa;
}

export type { Analysis, Beats, Candidates, Selections, TimingBeat };
