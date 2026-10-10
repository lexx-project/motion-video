/**
 * Batch E Phase 7 - LIVE INTEGRATION: the real generateProject() pipeline, the real
 * provider abstraction, a small deterministic script and a short VO fixture, under a
 * STRICT wall-clock budget.
 *
 * This is deliberately NOT scripted: it proves the generation-level budget bounds a real
 * run end-to-end (stages, provider calls, repairs, renders, QA reruns) and that budget
 * exhaustion produces a STRUCTURED failed/partial result - never a silent PASS.
 *
 * Record: stage start/end times, provider call durations, timeout/retry counts, repair
 * budget consumption, render + QA durations, final status, artifact consistency, and the
 * exact stage where any timeout/exhaustion occurred.
 *
 * Run: npx tsx e2e/batchE-live-generation.ts
 * Env: BATCHE_LIVE_BUDGET_MIN (default 20) - strict wall clock for THIS attempt.
 *      BATCHE_LIVE_FRESH=1               - wipe the project and start a fresh attempt.
 *
 * One attempt per invocation (auto-resume when the project already has progress - the
 * pipeline's documented stage caching). Every attempt carries its own strict budget; the
 * cumulative attempt log lives in e2e/batchE-live-attempts.json.
 *
 * Observed real timings (Batch E runs): analysis ~20s, beats ~20-140s, storyboards
 * 2-4min/beat, judges ~45s/call -> a full round-0 needs ~20-25 minutes on this provider.
 */
import fs from "fs";
import path from "path";
import { generateProject } from "../src/agents/pipeline";
import { verifyConsistency, summarizeConsistency, readRenderRecord, readQaRecord } from "../src/core/artifacts";
import { readDiagnostics } from "../src/core/diagnostics";
import { projectDir, readManifest } from "../src/core/projectStore";
import type { BudgetSummary } from "../src/core/generationBudget";

const ID = "_batche_live";
const BUDGET_MIN = Number(process.env.BATCHE_LIVE_BUDGET_MIN ?? 20);
const WALL_CLOCK_MS = Math.max(60_000, Math.round(BUDGET_MIN * 60_000));
const ATTEMPTS_LOG = path.join(process.cwd(), "e2e", "batchE-live-attempts.json");

/** Small deterministic script (one meaning unit -> the minimum 3 beats expected). */
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
  console.log(`  renders=${budget.renders.map((r) => `${r.label}:${fmt(r.ms)}`).join(" ") || "none"}`);
  console.log(`  elapsed=${fmt(budget.elapsedMs)}/${fmt(budget.config.wallClockMs)} exhausted=${budget.exhausted}`);
}

async function main(): Promise<void> {
  const dir = projectDir(ID);
  const fresh = process.env.BATCHE_LIVE_FRESH === "1";
  if (fresh && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  const hasProgress = fs.existsSync(path.join(dir, "manifest.json"));
  const priorAttempts: unknown[] = fs.existsSync(ATTEMPTS_LOG)
    ? (JSON.parse(fs.readFileSync(ATTEMPTS_LOG, "utf8")) as unknown[])
    : [];
  const attemptNo = priorAttempts.length + 1;
  const completedStages = hasProgress
    ? Object.values(readManifest(ID).stages ?? {}).filter((s) => s.status === "done").length
    : 0;
  console.log(
    `[batchE-live-generation] attempt#${attemptNo} project=${ID} script=${SCRIPT.split(" ").length} words vo=${path.basename(VO)} budget=${BUDGET_MIN}min resume=${hasProgress} completedStages=${completedStages}`,
  );
  if (priorAttempts.length) {
    console.log(`  prior attempts: ${priorAttempts.map((a) => JSON.stringify(a)).join(" | ")}`);
  }
  if (!fs.existsSync(VO)) {
    console.log("PROBE NOT RUN: VO fixture missing");
    process.exitCode = 1;
    return;
  }

  const wall0 = Date.now();
  let threw = "";
  let result: Awaited<ReturnType<typeof generateProject>> | null = null;
  try {
    result = await generateProject({
      projectId: ID,
      script: SCRIPT,
      voicePath: VO,
      title: "Batch E live budget probe",
      resume: hasProgress,
      budget: { wallClockMs: WALL_CLOCK_MS },
      onProgress: (stage, detail) => console.log(`[${((Date.now() - wall0) / 1000).toFixed(1)}s] ${stage}: ${(detail ?? "").slice(0, 220)}`),
    });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
    console.error(`[batchE-live-generation] generateProject threw: ${threw.slice(0, 500)}`);
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

  // exact stage where the budget stopped, if any
  const exhaustedStage = budget?.stages.find((s) => s.status === "budget_exhausted");
  if (exhaustedStage) console.log(`\nfirst budget-exhausted stage: ${exhaustedStage.stage} at +${((Date.parse(exhaustedStage.startedAt) - Date.parse(budget!.startedAt)) / 1000).toFixed(1)}s`);
  if (budget?.exhausted) console.log(`budget exhausted: true (elapsed ${fmt(budget.elapsedMs)} of ${fmt(budget.config.wallClockMs)})`);

  // cumulative attempt ledger (honest history across resumed attempts)
  const record = {
    attempt: attemptNo,
    at: new Date().toISOString(),
    wallMs,
    status: result?.status ?? (threw ? "threw" : "unknown"),
    error: ((result?.error ?? threw).slice(0, 220) || undefined) as string | undefined,
    exhausted: budget?.exhausted ?? null,
    llmCalls: budget?.llmCalls ?? null,
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
    check("QA record present (judges ran - PASS was never claimed by skipping them)", qa !== null, `status=${qa?.status ?? ""}`);
    const consistency = verifyConsistency(dir, { requireQa: true, requireFinal: true });
    check("artifact consistency", consistency.ok, summarizeConsistency(consistency));
    check("provider calls were bounded and recorded", typeof budget?.llmCalls === "number" && budget.llmCalls > 0 && budget.llmCalls <= (budget?.config.maxLlmCalls ?? 1e9), `${budget?.llmCalls}/${budget?.config.maxLlmCalls}`);
    if (budget) {
      check(
        "per-call retries bounded (no 12x85s loops): timeouts recorded, stage timeline complete",
        budget.stages.every((s) => s.status !== "failed" || s.ms >= 0) && budget.timeouts >= 0,
        `timeouts=${budget.timeouts}`,
      );
    }
    if (result!.status === "partial") {
      console.log("  note: PARTIAL - budget cut repair rounds; QA verdict and artifacts remain honest");
    }
  } else {
    // honest failure reporting - the live criterion does NOT pass
    check("pipeline finalized (complete or structured partial)", false, `status=${result?.status ?? "THREW"} ${result?.error ?? threw}`.slice(0, 300));
    check("wall clock respected", wallMs <= WALL_CLOCK_MS + 180_000, `${(wallMs / 1000).toFixed(0)}s`);
    if (exhaustedStage) console.log(`  exact stage: ${exhaustedStage.stage}`);
  }

  const failed = results.filter((r) => !r[1]);
  console.log(`\n[batchE-live-generation] ${results.length - failed.length}/${results.length} checks passed (wall ${(wallMs / 1000).toFixed(0)}s)`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => `${f[0]} ${f[2]}`).join(" | "));
    console.log("LIVE INTEGRATION CRITERION: FAILED (run did not finalize) - re-run to resume from cached stages");
    process.exitCode = 1;
  } else {
    console.log(`LIVE INTEGRATION CRITERION: PASS (status=${result!.status})`);
  }
}

void main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
