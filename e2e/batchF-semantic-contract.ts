/**
 * Batch F E2E - semantic-contract reconciliation (deterministic fixtures + REAL renders):
 *
 *  1. contract inspection extracts the gate-identical required set      (pure, no model)
 *  2. missing headline_01 is detected deterministically
 *  3. safe micro-repair binds the EXISTING scene.headline (KEEP) - no new object,
 *     no unrelated element touched, contract bytes preserved
 *  4. REAL render: the bound reveal event now actually clips the headline in
 *     (pre-reveal frame < post-reveal frame) - pixels prove the binding is not cosmetic
 *  5. the full deterministic contract passes: enactment gate + layout + visual gates
 *  6. an unrepairable missing id stays an explicit UNRESOLVED failure (no false pass)
 *  7. a failed re-validation ROLLEs BACK with the scene bytes preserved
 *  8. required ids remain a SUPERSET of represented ids (Batch D §24 invariant)
 *
 * Run: npx tsx e2e/batchF-semantic-contract.ts
 */
import fs from "fs";
import path from "path";
import { renderProject, createStillRenderer } from "../src/render/renderProject";
import { collectFrameEvidence } from "../src/agents/qa";
import { frameDiff, analyzeFrame } from "../src/render/frameEvidence";
import { evaluateProjectLayoutGate } from "../src/validation/layoutGate";
import { evaluateVisualGates } from "../src/validation/visualGates";
import { evaluateSemanticEnactment } from "../src/validation/semanticEnactment";
import {
  inspectSemanticContract,
  reconcileSemanticContract,
  summarizeContract,
} from "../src/validation/semanticContract";
import { classifyFailures } from "../src/agents/repairContext";
import { validateScene } from "../src/validation/validate";
import { compileExecutionPlan } from "../src/validation/executionPlan";
import { recordRender, verifyConsistency, summarizeConsistency } from "../src/core/artifacts";
import { writeDiagnostics } from "../src/core/diagnostics";
import { projectDir, writeJsonAt, readJsonAt } from "../src/core/projectStore";
import { OUTPUT } from "../src/core/output";
import type { SceneSpec } from "../src/validation/schema";
import type { Storyboard } from "../src/validation/storyboardSchema";
import { passScene, headlineGapScene } from "../tests/fixtures/batchD";

const ID = "_batchf_contract";

const results: [string, boolean, string][] = [];
const check = (label: string, pass: boolean, detail = ""): void => {
  results.push([label, pass, detail]);
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
};

function stage(scenes: SceneSpec[]): string {
  const dir = projectDir(ID);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  for (const sub of ["scenes", "renders", "qa", "input"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  for (const s of scenes) writeJsonAt(dir, `scenes/${s.sceneId}.json`, s);
  return dir;
}

async function main(): Promise<void> {
  console.log("[batchF-semantic-contract] staging headline-gap fixture (live-run defect shape)");
  const gap = headlineGapScene();
  const dir = stage([gap]);

  /* --------------------------- 1-2. contract inspection --------------------------- */
  console.log("\n--- 1-2. contract inspection (pure, no model call) ---");
  const before = inspectSemanticContract(gap);
  check("contract active", before.contractActive);
  check(
    "required set = objects + event targets (gate-identical)",
    before.requiredIds.includes("headline_01") && before.requiredIds.includes("person_01") && before.requiredIds.includes("gate_01"),
    before.requiredIds.join(","),
  );
  check("headline_01 detected missing deterministically", JSON.stringify(before.missingIds) === JSON.stringify(["headline_01"]), before.missingIds.join(","));
  const again = inspectSemanticContract(gap);
  check("inspection is deterministic (same input -> same report)", JSON.stringify(before) === JSON.stringify(again));
  check("verdict FAIL before repair", before.verdict === "fail");

  /* ------------------------------ 3. safe micro-repair ----------------------------- */
  console.log("\n--- 3. micro-repair binds the existing scene.headline (no new object) ---");
  const elementsBefore = JSON.stringify(gap.elements);
  const storyboardBefore = JSON.stringify(gap.storyboard);
  const result = reconcileSemanticContract(gap, gap.storyboard);
  check("decision KEEP", result.report.decision === "KEEP", result.report.decision);
  check("headline bound to headline_01", result.scene.headline?.semanticId === "headline_01");
  check("elements byte-identical (no unrelated element touched)", JSON.stringify(result.scene.elements) === elementsBefore);
  check("storyboard contract bytes preserved (authority untouched)", JSON.stringify(result.scene.storyboard) === storyboardBefore);
  check("repaired scene passes schema", validateScene(result.scene, "scene_01").success);
  check("verdict PASS after repair", result.report.verdict === "pass");
  check("only the headline field differs from the original", JSON.stringify({ ...result.scene, headline: gap.headline }) === JSON.stringify(gap));
  writeJsonAt(dir, "scenes/scene_01.json", result.scene); // persist the repaired scene

  /* --------------------- 4. REAL render: the binding is not cosmetic --------------------- */
  console.log("\n--- 4. REAL render: bound reveal event clips the headline in ---");
  const still = await createStillRenderer([result.scene], undefined);
  const shot = async (t: number, name: string): Promise<string> => {
    const file = path.join(dir, "qa", "frames", `${name}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await still(Math.round(t * OUTPUT.fps), file);
    return file;
  };
  const preReveal = await shot(0.3, "t0_pre_reveal");
  const postReveal = await shot(1.6, "t1_post_reveal");
  const preState = await analyzeFrame(preReveal);
  const postState = await analyzeFrame(postReveal);
  const dReveal = await frameDiff(preReveal, postReveal);
  check("pre-reveal frame carries LESS headline ink than post-reveal", (postState?.occupancy ?? 0) > (preState?.occupancy ?? 0), `occupancy ${(preState?.occupancy ?? 0).toFixed(4)} -> ${(postState?.occupancy ?? 0).toFixed(4)}`);
  check("reveal visibly changes pixels (real render, not a mock)", (dReveal ?? 0) > 0.002, `frameDiff=${dReveal}`);
  check("post-reveal frame has real content", (postState?.occupancy ?? 0) > 0.001, `occupancy=${postState?.occupancy}`);

  /* ------------------- 5. full deterministic contract on the repaired scene ------------------ */
  console.log("\n--- 5. full deterministic contract (enactment + layout + visual) ---");
  const gate = evaluateSemanticEnactment([result.scene]);
  const s0 = gate.scenes[0];
  check("objects 3/3 present", s0.objects.missing.length === 0 && s0.objects.present.length === 3, s0.objects.present.join(","));
  check("event_04 (reveal headline_01) passes with real timing", s0.events.find((e) => e.eventId === "event_04")?.status === "pass", s0.events.find((e) => e.eventId === "event_04")?.evidence ?? "none");
  check("semantic gate PASS", gate.ok, gate.compact.join(" | "));
  const failures = classifyFailures({ scenes: [result.scene], semantic: gate });
  check("no missing_semantic_object in classified failures", !failures.some((f) => f.type === "missing_semantic_object"));

  const evidence = await collectFrameEvidence(ID, [result.scene], undefined, "r1");
  const layoutGate = await evaluateProjectLayoutGate([result.scene], evidence);
  const visualGates = evaluateVisualGates([result.scene], evidence);
  check("layout gate PASS", layoutGate.hard.length === 0, layoutGate.hard.join(" | ") || "hard=0");
  check("visual gates PASS", visualGates.hard.length === 0, visualGates.hard.join(" | ") || "hard=0");

  /* ------------------------ 6. unrepairable miss stays explicit ------------------------- */
  console.log("\n--- 6. unrepairable missing id stays an explicit failure ---");
  const orphan = JSON.parse(JSON.stringify(passScene())) as SceneSpec;
  const orphanSb = orphan.storyboard as Storyboard;
  orphanSb.semanticObjects = orphanSb.semanticObjects.map((o) => (o.id === "gate_01" ? { ...o, id: "wall_01" } : o));
  orphanSb.motionBeats = orphanSb.motionBeats.map((m) => (m.target === "gate_01" ? { ...m, target: "wall_01" } : m));
  orphanSb.relationships = orphanSb.relationships.map((r) => (r.to === "gate_01" ? { ...r, to: "wall_01" } : r));
  orphan.executionPlan = compileExecutionPlan(orphan);
  const orphanFixed = validateScene(orphan, "scene_01").scene!;
  const orphanResult = reconcileSemanticContract(orphanFixed);
  check("decision UNRESOLVED (no guessing)", orphanResult.report.decision === "UNRESOLVED", orphanResult.report.decision);
  check("verdict FAIL (no false pass)", orphanResult.report.verdict === "fail");
  check("unresolved reason is machine-readable", orphanResult.report.unresolved[0]?.code === "no_unambiguous_existing_binding", JSON.stringify(orphanResult.report.unresolved));
  check("orphan scene untouched", JSON.stringify(orphanResult.scene) === JSON.stringify(orphanFixed));

  /* --------------------------- 7. failed re-validation rolls back -------------------------- */
  console.log("\n--- 7. failed re-validation rolls back with bytes preserved ---");
  const badTarget = JSON.parse(JSON.stringify(gap)) as SceneSpec;
  const badSb = badTarget.storyboard as Storyboard;
  badSb.motionBeats = badSb.motionBeats.map((m) => (m.target === "headline_01" ? { ...m, target: "headline_bad!" } : m));
  badTarget.executionPlan = compileExecutionPlan(badTarget);
  const badScene = validateScene(badTarget, "scene_01").scene!;
  const badJson = JSON.stringify(badScene);
  const rollback = reconcileSemanticContract(badScene);
  check("decision ROLLBACK", rollback.report.decision === "ROLLBACK", rollback.report.decision);
  check("repair errors recorded", rollback.report.repairErrors.length > 0, rollback.report.repairErrors.join("; ").slice(0, 120));
  check("scene bytes preserved (no corruption)", JSON.stringify(rollback.scene) === badJson);
  check("headline still unbound after rollback", rollback.scene.headline?.semanticId === undefined);
  check("verdict still FAIL after rollback", rollback.report.verdict === "fail");

  /* ------------------------------ 8. superset invariant ------------------------------ */
  console.log("\n--- 8. required ⊇ present superset invariant ---");
  // the REPAIRED scene must satisfy the Batch D §24 invariant: every present id is required
  const repairedSuperset = result.report.presentIds.every((id) => result.report.requiredIds.includes(id));
  check("repaired scene: required ⊇ present", repairedSuperset, result.report.presentIds.join(","));
  // the orphan fixture ALSO carries a stale gate_01 element binding the (renamed) storyboard
  // no longer promises - the inspector must flag it as an unpromised conflict, and the
  // rollup superset must be false. This proves the invariant is enforced, not decorative.
  check("orphan scene: stale binding detected as unpromised conflict", orphanResult.report.conflictingBindings.includes("gate_01"), orphanResult.report.conflictingBindings.join(","));
  const rollup = summarizeContract([
    { scene: result.scene, report: result.report },
    { scene: orphanResult.scene, report: orphanResult.report },
  ]);
  check("rollup superset=false when any scene violates it", rollup.supersetHolds === false);
  check("project ok=false because the unresolved scene still fails", rollup.ok === false);

  /* ------------------------------- artifact consistency ------------------------------- */
  console.log("\n--- REAL project render + artifact identity ---");
  const outFile = await renderProject({ scenes: [result.scene], outputName: "batchf-contract.mp4" });
  const dest = path.join(dir, "renders", "preview.mp4");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(outFile, dest);
  const rr = recordRender(dir, { file: dest, scenes: [result.scene], label: "preview" });
  check("real project render recorded with identity", Boolean(rr.sha256) && rr.sizeBytes > 0, `${rr.sha256.slice(0, 12)} ${rr.sizeBytes}B`);
  const consistency = verifyConsistency(dir, { requireQa: false, requireFinal: false });
  check("artifact consistency holds", consistency.ok, summarizeConsistency(consistency));
  writeDiagnostics(dir, { manifest: { status: "complete" } });
  writeJsonAt(dir, "qa/semantic-contract.json", rollup);
  check("contract report written", Boolean(readJsonAt(dir, "qa/semantic-contract.json")));

  /* ------------------------------------ summary ------------------------------------ */
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n[batchF-semantic-contract] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const [label, , detail] of failed) console.error(`  FAILED: ${label} (${detail})`);
    process.exit(1);
  }
  console.log("ALL CHECKS PASSED");
}

main().catch((e) => {
  console.error(`[batchF-semantic-contract] threw: ${(e instanceof Error ? e.stack : String(e)).slice(0, 800)}`);
  process.exit(1);
});
