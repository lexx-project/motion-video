/**
 * Batch F - storyboard stage latency probe (REAL provider, same fixture, comparable conditions).
 *
 * Measures the per-beat validated-step cache added in Batch F:
 *   COLD: empty cache -> full stage = 3 LLM calls/beat (candidates, selection, expansion)
 *   WARM: cache hit  -> same beat  = 1 LLM call/beat  (expansion only)
 *
 * The warm pass simulates the Batch E failure mode exactly: expansion dies (storyboard
 * file missing) but candidates+selection already validated. Before Batch F the resume
 * re-paid all 3 calls; now it re-pays only the expansion.
 *
 * Fixture: the REAL _batche_live analysis + first 2 beats (fixed input, no regeneration).
 *
 * Run: npx tsx e2e/batchF-storyboard-latency.ts
 */
import fs from "fs";
import path from "path";
import { runStoryboardStage } from "../src/agents/storyboard";
import { beginGenerationBudget, endGenerationBudget } from "../src/core/generationBudget";
import { projectDir, writeJsonAt, readJsonAt, initProject } from "../src/core/projectStore";
import type { Analysis, Beats } from "../src/agents/schemas";
import type { TimingBeat } from "../src/agents/scriptAnalyst";
import type { BudgetSummary } from "../src/core/generationBudget";

const ID = "_batchf_sbtime";
const SRC = "_batche_live";
const BEATS_IN_PROBE = 2;

interface PassResult {
  label: string;
  wallMs: number;
  llmCalls: number;
  llmMs: number;
  storyboardsWritten: number;
  budget: BudgetSummary | null;
}

function stageFixture(): void {
  const dir = projectDir(ID);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  // initProject creates the subdirectories AND the manifest markStage requires
  initProject(ID, "Small disciplines, repeated in silence, build loud results.");
  // REAL analysis + beats from the Batch E live run (fixed input, not regenerated)
  const analysis = readJson<Analysis>(SRC, "analysis/script-analysis.json");
  const beatsAll = readJson<Beats>(SRC, "analysis/beats.json");
  const timestamps = readJson<Record<string, unknown>>(SRC, "analysis/timestamps.json");
  if (!analysis || !beatsAll) throw new Error(`missing fixture analysis in projects/${SRC}`);
  const beats: Beats = { beats: beatsAll.beats.slice(0, BEATS_IN_PROBE) };
  writeJsonAt(dir, "analysis/script-analysis.json", analysis);
  writeJsonAt(dir, "analysis/beats.json", beats);
  writeJsonAt(dir, "analysis/timestamps.json", timestamps ?? { source: "estimated", phrases: [] });
}

function readJson<T>(projectId: string, rel: string): T | null {
  return readJsonAt<T>(projectDir(projectId), rel);
}

async function runPass(label: string): Promise<PassResult> {
  const analysis = readJson<Analysis>(ID, "analysis/script-analysis.json")!;
  const beats = readJson<Beats>(ID, "analysis/beats.json")!;
  // fixed timing windows for the 2 probe beats (deterministic, no VO dependency)
  const timing: TimingBeat[] = beats.beats.map((_, i) => ({
    beatId: `b${i + 1}`,
    start: i * 4,
    end: i * 4 + 3.5,
    duration: 3.5,
    source: "explicit",
  })) as unknown as TimingBeat[];

  const budget = beginGenerationBudget({ wallClockMs: 15 * 60_000, maxLlmCalls: 30 });
  const t0 = Date.now();
  let error: string | null = null;
  try {
    await runStoryboardStage(
      ID,
      analysis,
      beats,
      timing,
      () => ({ min: 3, max: 6 }),
      (d) => console.log(`    [${label}] ${d}`),
    );
  } catch (e) {
    error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
  const wallMs = Date.now() - t0;
  const summary = endGenerationBudget();
  const storyboardsWritten = beats.beats.filter((b) =>
    fs.existsSync(path.join(projectDir(ID), "scenes", `storyboard-${b.id}.json`)),
  ).length;
  if (error) console.log(`    [${label}] stage error: ${error}`);
  return {
    label,
    wallMs,
    llmCalls: summary?.llmCalls ?? 0,
    llmMs: summary?.llmMs ?? 0,
    storyboardsWritten,
    budget: summary,
  };
}

function clearStoryboardsOnly(): void {
  const scenesDir = path.join(projectDir(ID), "scenes");
  for (const f of fs.readdirSync(scenesDir)) {
    if (/^storyboard-.*\.json$/.test(f)) fs.unlinkSync(path.join(scenesDir, f));
  }
}

async function main(): Promise<void> {
  console.log(`[batchF-storyboard-latency] fixture=projects/${SRC} beats=${BEATS_IN_PROBE} (REAL provider)`);
  stageFixture();

  console.log("\n--- COLD pass (empty cache: candidates + selection + expansion per beat) ---");
  const cold = await runPass("cold");
  console.log(`  cold: ${cold.llmCalls} calls, wall ${(cold.wallMs / 1000).toFixed(1)}s, llm ${(cold.llmMs / 1000).toFixed(1)}s, storyboards=${cold.storyboardsWritten}`);

  // mechanical proof of what the cache holds AFTER the cold pass
  const cacheStateAfterCold = (): { file: string; rounds: number; mtimeMs: number }[] => {
    const conceptsDir = path.join(projectDir(ID), "concepts");
    return fs
      .readdirSync(conceptsDir)
      .filter((f) => f.startsWith("beat-steps-"))
      .map((f) => {
        const full = path.join(conceptsDir, f);
        const j = JSON.parse(fs.readFileSync(full, "utf8")) as { rounds: unknown[] };
        return { file: f, rounds: j.rounds.length, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => a.file.localeCompare(b.file));
  };
  const afterCold = cacheStateAfterCold();

  // simulate the Batch E failure mode: expansion died -> storyboard file missing,
  // but the validated candidates+selection cache from the cold pass is on disk
  clearStoryboardsOnly();
  console.log("\n--- WARM pass (storyboard files deleted, beat-steps cache kept) ---");
  const warm = await runPass("warm");
  console.log(`  warm: ${warm.llmCalls} calls, wall ${(warm.wallMs / 1000).toFixed(1)}s, llm ${(warm.llmMs / 1000).toFixed(1)}s, storyboards=${warm.storyboardsWritten}`);
  const afterWarm = cacheStateAfterCold();

  const results: [string, boolean, string][] = [];
  const check = (label: string, pass: boolean, detail = ""): void => {
    results.push([label, pass, detail]);
    console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  };

  console.log("\n--- assertions ---");
  const expectedCold = BEATS_IN_PROBE * 3; // candidates + selection + expansion
  check("cold pass made the full 3-calls-per-beat cost", cold.llmCalls >= expectedCold, `${cold.llmCalls} >= ${expectedCold}`);
  check("cold pass populated the beat-steps cache", afterCold.length === BEATS_IN_PROBE && afterCold.every((c) => c.rounds >= 1), afterCold.map((c) => `${c.file}:${c.rounds}r`).join(" "));
  // the cache files are written ONLY by saveBeatSteps (a fresh candidates+selection).
  // If the warm pass re-ran those steps the mtime would advance; identical mtime means
  // the warm pass replayed the cache and spent its calls on expansion alone.
  const cacheUntouched = afterWarm.every((w, i) => w.mtimeMs === afterCold[i].mtimeMs && w.rounds === afterCold[i].rounds);
  check("warm pass replayed the cache (candidates+selection never re-ran)", cacheUntouched, afterWarm.map((w, i) => `${w.file}:${w.mtimeMs === afterCold[i].mtimeMs ? "unchanged" : "REWRITTEN"}`).join(" "));
  check("warm pass wrote the same storyboards", warm.storyboardsWritten === BEATS_IN_PROBE, `${warm.storyboardsWritten}/${BEATS_IN_PROBE}`);
  check("warm made strictly fewer provider calls than cold", warm.llmCalls < cold.llmCalls, `${cold.llmCalls} -> ${warm.llmCalls} (${cold.llmCalls - warm.llmCalls} calls saved)`);
  const perBeatSaved = cold.llmCalls / BEATS_IN_PROBE - warm.llmCalls / BEATS_IN_PROBE;
  check("provider calls per beat dropped", perBeatSaved > 0, `${(cold.llmCalls / BEATS_IN_PROBE).toFixed(1)} -> ${(warm.llmCalls / BEATS_IN_PROBE).toFixed(1)} calls/beat`);

  const report = {
    schema: "batchF-storyboard-latency/1",
    fixture: `projects/${SRC} (first ${BEATS_IN_PROBE} beats)`,
    provider: "router-asli/oc/mimo-v2.6-flash-free (live)",
    measuredAt: new Date().toISOString(),
    cold: { wallMs: cold.wallMs, llmCalls: cold.llmCalls, llmMs: cold.llmMs },
    warm: { wallMs: warm.wallMs, llmCalls: warm.llmCalls, llmMs: warm.llmMs },
    callsSaved: cold.llmCalls - warm.llmCalls,
    wallSavedMs: cold.wallMs - warm.wallMs,
    avgCallMs: cold.llmCalls ? cold.llmMs / cold.llmCalls : 0,
    cacheMechanicalProof: { afterCold, afterWarm, untouched: cacheUntouched },
    note: "warm llmCalls include expansion retries (completeJson re-asks); candidates+selection calls are proven skipped by unchanged cache mtime",
  };
  writeJsonAt(projectDir(ID), "qa/latency-probe.json", report);
  console.log(`\n[batchF-storyboard-latency] ${results.filter(([, ok]) => ok).length}/${results.length} checks passed`);
  console.log(`  cold ${cold.llmCalls}c/${(cold.wallMs / 1000).toFixed(1)}s -> warm ${warm.llmCalls}c/${(warm.wallMs / 1000).toFixed(1)}s (saved ${cold.llmCalls - warm.llmCalls} provider calls; wall-clock is provider-variance-dominated at n=1)`);
  const failed = results.filter(([, ok]) => !ok);
  if (failed.length) {
    for (const [label, , detail] of failed) console.error(`  FAILED: ${label} (${detail})`);
    process.exit(1);
  }
  console.log("LATENCY PROBE PASSED");
}

main().catch((e) => {
  console.error(`[batchF-storyboard-latency] threw: ${(e instanceof Error ? e.stack : String(e)).slice(0, 600)}`);
  process.exit(1);
});
