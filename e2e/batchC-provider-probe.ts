/**
 * Batch C / §20 - live provider probe (SMALL + TIMEBOXED).
 *
 * Purpose: prove that the new compact repair prompt + structured proposal contract are
 * accepted by the real provider. Nothing else is generated. If the provider is slow or the
 * response is invalid, this reports FAILED honestly - the deterministic Batch C tests stand
 * on their own.
 *
 * Run: npx tsx e2e\batchC-provider-probe.ts
 */
import fs from "fs";
import path from "path";
import { llmRepairProvider } from "../src/agents/repairProviders";
import { buildRepairPrompt } from "../src/agents/repairProviders";
import { buildRepairContext, classifyFailures } from "../src/agents/repairContext";
import { ALLOWED_PROPERTIES, validateRepairProposal } from "../src/validation/repairContract";
import { evaluatePreRenderGate } from "../src/validation/preRenderGate";
import { projectDir, listSceneFilesAt } from "../src/core/projectStore";
import type { SceneSpec } from "../src/validation/schema";

const TIMEOUT_MS = 90_000;

async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`provider probe timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  // the unrepaired clip fixture (Batch A scenes)
  const dir = projectDir("_batcha_e2e");
  const scenes = listSceneFilesAt(dir).map((s) => s.data as SceneSpec);
  const scene = scenes.find((s) => s.sceneId === "scene_03");
  if (!scene) throw new Error("scene_03 missing from _batcha_e2e");

  const gate = await evaluatePreRenderGate([scene]);
  const failures = classifyFailures({ scenes: [scene], preRenderIssues: gate.hard });
  const failure = failures.find((f) => f.type === "layout_clip");
  if (!failure) {
    console.log("PROBE NOT APPLICABLE: no layout_clip failure on the fixture");
    process.exitCode = 1;
    return;
  }

  const ctx = buildRepairContext({
    round: 1,
    attempt: 1,
    maxAttempts: 2,
    failure,
    allowedProperties: ALLOWED_PROPERTIES[failure.type],
    baselineArtifactHash: "probe",
    baselineSnapshotId: "probe",
  });
  const prompt = buildRepairPrompt(ctx, scene);
  console.log(`prompt chars=${prompt.length} lines=${prompt.split("\n").length}`);
  console.log(`failure=${ctx.failureType} target=${ctx.affectedObjects.join(",")}`);
  console.log(`evidence=${ctx.deterministicEvidence}`);

  const t0 = Date.now();
  try {
    const proposal = await withTimeout(() => llmRepairProvider.propose({ context: ctx, prompt }), TIMEOUT_MS);
    const ms = Date.now() - t0;
    console.log(`\nprovider responded in ${ms}ms`);
    console.log(`proposal=${JSON.stringify(proposal)}`);
    const v = validateRepairProposal(scene, proposal, failure.type, { implicated: failure.target });
    console.log(`contract validation: ${v.ok ? "ACCEPTED" : "REJECTED - " + v.errors.join("; ")}`);
    console.log(
      v.ok
        ? `\nPROBE PASS (provider accepted the compact prompt and the contract accepted the proposal) lat=${ms}ms`
        : `\nPROBE FAILED (provider answered but the contract rejected the proposal)`,
    );
    if (!v.ok) process.exitCode = 1;
  } catch (e) {
    const ms = Date.now() - t0;
    console.log(`\nPROBE FAILED after ${ms}ms: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
