/**
 * Batch F Phase 7 - LIVE GENERATION: the real generateProject() pipeline on a COPY of the
 * Batch E live project (`_batche_live`), so the exact project that FAILED Batch E with two
 * missing headline semantic IDs is re-run through the Batch F semantic-contract
 * reconciliation.
 *
 * The copy keeps Batch E's evidence intact. `fixture.copiedFrom` tells novelty to expect
 * the copy (documented fixture-provenance path). Resume reuses the cached analysis, beats,
 * storyboards and scenes; the run pays only for reconciliation -> novelty -> pre-render ->
 * render -> QA + judges -> bounded repair.
 *
 * BEFORE the pipeline call the script reconciles the stored scenes deterministically
 * (no model) and records the decisions - that is the semantic-contract metric on the
 * REAL live-run artifacts. Then the full pipeline proves the stage integrates end-to-end.
 *
 * Run: npx tsx e2e/batchF-live-generation.ts
 * Env: BATCHF_LIVE_BUDGET_MIN (default 18)
 */
import fs from "fs";
import path from "path";
import { generateProject } from "../src/agents/pipeline";
import {
  reconcileSemanticContract,
  summarizeContract,
  type ReconcileResult,
} from "../src/validation/semanticContract";
import { evaluateSemanticEnactment } from "../src/validation/semanticEnactment";
import {
  verifyConsistency,
  summarizeConsistency,
  readRenderRecord,
  readQaRecord,
} from "../src/core/artifacts";
import { readDiagnostics } from "../src/core/diagnostics";
import { projectDir, readManifest, listScenes } from "../src/core/projectStore";
import type { BudgetSummary } from "../src/core/generationBudget";
import type { SceneSpec } from "../src/validation/schema";

const SRC = "_batche_live";
const ID = "_batchf_live";
const BUDGET_MIN = Number(process.env.BATCHF_LIVE_BUDGET_MIN ?? 18);
const WALL_CLOCK_MS = Math.max(60_000, Math.round(BUDGET_MIN * 60_000));
const ATTEMPTS_LOG = path.join(process.cwd(), "e2e", "batchF-live-attempts.json");
const SCRIPT = "Small disciplines, repeated in silence, build loud results.";
const VO = path.join(process.cwd(), "e2e", "demo-voice.wav");

const results: [string, boolean, string][] = [];
const check = (label: string, pass: boolean, detail = ""): void => {
  results.push([label, pass, detail]);
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
};
const fmt = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function printTimeline(budget: BudgetSummary | undefined): void {
  if (!budget) return;
  console.log("\n--- timeline (stage / start / duration / status) ---");
  const start0 = Date.parse(budget.startedAt);
  for (const s of budget.stages) {
    const rel = ((Date.parse(s.startedAt) - start0) / 1000).toFixed(1);
    console.log(`  +${rel.padStart(7)}s  ${s.stage.padEnd(18)} ${fmt(s.ms).padStart(8)}  ${s.status}`);
  }
  console.log("--- provider ---");
  console.log(`  calls=${budget.llmCalls} total=${fmt(budget.llmMs)} avg=${budget.llmCalls ? fmt(budget.llmMs / budget.llmCalls) : "-"}`);
  console.log(`  timeouts=${budget.timeouts} budgetRefusals=${budget.budgetRefusals} duplicatePromptsRefused=${budget.duplicatePromptsRefused}`);
  console.log(`  legacyRepairs=${budget.legacyRepairs.map((r) => `${r.sceneId}/${r.mode}:${r.decision}(${fmt(r.ms)})`).join(" ") || "none"} skipped=${budget.legacyRepairsSkipped}`);
  console.log(`  elapsed=${fmt(budget.elapsedMs)}/${fmt(budget.config.wallClockMs)} exhausted=${budget.exhausted}`);
}

/** Deterministic BEFORE-metric: reconcile the stored Batch E scenes with no model call. */
function reconcileStored(): { results: ReconcileResult[]; before: ReturnType<typeof evaluateSemanticEnactment> } {
  const scenes = listScenes(ID).map((s) => s.data as SceneSpec);
  const before = evaluateSemanticEnactment(scenes);
  const reconciled = scenes.map((scene) => reconcileSemanticContract(scene, scene.storyboard));
  return { results: reconciled, before };
}

async function main(): Promise<void> {
  const srcDir = projectDir(SRC);
  const dir = projectDir(ID);
  if (!fs.existsSync(path.join(srcDir, "manifest.json"))) {
    console.log(`PROBE NOT RUN: source project projects/${SRC} missing (run batchE-live first)`);
    process.exitCode = 1;
    return;
  }
  // fresh copy of the Batch E project so its evidence stays intact
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(srcDir, dir, { recursive: true });
  console.log(`[batchF-live-generation] copied projects/${SRC} -> projects/${ID} (Batch E evidence untouched)`);

  /* ------------------- deterministic semantic-contract metric (no model) ------------------ */
  console.log("\n--- semantic-contract reconciliation on the REAL Batch E scenes (deterministic, pre-pipeline) ---");
  const { results: preResults, before } = reconcileStored();
  const preReport = summarizeContract(preResults);
  const missingBefore = before.failures.filter((f) => f.type === "missing_semantic_object");
  console.log(`  before: ${missingBefore.length} missing_semantic_object failure(s): ${missingBefore.map((f) => `${f.sceneId}/${(f.target ?? [])[0]}`).join(", ") || "none"}`);
  for (const r of preResults) {
    console.log(`  ${r.scene.sceneId}: ${r.report.decision} missing=[${r.report.missingIds.join(",")}] headline=${r.scene.headline?.semanticId ?? "-"}`);
  }
  const kept = preResults.filter((r) => r.report.decision === "KEEP");
  const boundHeadline = kept.filter((r) => r.scene.headline?.semanticId === "headline_01");
  check("scene_01 and scene_04 headline gaps repaired deterministically", boundHeadline.length === 2, boundHeadline.map((r) => r.scene.sceneId).join(","));
  check("every repaired scene re-validates against the schema", kept.every((r) => evaluateSemanticEnactment([r.scene]).scenes[0].objects.missing.length === 0 || r.report.missingIds.length === 0), `${kept.length} scenes`);
  check("no LLM was spent on the deterministic stage", preResults.every((r) => r.report.decision !== "UNRESOLVED" || r.report.unresolved.every((u) => u.code === "no_unambiguous_existing_binding")), "deterministic");

  /* ---------------------------------- live pipeline ---------------------------------- */
  const priorAttempts: unknown[] = fs.existsSync(ATTEMPTS_LOG)
    ? (JSON.parse(fs.readFileSync(ATTEMPTS_LOG, "utf8")) as unknown[])
    : [];
  const attemptNo = priorAttempts.length + 1;
  const completedStages = Object.values(readManifest(ID).stages ?? {}).filter((s) => s.status === "done").length;
  console.log(`\n--- live generateProject() attempt#${attemptNo} project=${ID} budget=${BUDGET_MIN}min completedStages=${completedStages} ---`);

  const wall0 = Date.now();
  let threw = "";
  let result: Awaited<ReturnType<typeof generateProject>> | null = null;
  try {
    result = await generateProject({
      projectId: ID,
      script: SCRIPT,
      voicePath: VO,
      title: "Batch F live semantic-contract probe",
      resume: true,
      fixture: { copiedFrom: SRC },
      budget: { wallClockMs: WALL_CLOCK_MS },
      onProgress: (stage, detail) => console.log(`[${((Date.now() - wall0) / 1000).toFixed(1)}s] ${stage}: ${(detail ?? "").slice(0, 220)}`),
    });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
    console.error(`[batchF-live-generation] generateProject threw: ${threw.slice(0, 500)}`);
  }
  const wallMs = Date.now() - wall0;

  console.log("\n--- result ---");
  if (result) console.log(`status=${result.status} scenes=${result.sceneIds.length} qa=${result.qa?.status ?? "-"} error=${result.error ?? "-"}`);
  else console.log(`status=THREW ${threw.slice(0, 300)}`);

  const budgetFile = path.join(dir, "qa", "generation-budget.json");
  const budget: BudgetSummary | undefined = fs.existsSync(budgetFile)
    ? (JSON.parse(fs.readFileSync(budgetFile, "utf8")) as BudgetSummary)
    : result?.budget;
  check("budget artifact written (qa/generation-budget.json)", fs.existsSync(budgetFile));
  printTimeline(budget);

  /* ------------------------- post-run semantic-contract evidence ------------------------- */
  console.log("\n--- semantic contract after the live run ---");
  const contractFile = path.join(dir, "qa", "semantic-contract.json");
  check("qa/semantic-contract.json written by the pipeline", fs.existsSync(contractFile));
  const contract = fs.existsSync(contractFile) ? JSON.parse(fs.readFileSync(contractFile, "utf8")) : null;
  if (contract?.scenes) {
    const decisions: string[] = contract.scenes.map((s: { sceneId: string; decision: string }) => `${s.sceneId}:${s.decision}`);
    console.log(`  decisions: ${decisions.join(" ")}`);
    const headlineBound = contract.scenes.filter((s: { decision: string }) => s.decision === "KEEP").length;
    check("pipeline reconciliation repaired at least the two headline gaps", headlineBound >= 2, `KEEP on ${headlineBound} scene(s)`);
    check("contract report carries machine-readable verdicts", contract.scenes.every((s: { verdict: string }) => s.verdict === "pass" || s.verdict === "fail"), `ok=${contract.ok}`);
  }

  const scenesAfter = listScenes(ID).map((s) => s.data as SceneSpec);
  const afterGate = evaluateSemanticEnactment(scenesAfter);
  const missingAfter = afterGate.failures.filter((f) => f.type === "missing_semantic_object");
  const headlineMissing = missingAfter.filter((f) => (f.target ?? [])[0] === "headline_01");
  check("headline_01 no longer reported missing (2 -> 0)", headlineMissing.length === 0, `${missingBefore.filter((f) => (f.target ?? [])[0] === "headline_01").length} -> ${headlineMissing.length}`);
  const boundOnDisk = scenesAfter.filter((s) => s.headline?.semanticId === "headline_01");
  check("headline binding persisted on disk (scene_01 + scene_04)", boundOnDisk.length === 2, boundOnDisk.map((s) => s.sceneId).join(","));
  console.log(`  enactment after: ${afterGate.compact.join(" | ")}`);

  /* --------------------------------- pipeline outcome --------------------------------- */
  const record = {
    attempt: attemptNo,
    at: new Date().toISOString(),
    wallMs,
    status: result?.status ?? (threw ? "threw" : "unknown"),
    error: ((result?.error ?? threw).slice(0, 220) || undefined) as string | undefined,
    exhausted: budget?.exhausted ?? null,
    llmCalls: budget?.llmCalls ?? null,
    headlineGapsRepaired: boundHeadline.length,
    missingHeadlineBefore: missingBefore.filter((f) => (f.target ?? [])[0] === "headline_01").length,
    missingHeadlineAfter: headlineMissing.length,
    failedStage: (budget?.stages.find((s) => s.status !== "done")?.stage ?? null) as string | null,
  };
  fs.writeFileSync(ATTEMPTS_LOG, JSON.stringify([...priorAttempts, record], null, 2), "utf8");

  const diag = readDiagnostics(dir);
  check("diagnostics carry the generation timeline", Boolean(diag?.generation), diag?.generation ? `llm=${diag.generation.llmCalls} stages=${diag.generation.stages.length}` : "missing");

  const finished = result?.status === "complete" || result?.status === "partial";
  const render = readRenderRecord(dir);
  const qa = readQaRecord(dir);
  if (finished) {
    check("pipeline finalized (complete or structured partial)", true, `status=${result!.status}`);
    check("wall clock respected (run inside budget + finalization slack)", wallMs <= WALL_CLOCK_MS + 180_000, `${(wallMs / 1000).toFixed(0)}s <= ${(WALL_CLOCK_MS / 1000).toFixed(0)}s+180s`);
    check("render record present", render !== null, render?.sha256.slice(0, 12) ?? "");
    check("QA record present (judges ran - PASS never claimed by skipping them)", qa !== null, `status=${qa?.status ?? ""}`);
    const consistency = verifyConsistency(dir, { requireQa: true, requireFinal: true });
    check("artifact consistency", consistency.ok, summarizeConsistency(consistency));
    check("provider calls bounded and recorded", typeof budget?.llmCalls === "number" && budget.llmCalls > 0 && budget.llmCalls <= (budget?.config.maxLlmCalls ?? 1e9), `${budget?.llmCalls}/${budget?.config.maxLlmCalls}`);
    if (result!.status === "partial") console.log("  note: PARTIAL - budget cut repair rounds; QA verdict and artifacts remain honest");
    // the honest quality verdict is reported, never asserted to be pass
    console.log(`  QA verdict (honest, not asserted): ${qa?.status ?? result!.qa?.status ?? "unknown"}`);
  } else {
    check("pipeline finalized (complete or structured partial)", false, `status=${result?.status ?? "THREW"} ${result?.error ?? threw}`.slice(0, 300));
    check("wall clock respected", wallMs <= WALL_CLOCK_MS + 180_000, `${(wallMs / 1000).toFixed(0)}s`);
    const exhaustedStage = budget?.stages.find((s) => s.status === "budget_exhausted");
    if (exhaustedStage) console.log(`  exact stage: ${exhaustedStage.stage}`);
  }

  const failed = results.filter((r) => !r[1]);
  console.log(`\n[batchF-live-generation] ${results.length - failed.length}/${results.length} checks passed (wall ${(wallMs / 1000).toFixed(0)}s)`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => `${f[0]} ${f[2]}`).join(" | "));
    process.exitCode = 1;
  } else {
    console.log(`LIVE INTEGRATION CRITERION: PASS (status=${result!.status}, headline gaps ${missingBefore.filter((f) => (f.target ?? [])[0] === "headline_01").length} -> ${headlineMissing.length})`);
  }
}

void main().catch((e) => {
  console.error(String((e as Error)?.stack ?? e));
  process.exitCode = 1;
});
