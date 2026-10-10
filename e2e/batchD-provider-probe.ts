/**
 * Batch D / §32 - live provider probe for SEMANTIC repairs (SMALL + TIMEBOXED).
 *
 * Purpose: prove the real provider accepts the compact semantic repair prompt and returns a
 * proposal the contract accepts (addElement with the promised semanticId). Nothing else runs:
 * no generateProject(), no renders, no judges. The deterministic Batch D tests stand alone.
 *
 * Run: npx tsx e2e\batchD-provider-probe.ts
 */
import { llmRepairProvider, buildRepairPrompt } from "../src/agents/repairProviders";
import { buildRepairContext, classifyFailures } from "../src/agents/repairContext";
import { ALLOWED_PROPERTIES, validateRepairProposal } from "../src/validation/repairContract";
import { evaluateSemanticEnactment } from "../src/validation/semanticEnactment";
import { missingObjectScene } from "../tests/fixtures/batchD";

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
  const scene = missingObjectScene();
  const gate = evaluateSemanticEnactment([scene]);
  const failures = classifyFailures({ scenes: [scene], semantic: gate });
  const failure = failures.find((f) => f.type === "missing_semantic_object");
  if (!failure) {
    console.log("PROBE NOT APPLICABLE: fixture produced no missing_semantic_object failure");
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
  console.log(`action=${ctx.suggestedAction.slice(0, 120)}...`);

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
        ? `\nPROBE PASS (provider answered the semantic prompt and the contract accepted the proposal) lat=${ms}ms`
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
