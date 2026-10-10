/**
 * Batch D E2E - semantic repair lifecycle (scripted provider, no model latency):
 *
 *   BROKEN (missing gate_01)
 *     -> semantic gate failure (missing_semantic_object)
 *     -> snapshot baseline
 *     -> constrained repair proposal (addElement ONLY)
 *     -> contract validation (narrowness + storyboard immutability)
 *     -> deterministic enactment gate on the candidate
 *     -> model-only evidence compare -> KEEP
 *     -> render the kept scene + event evidence
 *
 *   BAD REPAIR (restores the missing event at the WRONG time)
 *     -> contract accepts it (narrow, structural)
 *     -> enactment evidence shows a NEW hard failure (event_timing_mismatch)
 *     -> compare -> ROLLBACK, baseline restored byte-for-byte
 *
 * Run: npx tsx e2e/batchD-repair.ts
 */
import fs from "fs";
import path from "path";
import { renderProject } from "../src/render/renderProject";
import { evaluateSemanticEnactment } from "../src/validation/semanticEnactment";
import { classifyFailures } from "../src/agents/repairContext";
import { runTargetedRepair, readRepairLedger } from "../src/agents/repairLoop";
import { scriptedRepairProvider } from "../src/agents/repairProviders";
import type { MetricSources } from "../src/agents/repairCompare";
import { createSnapshot, currentSceneFingerprint, latestSnapshot, listSnapshots } from "../src/core/snapshot";
import { recordRender, verifyConsistency, summarizeConsistency, readRenderRecord } from "../src/core/artifacts";
import { writeDiagnostics } from "../src/core/diagnostics";
import { projectDir, writeJsonAt, readJsonAt } from "../src/core/projectStore";
import { collectEventEvidence } from "../src/agents/eventEvidence";
import type { SceneSpec } from "../src/validation/schema";
import { missingObjectScene, missingEventScene } from "../tests/fixtures/batchD";

const KEEP_ID = "_batchd_repair_keep";
const ROLLBACK_ID = "_batchd_repair_rb";

const results: [string, boolean, string][] = [];
const check = (label: string, pass: boolean, detail = ""): void => {
  results.push([label, pass, detail]);
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
};

function stage(id: string, scene: SceneSpec): { dir: string; scenes: SceneSpec[] } {
  const dir = projectDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  for (const sub of ["scenes", "renders", "qa", "input"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  writeJsonAt(dir, `scenes/${scene.sceneId}.json`, scene);
  return { dir, scenes: [scene] };
}

const modelMeasure = async (scenes: SceneSpec[]): Promise<MetricSources> => ({
  scenes,
  semantic: evaluateSemanticEnactment(scenes),
  artifactConsistent: true,
});

const gateElement = {
  primitive: "Circle",
  position: "right",
  accent: "teal",
  role: "semantic",
  purpose: "the destination",
  semanticId: "gate_01",
  label: "GATE",
  diameterPct: 36,
  delay: 0,
  entrance: "fade",
};

async function main(): Promise<void> {
  /* ------------------------------ KEEP path ------------------------------ */
  console.log("[batchD-repair] staging missing-object fixture");
  const { dir, scenes } = stage(KEEP_ID, missingObjectScene());
  const baselineHash = currentSceneFingerprint(dir).sceneHashes.scene_01!;
  const scenesHashBefore = currentSceneFingerprint(dir).scenesHash;

  console.log("\n--- 1. classify ---");
  const baselineGate = evaluateSemanticEnactment(scenes);
  check("semantic gate FAILS the broken scene", !baselineGate.ok, baselineGate.compact.join(" | "));
  const failures = classifyFailures({ scenes, semantic: baselineGate });
  const primary = failures[0];
  check(
    "classified as missing_semantic_object (hard, deterministic-semantic)",
    primary?.type === "missing_semantic_object" && primary.severity === "hard" && primary.source === "deterministic-semantic",
    `${primary?.type} target=${(primary?.target ?? []).join(",")}`,
  );

  console.log("\n--- 2. baseline snapshot + baseline evidence ---");
  const baseline: MetricSources = await modelMeasure(scenes);
  const snapshot = createSnapshot(dir, "d-keep-baseline", { scenes, render: null, qa: null });
  check("baseline snapshot captured", snapshot.scenesHash === scenesHashBefore, `label=${snapshot.label}`);
  check("baseline restorable", listSnapshots(dir).some((s) => s.scenesHash === scenesHashBefore));

  console.log("\n--- 3. constrained semantic repair -> KEEP ---");
  const repair = await runTargetedRepair({
    dir,
    scenes,
    round: 1,
    failures,
    provider: scriptedRepairProvider([
      {
        proposal: {
          sceneId: "scene_01",
          reason: "storyboard promises gate_01; renderer output has no element with semanticId=gate_01",
          changes: [{ target: "scene", property: "addElement", to: gateElement as unknown as string }],
          preserve: ["storyboard promises", "duration", "person_01", "event ids"],
        },
      },
    ]),
    baseline,
    maxScenes: 1,
  });
  check("repair KEPT", repair.kept.includes("scene_01"), `kept=${repair.kept.join(",") || "-"} rolledBack=${repair.rolledBack.join(",") || "-"}`);
  const keptScene = readJsonAt<SceneSpec>(dir, "scenes/scene_01.json")!;
  check("added element carries the promised semanticId", keptScene.elements.some((e) => e.semanticId === "gate_01"), keptScene.elements.map((e) => e.semanticId ?? e.primitive).join(","));
  check("storyboard untouched by the repair", JSON.stringify(keptScene.storyboard) === JSON.stringify(scenes[0].storyboard));
  check("execution plan untouched by the repair", JSON.stringify(keptScene.executionPlan) === JSON.stringify(scenes[0].executionPlan));
  check("semantic gate now PASSES", evaluateSemanticEnactment([keptScene]).ok, evaluateSemanticEnactment([keptScene]).compact.join(""));
  check("scene hash changed", currentSceneFingerprint(dir).sceneHashes.scene_01 !== baselineHash);

  const ledger = readRepairLedger(dir);
  const keepRow = ledger.find((r) => r.decision === "KEEP");
  check("ledger records the KEEP with evidence before/after", Boolean(keepRow && keepRow.evidenceBefore && keepRow.evidenceAfter), keepRow ? `${keepRow.failureType}: ${keepRow.evidenceAfter.slice(0, 50)}` : "none");
  check("ledger stores baseline + candidate hashes", Boolean(keepRow && keepRow.baselineHash && keepRow.candidateHash && keepRow.baselineHash !== keepRow.candidateHash));
  check("ledger prompt hash recorded (no duplicate prompts)", Boolean(keepRow && keepRow.promptHash));

  console.log("\n--- 4. render the kept scene + event evidence ---");
  const out = await renderProject({ scenes: [keptScene], outputName: "batchd-repair.mp4" });
  const dest = path.join(dir, "renders", "preview.mp4");
  fs.copyFileSync(out, dest);
  const rr = recordRender(dir, { file: dest, scenes: [keptScene], label: "candidate" });
  check("kept scene renders", Boolean(rr.sha256), rr.sha256.slice(0, 12));
  const ev = await collectEventEvidence(KEEP_ID, [keptScene], undefined, { maxEventsPerScene: 3 });
  check("event evidence written for the repaired scene", ev.written.length === 3, ev.written.join(","));
  check(
    "all events pass in the persisted evidence",
    ev.reports.every((r) => r.status === "pass"),
    ev.reports.map((r) => `${r.eventId}:${r.status}`).join(" "),
  );

  writeJsonAt(dir, "qa/semantic-enactment.json", evaluateSemanticEnactment([keptScene])); // pipeline artifact
  const diag = writeDiagnostics(dir);
  check("diagnostics carry the semantic KEEP decision", diag.repairs.rows.some((r) => r.decision === "KEEP" && r.failureType === "missing_semantic_object"), diag.repairs.rows.map((r) => `${r.sceneId}:${r.failureType}:${r.decision}`).join(","));
  check("diagnostics expose the enactment gate", diag.gates.enactment !== null && diag.gates.enactment.ok === true);
  const consistency = verifyConsistency(dir, { requireQa: false, requireFinal: false });
  check("artifact identity consistent", consistency.ok, summarizeConsistency(consistency));

  /* ---------------------------- ROLLBACK path ---------------------------- */
  console.log("\n--- 5. bad semantic repair -> ROLLBACK ---");
  const rb = stage(ROLLBACK_ID, missingEventScene());
  const rbHash = currentSceneFingerprint(rb.dir).sceneHashes.scene_01!;
  const rbGate = evaluateSemanticEnactment(rb.scenes);
  const rbFailures = classifyFailures({ scenes: rb.scenes, semantic: rbGate });
  check("missing event fixture classified", rbFailures[0]?.type === "missing_event", rbFailures.map((f) => f.type).join(","));

  const rbResult = await runTargetedRepair({
    dir: rb.dir,
    scenes: rb.scenes,
    round: 1,
    failures: rbFailures,
    provider: scriptedRepairProvider([
      {
        proposal: {
          sceneId: "scene_01",
          reason: "restore the move event (at the wrong time)",
          changes: [
            {
              target: "scene",
              property: "addEvent",
              to: {
                id: "event_02",
                atSeconds: 1.0, // promise: 2.6s -> event_timing_mismatch
                type: "move",
                action: "moveTo",
                target: "person_01",
                destination: "gate_01",
                durationSec: 0.35,
                easing: "easeInOut",
                provenance: "explicit",
              } as unknown as string,
            },
          ],
          preserve: ["storyboard promises", "duration"],
        },
      },
    ]),
    baseline: await modelMeasure(rb.scenes),
    maxScenes: 1,
  });
  check("worse candidate was ROLLED BACK", rbResult.rolledBack.includes("scene_01"), `rolledBack=${rbResult.rolledBack.join(",") || "-"}`);
  check("baseline restored byte-for-byte", currentSceneFingerprint(rb.dir).sceneHashes.scene_01 === rbHash);
  const restored = readJsonAt<SceneSpec>(rb.dir, "scenes/scene_01.json")!;
  check("bad event is gone again", !(restored.executionPlan as { events: { id: string }[] }).events.some((e) => e.id === "event_02"));
  check("storyboard promise intact after rollback", (restored.storyboard?.motionBeats ?? []).some((m) => m.id === "event_02"));
  const rbRow = readRepairLedger(rb.dir)[0];
  check(
    "rollback recorded with the new-hard-failure reason",
    rbRow?.decision === "ROLLBACK" && /new hard failure/.test(rbRow.reason),
    rbRow?.reason ?? "",
  );
  check("rollback restored the baseline snapshot", latestSnapshot(rb.dir)?.label === "r1-scene_01", latestSnapshot(rb.dir)?.label ?? "none");

  const failed = results.filter((r) => !r[1]);
  console.log(`\n[batchD-repair] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => `${f[0]} ${f[2]}`).join(" | "));
    process.exitCode = 1;
  } else {
    console.log(`  keep sha=${(readRenderRecord(dir)?.sha256 ?? "").slice(0, 12)}  ledger rows: keep=${readRepairLedger(dir).length} rollback=${readRepairLedger(rb.dir).length}`);
  }
}

void main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
