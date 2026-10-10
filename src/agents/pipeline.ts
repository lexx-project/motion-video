import fs from "fs";
import path from "path";
import { initProject, readJson, updateManifest, markStage, writeJson, readManifest, wrapUnknown, listScenes, projectDir } from "../core/projectStore";
import { stageError, StudioError } from "../core/errors";
import { PIPELINE } from "../core/output";
import { runScriptAnalysis, runBeatGeneration } from "./scriptAnalyst";
import type { TimingBeat, Timestamps } from "./scriptAnalyst";
import { runVoTiming } from "./voTiming";
import { runStoryboardStage, loadStoryboards, densityBudgetFor, regenerateStoryboard } from "./storyboard";
import { runSceneGeneration, regenerateScene } from "./motionPlanner";
import { noveltyStage, commitProjectMemory, runNoveltyCheck } from "./novelty";
import {
  technicalQa,
  visionQa,
  slopCritic,
  aggregateQa,
  collectFrames,
  collectFrameEvidence,
  type BeatContext,
  type QaBundle,
} from "./qa";
import { buildRepairPlan, repairScene, sceneBeat } from "./repair";
import { runSemanticQa } from "./semanticQa";
import { renderProject } from "../render/renderProject";
import { validateScene } from "../validation/validate";
import { runConformance } from "../reference/conformance";
import {
  ensureRenderRecord,
  readQaRecord,
  readRenderRecord,
  recordFinal,
  recordQa,
  recordRender,
  summarizeConsistency,
  verifyConsistency,
} from "../core/artifacts";
import { createSnapshotUnique } from "../core/snapshot";
import { summarizeDiagnostics, writeDiagnostics } from "../core/diagnostics";
import { evaluateProjectLayoutGate } from "../validation/layoutGate";
import { evaluateVisualGates } from "../validation/visualGates";
import { evaluatePreRenderGate, summarizePreRenderGate } from "../validation/preRenderGate";
import { collisionSemantics, type CollisionReport } from "../validation/collisionSemantics";
import { classifyFailures } from "./repairContext";
import { runTargetedRepair, RepairBudgetTracker, REPAIR_BUDGET } from "./repairLoop";
import { buildMetricVector, type MetricSources } from "./repairCompare";
import { runBoundedLegacyRepair } from "./legacyRepair";
import { llmRepairProvider } from "./repairProviders";
import { evaluateSemanticEnactment } from "../validation/semanticEnactment";
import { collectEventEvidence } from "./eventEvidence";
import { reconcileSemanticContract, summarizeContract } from "../validation/semanticContract";
import { applyCompositionFixes, type CompositionFix } from "../validation/compositionFixes";
import { evaluateCompositionQuality } from "../validation/compositionQuality";
import {
  beginGenerationBudget,
  endGenerationBudget,
  isBudgetExhausted,
  BudgetExhaustedError,
  type BudgetSummary,
  type GenerationBudget,
  type GenerationBudgetConfig,
} from "../core/generationBudget";
import type { FrameEvidenceReport } from "../render/frameEvidence";
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
  /**
   * Fixture provenance (Batch C / §16). Set only when this project was COPIED from an existing
   * one (test/E2E): novelty then skips comparing against that source project instead of
   * rejecting a self-copy and triggering expensive production repair. Production runs omit it -
   * thresholds and every other project comparison are untouched.
   */
  fixture?: { copiedFrom?: string };
  /** Batch E / Phase 1: generation-level budget overrides (strict wall clock, call caps). */
  budget?: Partial<GenerationBudgetConfig>;
  onProgress?: (stage: string, detail?: string) => void;
}

export interface GenerateResult {
  projectId: string;
  /**
   * complete  = finalized artifacts, full QA cycle ran (existing semantics preserved)
   * partial   = finalized + consistent artifacts, but the generation budget ran out during
   *             the repair/QA rounds (structured partial result - never a silent PASS)
   * failed    = could not finalize (required stage failed or budget died first)
   */
  status: "complete" | "partial" | "failed";
  sceneIds: string[];
  qa?: QaBundle;
  previewFile?: string;
  finalFile?: string;
  error?: string;
  /** Batch E: stage timeline + provider call durations + budget consumption */
  budget?: BudgetSummary;
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

  // Batch E / Phase 1: one wall-clock budget for the WHOLE generation (LLM calls, judges,
  // targeted + legacy repair, rerenders, QA reruns). Exhaustion -> structured failed/partial.
  const budget: GenerationBudget = beginGenerationBudget(opts.budget ?? {});

  type BeatWithTiming = Beats["beats"][number] & { timing?: TimingBeat };

  try {
    progress("analysis", "analyzing script");
    const analysis: Analysis =
      (resume ? readJson<Analysis>(projectId, "analysis/script-analysis.json") : null) ??
      (await budget.stage("analysis", () => runScriptAnalysis(projectId)));
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
      const timed = await budget.stage("beats", async () => {
        const b = await runBeatGeneration(projectId, analysis);
        progress("timing", "aligning VO timing");
        const t = await runVoTiming(projectId, b);
        return { b, t };
      });
      beats = timed.b;
      beatsWithTiming = timed.t.beatsWithTiming;
      timestamps = timed.t.timestamps;
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
      storyboards = await budget.stage("storyboards", () =>
        runStoryboardStage(
          projectId,
          analysis,
          beats,
          beatsWithTiming,
          budgetFor,
          (detail) => progress("concepts", detail),
        ),
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
        const fresh = await budget.stage("sceneGeneration", () => runSceneGeneration({ ...genCtx, only: toGenerate }));
        scenes = [...validStored, ...fresh].sort((a, b) => a.sceneId.localeCompare(b.sceneId));
      } else {
        scenes = validStored.sort((a, b) => a.sceneId.localeCompare(b.sceneId));
      }
      markStage(projectId, "sceneGeneration", "done");
      markStage(projectId, "validation", "done");
      progress("sceneGeneration", `using ${scenes.length - toGenerate.size} stored scene(s), regenerated ${toGenerate.size}`);
    } else {
      scenes = await budget.stage("sceneGeneration", () => runSceneGeneration(genCtx));
    }

    // Batch F §1: deterministic semantic-contract reconciliation between scene composition
    // and every stage that consumes the completed scenes. Micro-repairs are binding-only
    // (no model call); anything unresolved stays an explicit failure for the enactment gate.
    const reconciliation = scenes.map((scene) => reconcileSemanticContract(
      scene,
      sbList.find((sb) => sb.beatId === scene.storyboard?.beatId) ?? scene.storyboard,
      budget.exhausted(),
    ));
    scenes = reconciliation.map((r) => r.scene);
    // Batch G (WS-A): deterministic composition corrections (enter/fade masked by a later
    // entrance delay; static attachTo duplicating a timed attach event). Same purity rules:
    // candidate schema-validated, original returned on failure, no model call.
    const compositionFixesApplied: CompositionFix[] = [];
    scenes = scenes.map((scene) => {
      const fixed = applyCompositionFixes(scene);
      compositionFixesApplied.push(...fixed.fixes);
      return fixed.scene;
    });
    const contractReport = summarizeContract(reconciliation);
    writeJson(projectId, "qa/semantic-contract.json", contractReport);
    for (const r of reconciliation) {
      if (r.report.decision === "KEEP") writeJson(projectId, `scenes/${r.scene.sceneId}.json`, r.scene);
    }
    if (compositionFixesApplied.length > 0) {
      for (const s of scenes) writeJson(projectId, `scenes/${s.sceneId}.json`, s);
      progress(
        "repairing",
        `composition fixes: ${compositionFixesApplied.map((f) => `${f.sceneId}/${f.kind}:${f.target}`).join(", ")}`,
      );
    }
    progress(
      "repairing",
      `semantic contract: ${contractReport.ok ? "PASS" : "FAIL"} (${reconciliation
        .map((r) => `${r.scene.sceneId}:${r.report.decision}`)
        .join(", ")})`,
    );
    const dir = projectDir(projectId);
    const noveltyOpts = opts.fixture?.copiedFrom ? { excludeProjects: [opts.fixture.copiedFrom] } : {};
    // one call budget for the WHOLE generation (Batch C §13 - no uncontrolled repair loops)
    const repairTracker = new RepairBudgetTracker(REPAIR_BUDGET);

    // Batch D §18: semantic enactment gate - storyboard promises vs deterministic state.
    // Pure (no render, no LLM), so it runs before the first render AND after every change.
    let enactment = evaluateSemanticEnactment(scenes);
    writeJson(projectId, "qa/semantic-enactment.json", enactment);
    const refreshEnactment = (): typeof enactment => {
      enactment = evaluateSemanticEnactment(scenes);
      writeJson(projectId, "qa/semantic-enactment.json", enactment);
      return enactment;
    };

    progress("novelty", "novelty gate (pre-render)");
    let novelty = noveltyStage(projectId, scenes, noveltyOpts);
    if (novelty.status !== "pass") {
      if (budget.exhausted()) {
        // structured skip: the rejection stays visible in QA reasons - never a silent pass
        progress("repairing", "novelty repair skipped: generation budget exhausted (rejection remains in QA)");
      } else {
        scenes = await repairPass(projectId, scenes, novelty, beats, budget);
        refreshEnactment();
      }
      novelty = noveltyStage(projectId, scenes, noveltyOpts);
    }

    // Batch C §9: deterministic validation BEFORE the expensive render.
    // Model-detectable failures get a constrained repair; pixel-only problems are left to
    // post-render evidence (they cannot be predicted honestly before a render exists).
    progress("repairing", "pre-render layout gate");
    let preGate = await evaluatePreRenderGate(scenes);
    writeJson(projectId, "qa/pre-render-gate.json", preGate);
    progress("repairing", summarizePreRenderGate(preGate));
    if (!preGate.proceed || !enactment.ok) {
      const preFailures = classifyFailures({
        scenes,
        preRenderIssues: [...preGate.hard, ...preGate.warnings],
        collisions: collisionMap(scenes),
        semantic: enactment,
      });
      if (preFailures.length > 0) {
        if (budget.exhausted()) {
          // structured skip (documented): pre-render repair is an optimization - rendered
          // pixels stay the final authority, so the post-render gates still decide PASS.
          progress("repairing", "pre-render repair skipped: generation budget exhausted (pixel gates still arbitrate)");
        } else {
        progress("repairing", `pre-render repair for ${preFailures.length} failure(s): ${preFailures.map((f) => `${f.sceneId}/${f.type}`).join(", ")}`);
        const targeted = await runTargetedRepair({
          dir,
          scenes,
          round: 0,
          failures: preFailures,
          provider: llmRepairProvider,
          tracker: repairTracker,
          generationBudget: budget,
          baseline: {
            scenes,
            preRenderHard: preGate.hard.map((i) => ({ sceneId: i.sceneId, failureType: i.failureType, magnitude: i.magnitude })),
            collisions: collisionMap(scenes),
            semantic: enactment,
            artifactConsistent: true,
          },
          maxScenes: 3,
        });
        scenes = targeted.scenes;
        refreshEnactment();
        progress(
          "repairing",
          `pre-render repair: kept=${targeted.kept.join(",") || "-"} rolledBack=${targeted.rolledBack.join(",") || "-"} rejected=${targeted.rejected.join(",") || "-"} calls=${targeted.budgetUsed} remaining=${targeted.budgetRemaining}`,
        );
        preGate = await evaluatePreRenderGate(scenes);
        writeJson(projectId, "qa/pre-render-gate.json", preGate);
        progress("repairing", `pre-render gate after repair: ${summarizePreRenderGate(preGate)}`);
        progress("repairing", `semantic enactment: ${enactment.ok ? "PASS" : enactment.compact.join(" | ")}`);
        }
      }
    }
    writeDiagnostics(dir, { manifest: readManifest(projectId) });

    progress("rendering", "rendering preview");
    const previewFile = await budget.stage("render", () => renderWithProgress(projectId, scenes, progress, "preview"));

    progress("qa", "technical QA + frame extraction");
    const technical = await technicalQa(previewFile, scenes, readManifest(projectId).hasAudio);

    const beatContexts: BeatContext[] = beats.beats.map((b) => ({ id: b.id, text: b.text }));
    const audioRel = audioRelPath(projectId);
    // Batch E: the whole evidence+judge cycle is one budgeted stage. Exhaustion here is a
    // STRUCTURED FAILURE - judges are never silently skipped and QA is never claimed without them.
    let frames: string[] = [];
    let evidence!: FrameEvidenceReport;
    let deterministic!: Awaited<ReturnType<typeof evaluateDeterministicGates>>;
    let conformance!: Awaited<ReturnType<typeof runConformance>>;
    let visual!: QaBundle["visual"];
    let sop!: QaBundle["slop"];
    let semantic!: Awaited<ReturnType<typeof runSemanticQa>>;
    await budget.stage("qa", async () => {
      progress("qa", "reference conformance");
      frames = await collectFrames(projectId, scenes, audioRel, "r1");
      progress("qa", "frame evidence (early/mid/late + metrics)");
      evidence = await collectFrameEvidence(projectId, scenes, audioRel, "r1");
      deterministic = await evaluateDeterministicGates(projectId, scenes, evidence);
      conformance = await runConformance(projectId, scenes, frameMap(scenes, frames));
      progress("qa", "vision QA (3 independent evaluators)");
      visual = await visionQa(projectId, scenes, beatContexts, frames, deterministic);
      progress("qa", "slop critic");
      sop = await slopCritic(projectId, scenes, frames, deterministic);
      progress("qa", "semantic visual QA (Phase 3)");
      semantic = await runSemanticQa(projectId, scenes, beatContexts, analysis, frames, readManifest(projectId).hasAudio, enactment);
    });
    let qa = assembleQa(technical, visual, sop, novelty, conformance, semantic, deterministic, enactment);
    // A4/A6: bind this QA result to the render it actually scored (+ diagnostic summary)
    recordQa(dir, qa, { round: 0 });
    writeDiagnostics(dir, { manifest: readManifest(projectId) });

    let round = 0;
    let partial = false;
    const maxRounds = Math.min(PIPELINE.repairRoundsMax, REPAIR_BUDGET.maxRounds);
    while (qa.status !== "pass" && round < maxRounds) {
      if (budget.exhausted()) {
        // structured partial: rounds stop at the deadline; the QA verdict is NOT upgraded
        partial = true;
        progress(
          "repairing",
          `generation budget exhausted before round ${round + 1} - repair rounds stopped (qa=${qa.status}, structured partial result)`,
        );
        break;
      }
      round++;
      progress("repairing", `repair round ${round} (median-driven): ${qa.reasons.join(" | ")}`);

      try {
      // Batch C: deterministic evidence FIRST. Narrow, budgeted repairs for hard gate failures;
      // model-only measurement decides KEEP/ROLLBACK because this round re-renders anyway
      // (rendered pixels stay the final authority).
      const collisions = collisionMap(scenes);
      const detFailures = classifyFailures({
        scenes,
        layoutGate: deterministic.layoutGate ?? null,
        visualGates: deterministic.visualGates ?? null,
        collisions,
        semantic: enactment,
      }).filter((f) => f.severity === "hard" && f.source.startsWith("deterministic"));
      const handled = new Set<string>();
      if (detFailures.length > 0) {
        if (budget.exhausted()) {
          progress("repairing", "targeted repair skipped: generation budget exhausted (failures remain - QA verdict stays)");
        } else {
        progress("repairing", `deterministic failures: ${detFailures.map((f) => `${f.sceneId}/${f.type}`).join(", ")}`);
        const targeted = await runTargetedRepair({
          dir,
          scenes,
          round,
          failures: detFailures,
          provider: llmRepairProvider,
          tracker: repairTracker,
          generationBudget: budget,
          baseline: {
            scenes,
            layoutGate: deterministic.layoutGate ?? null,
            visualGates: deterministic.visualGates ?? null,
            collisions,
            semantic: enactment,
            frameEdgeInk: maxEdgeInk(evidence),
            artifactConsistent: true,
          },
          maxScenes: 2,
        });
        scenes = targeted.scenes;
        refreshEnactment();
        for (const id of targeted.kept) handled.add(id);
        progress(
          "repairing",
          `targeted repair: kept=${targeted.kept.join(",") || "-"} rolledBack=${targeted.rolledBack.join(",") || "-"} rejected=${targeted.rejected.join(",") || "-"} calls=${targeted.budgetUsed} remaining=${targeted.budgetRemaining}`,
        );
        }
      }

      const plan = buildRepairPlan(scenes, visual, sopGuard(sop), novelty, conformance, semantic);
      // Batch D: a round that KEPT a deterministic/semantic repair must still re-render and
      // re-measure even when the judge-driven plan is empty.
      if (plan.length === 0 && handled.size === 0) break;
      // A5: preserve the accepted baseline BEFORE any experiment mutates scene state
      const baseline = createSnapshotUnique(dir, `round-${round}-baseline`, {
        scenes,
        render: renderIdentity(dir),
        qa: qaIdentity(dir),
      });
      progress("repairing", `baseline snapshot "${baseline.label}" (${baseline.scenesHash.slice(0, 12)}) - restorable`);
      for (const item of plan.slice(0, 6)) {
        if (handled.has(item.sceneId)) continue; // already repaired from measured evidence this round
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

        // SEMANTIC-level repair (Phase 3 §41) + Batch E Phase 2: BOTH legacy paths now run
        // through the bounded wrapper (budget -> snapshot -> gates -> render-compare ->
        // KEEP/ROLLBACK -> ledger). A whole-storyboard rewrite must additionally preserve
        // every baseline semantic object / promised event.
        const sem = semantic?.scenes.find((r) => r.sceneId === item.sceneId);
        const semanticIssue =
          item.category === "semantic" ||
          (sem !== undefined && (sem.semanticRelevance < 6 || sem.visualStorytelling < 6));
        const useStoryboard = semanticIssue && Boolean(current.storyboard) && Boolean(beatMeta);

        const legacyBaseline: MetricSources = {
          scenes,
          layoutGate: deterministic.layoutGate ?? null,
          visualGates: deterministic.visualGates ?? null,
          collisions: collisionMap(scenes),
          semantic: enactment,
          frameEdgeInk: maxEdgeInk(evidence),
          artifactConsistent: true,
        };

        const storyRepair = async (): Promise<SceneSpec> => {
          const sb = await regenerateStoryboard(
            projectId,
            analysis,
            beatMeta!,
            item.reason,
            budgetFor(beatMeta!.id),
          );
          sbList = sbList.map((s) => (s.beatId === sb.beatId ? sb : s));
          const [fresh] = await runSceneGeneration({
            ...genCtx,
            storyboards: sbList,
            only: new Set([item.sceneId]),
          });
          if (!fresh) throw new Error("scene recompilation returned no scene");
          return fresh;
        };
        const sceneRepair = async (): Promise<SceneSpec> => {
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
          return scene;
        };

        let outcome = await runBoundedLegacyRepair({
          projectId,
          dir,
          scenes,
          sceneId: item.sceneId,
          budget,
          round,
          mode: useStoryboard ? "storyboard" : "scene",
          baselineMetrics: legacyBaseline,
          audioPath: audioRel,
          reason: item.reason,
          repair: useStoryboard ? storyRepair : sceneRepair,
        });
        scenes = outcome.scenes;
        progress(
          "repairing",
          `${item.sceneId}: legacy ${outcome.mode} repair -> ${outcome.decision} (${outcome.reason.slice(0, 180)})`,
        );

        // A storyboard rewrite that ERRORED before producing a candidate may fall back to a
        // narrow scene repair (claim released by the wrapper). A measured ROLLBACK never
        // retries without new evidence; SKIPPED_BUDGET stops immediately.
        if (outcome.decision === "ERROR" && useStoryboard) {
          outcome = await runBoundedLegacyRepair({
            projectId,
            dir,
            scenes,
            sceneId: item.sceneId,
            budget,
            round,
            mode: "scene",
            baselineMetrics: legacyBaseline,
            audioPath: audioRel,
            reason: `fallback after storyboard error: ${item.reason}`,
            repair: sceneRepair,
          });
          scenes = outcome.scenes;
          progress(
            "repairing",
            `${item.sceneId}: fallback scene repair -> ${outcome.decision} (${outcome.reason.slice(0, 160)})`,
          );
        }
        if (outcome.decision !== "KEEP" && outcome.decision !== "ERROR") continue;
      }
      novelty = noveltyStage(projectId, scenes);
      refreshEnactment();
      if (budget.exhausted()) {
        // no mutations happened yet this round beyond kept repairs - stop before re-render
        partial = true;
        progress("repairing", `generation budget exhausted after repairs (round ${round}) - stopping before re-render (structured partial result)`);
        break;
      }
      progress("rendering", `re-rendering preview after repair round ${round}`);
      await budget.stage("qa", async () => {
        await renderWithProgress(projectId, scenes, progress, "preview");
        const t2 = await technicalQa(previewFile, scenes, readManifest(projectId).hasAudio);
        frames = await collectFrames(projectId, scenes, audioRel, `r${round + 1}`);
        evidence = await collectFrameEvidence(projectId, scenes, audioRel, `r${round + 1}`);
        deterministic = await evaluateDeterministicGates(projectId, scenes, evidence);
        conformance = await runConformance(projectId, scenes, frameMap(scenes, frames));
        const visual2 = await visionQa(projectId, scenes, beatContexts, frames, deterministic);
        const sop2 = await slopCritic(projectId, scenes, frames, deterministic);
        semantic = await runSemanticQa(projectId, scenes, beatContexts, analysis, frames, readManifest(projectId).hasAudio, enactment);
        Object.assign(technical, t2);
        Object.assign(visual, visual2);
        Object.assign(sop, sop2);
        qa = assembleQa(t2, visual2, sop2, novelty, conformance, semantic, deterministic, enactment);
        recordQa(dir, qa, { round });
        writeDiagnostics(dir, { manifest: readManifest(projectId) });
      });
      } catch (e) {
        if (isBudgetExhausted(e)) {
          partial = true;
          progress(
            "repairing",
            `generation budget exhausted during round ${round} - repairs stopped (artifact consistency decides finalize): ${(e as Error).message.slice(0, 160)}`,
          );
          break;
        }
        throw e;
      }
    }

    // Batch D §27: event-specific evidence stills (pre / at / post) for scenes whose
    // storyboard carries an executable contract. Legacy scenes cost nothing here.
    if (budget.exhausted()) {
      partial = true;
      progress("qa", "event evidence skipped: generation budget exhausted (structured partial)");
    } else {
      try {
        const events = await collectEventEvidence(projectId, scenes, audioRel, { label: "events" });
        if (events.written.length > 0) {
          progress("qa", `event evidence: ${events.written.length} event report(s) under qa/events/`);
        }
      } catch (e) {
        progress("qa", `event evidence skipped: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
      }
    }

    if (qa.status === "fail" && qa.reasons.some((r) => r.startsWith("technical"))) {
      updateManifest(projectId, { status: "failed", lastError: qa.reasons.join("; ") });
      writeDiagnostics(dir, { manifest: readManifest(projectId) });
      const bsTech = endGenerationBudget();
      writeJson(projectId, "qa/generation-budget.json", bsTech);
      return { projectId, status: "failed", sceneIds: scenes.map((s) => s.sceneId), qa, previewFile, error: qa.reasons.join("; "), budget: bsTech ?? undefined };
    }

    progress("qa", "finalizing");
    const finalFile = projectFile(projectId, "renders", "final.mp4");
    fs.mkdirSync(path.dirname(finalFile), { recursive: true });
    fs.copyFileSync(previewFile, finalFile);
    // A4/A6: commit the final artifact with its identity, then verify the whole chain
    recordFinal(dir, { file: finalFile, copiedFrom: previewFile, scenes });
    const consistency = verifyConsistency(dir, {
      requireQa: true,
      requireFinal: true,
      manifest: readManifest(projectId),
    });
    progress("qa", `artifact consistency: ${summarizeConsistency(consistency)}`);

    if (!consistency.ok) {
      // Evidence-based state transition: a run may not claim "complete" while its artifacts
      // disagree (stale final, QA bound to another render, scenes changed after render, ...).
      //
      // SCOPE NOTE (A6): this gates ARTIFACT CONSISTENCY only. Extending "complete" to also
      // require qa.status === "pass" is deliberately NOT done here - it would change the
      // documented behaviour of completing with honest failing QA numbers (STATUS_PHASE3.md)
      // and must be decided together with the Batch B/C quality gates. That is the remaining
      // dependency for a full "complete only if QA pass" policy.
      const detail = summarizeConsistency(consistency);
      writeDiagnostics(dir, { manifest: { status: "failed" } });
      markStage(projectId, "final", "failed", detail);
      updateManifest(projectId, { status: "failed", lastError: `artifact consistency: ${detail}` });
      progress("failed", `finalization blocked by inconsistent artifacts: ${detail}`);
      const bsCon = endGenerationBudget();
      writeJson(projectId, "qa/generation-budget.json", bsCon);
      return {
        projectId,
        status: "failed",
        sceneIds: scenes.map((s) => s.sceneId),
        qa,
        previewFile,
        finalFile,
        error: `artifact consistency: ${detail}`,
        budget: bsCon ?? undefined,
      };
    }

    commitProjectMemory(projectId, scenes);
    markStage(projectId, "final", "done");
    // Batch E: persist the generation budget BEFORE diagnostics so they carry the timeline.
    const budgetSummary = endGenerationBudget();
    writeJson(projectId, "qa/generation-budget.json", budgetSummary);
    const ranPartial = partial || budgetSummary?.exhausted === true;
    updateManifest(projectId, {
      status: "complete",
      lastError: ranPartial
        ? "generation budget exhausted - structured partial result (repair rounds / evidence cut short; QA verdict unchanged)"
        : undefined,
    });
    const diagnostics = writeDiagnostics(dir, { manifest: { status: "complete" } });
    progress(
      "complete",
      `project ${projectId} complete (${qa.status}${ranPartial ? ", partial" : ""}) - ${summarizeDiagnostics(diagnostics)}`,
    );

    return {
      projectId,
      status: ranPartial ? "partial" : "complete",
      sceneIds: scenes.map((s) => s.sceneId),
      qa,
      previewFile,
      finalFile,
      budget: budgetSummary ?? undefined,
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

    // Batch E: ALWAYS persist the budget timeline + diagnostics on failure (structured or
    // not) - a failed run must still explain where its time went.
    const data = err.data as { budgetExhausted?: boolean; duplicatePrompt?: boolean } | null;
    const structured = isBudgetExhausted(e) || Boolean(data?.duplicatePrompt);
    const summary = endGenerationBudget();
    if (summary) {
      try {
        writeJson(projectId, "qa/generation-budget.json", summary);
        writeDiagnostics(projectDir(projectId), { manifest: { status: "failed" } });
      } catch {
        // diagnostics must not mask the original error
      }
    }
    if (structured && summary) {
      return {
        projectId,
        status: "failed",
        sceneIds: listScenes(projectId).map((s) => s.sceneId),
        error: err.explanation,
        budget: summary,
      };
    }
    throw err;
  }
}

const sopGuard = (slop: QaBundle["slop"]): QaBundle["slop"] => slop;

/** Per-scene collision classification (intentional vs unintended) for classification/compare. */
function collisionMap(scenes: SceneSpec[]): Record<string, CollisionReport> {
  const out: Record<string, CollisionReport> = {};
  for (const s of scenes) out[s.sceneId] = collisionSemantics(s);
  return out;
}

/** Highest edge-ink measured anywhere in the evidence (null when no evidence yet). */
function maxEdgeInk(ev: FrameEvidenceReport | null): number | null {
  if (!ev || ev.sceneRollup.length === 0) return null;
  return ev.sceneRollup.reduce((m, r) => Math.max(m, r.maxEdgeInk ?? 0), 0);
}

/**
 * Novelty-only repair pass (MASTER_SPEC section 10: reject -> request alternative -> re-evaluate).
 * Repairs only the rejected scenes; everything else stays untouched.
 */
async function repairPass(
  projectId: string,
  scenes: SceneSpec[],
  novelty: ReturnType<typeof noveltyStage>,
  beats: Beats,
  budget: GenerationBudget,
): Promise<SceneSpec[]> {
  let next = scenes;
  for (const r of novelty.results.filter((x) => x.verdict === "reject")) {
    const current = next.find((s) => s.sceneId === r.sceneId);
    if (!current) continue;
    // Batch E: novelty alternatives are legacy repairs too - same budget, one per scene
    const allowed = budget.allowLegacyRepair(r.sceneId, "scene");
    if (!allowed.ok) {
      budget.recordLegacySkip();
      continue;
    }
    budget.claimLegacyRepair(r.sceneId);
    const t0 = Date.now();
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
      budget.recordLegacyRepair({
        sceneId: r.sceneId,
        mode: "scene",
        decision: "KEEP",
        ms: Date.now() - t0,
        reason: `novelty alternative applied for ${r.against}`,
      });
    } catch (e) {
      // novelty repair is best-effort: a failed alternative must not kill the run
      budget.recordLegacyRepair({
        sceneId: r.sceneId,
        mode: "scene",
        decision: "ERROR",
        ms: Date.now() - t0,
        reason: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      });
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
  deterministic?: {
    layoutGate?: QaBundle["layoutGate"];
    visualGates?: QaBundle["visualGates"];
    evidence?: FrameEvidenceReport | null;
  },
  enactment?: QaBundle["enactment"],
): QaBundle {
  const agg = aggregateQa(technical, visual, slop, novelty, conformance, semantic, {
    layoutGate: deterministic?.layoutGate ?? null,
    visualGates: deterministic?.visualGates ?? null,
    enactment: enactment ?? null,
  });
  return {
    technical,
    visual,
    slop,
    novelty,
    conformance,
    semantic,
    ...agg,
    layoutGate: deterministic?.layoutGate ?? null,
    visualGates: deterministic?.visualGates ?? null,
    enactment: enactment ?? null,
    frameEvidence: deterministic?.evidence
      ? {
          label: deterministic.evidence.label,
          sampleCount: deterministic.evidence.samples.length,
          sceneRollup: deterministic.evidence.sceneRollup,
        }
      : null,
  };
}

/** Batch B: deterministic layout + readability gates over the measured frame evidence. */
async function evaluateDeterministicGates(
  projectId: string,
  scenes: SceneSpec[],
  evidence: FrameEvidenceReport,
): Promise<{ layoutGate: QaBundle["layoutGate"]; visualGates: QaBundle["visualGates"]; evidence: FrameEvidenceReport }> {
  const layoutGate = await evaluateProjectLayoutGate(scenes, evidence);
  const visualGates = evaluateVisualGates(scenes, evidence);
  writeJson(projectId, "qa/layout-gate.json", layoutGate);
  writeJson(projectId, "qa/visual-gates.json", visualGates);
  // Batch G (WS-A): composition-quality findings (band table, size, progression) are
  // evidence for repair/judges - warnings only, never a new hard gate.
  const composition = evaluateCompositionQuality(scenes, evidence);
  writeJson(projectId, "qa/composition-quality.json", composition);
  return { layoutGate, visualGates, evidence };
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
    // A4: bind the rendered artifact to the scene state that produced it
    recordRender(projectDir(projectId), { file: dest, scenes, label: name });
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
  const dir = projectDir(projectId);
  const preview = projectFile(projectId, "renders", "preview.mp4");
  const hasRender = fs.existsSync(preview);
  // A4: re-bind QA to the artifact that is actually on disk (hash recomputed, never assumed)
  if (hasRender) ensureRenderRecord(dir, preview, scenes, "preview");
  const technical = await technicalQa(preview, scenes, manifest.hasAudio);
  const audioRel = audioRelPath(projectId);
  const frames = await collectFrames(projectId, scenes, audioRel, "qa");
  const evidence = hasRender ? await collectFrameEvidence(projectId, scenes, audioRel, "qa") : null;
  const deterministic = evidence ? await evaluateDeterministicGates(projectId, scenes, evidence) : undefined;
  const conformance = await runConformance(projectId, scenes, frameMap(scenes, frames));
  const visual = await visionQa(projectId, scenes, beatContexts, frames, deterministic);
  const slop = await slopCritic(projectId, scenes, frames, deterministic);
  const enactment = evaluateSemanticEnactment(scenes);
  writeJson(projectId, "qa/semantic-enactment.json", enactment);
  const semantic = analysis ? await runSemanticQa(projectId, scenes, beatContexts, analysis, frames, manifest.hasAudio, enactment) : undefined;
  const qa = assembleQa(technical, visual, slop, novelty, conformance, semantic, deterministic, enactment);
  if (hasRender) recordQa(dir, qa, { round: 0 });
  else writeJson(projectId, "qa/qa-summary.json", qa);
  writeDiagnostics(dir, { manifest: readManifest(projectId) });
  return qa;
}

/** Identity of the currently recorded render (for snapshot metadata). */
function renderIdentity(dir: string): { file: string; sha256: string } | null {
  const r = readRenderRecord(dir);
  return r ? { file: r.file, sha256: r.sha256 } : null;
}

/** Identity of the currently recorded QA result (for snapshot metadata). */
function qaIdentity(dir: string): { qaSha256: string; status: string; renderSha256: string | null } | null {
  const q = readQaRecord(dir);
  return q ? { qaSha256: q.qaSha256, status: q.status ?? "unknown", renderSha256: q.renderSha256 } : null;
}

export type { Analysis, Beats, Candidates, Selections, TimingBeat };
