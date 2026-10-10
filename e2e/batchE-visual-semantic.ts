/**
 * Batch E E2E - visual semantic validation (deterministic fixtures + real renders):
 *
 *  1. a semantically compatible primitive is accepted            (category PASS)
 *  2. an obviously incompatible primitive is rejected            (contract + gate)
 *  3. state and pixel evidence are reported separately           (crossCheck fields)
 *  4. unverified object identity is explicitly NOT VERIFIED      (isolation disabled run)
 *  5. a failed semantic repair cannot remove a storyboard requirement
 *  6. KEEP/ROLLBACK remains correct (scripted provider, Batch C/D machinery)
 *
 * Run: npx tsx e2e/batchE-visual-semantic.ts
 */
import fs from "fs";
import path from "path";
import { collectEventEvidence } from "../src/agents/eventEvidence";
import { evaluateSemanticEnactment } from "../src/validation/semanticEnactment";
import { validateRepairProposal, type RepairProposal } from "../src/validation/repairContract";
import { classifyFailures } from "../src/agents/repairContext";
import { runBoundedLegacyRepair } from "../src/agents/legacyRepair";
import { runTargetedRepair, readRepairLedger } from "../src/agents/repairLoop";
import { scriptedRepairProvider } from "../src/agents/repairProviders";
import { GenerationBudget } from "../src/core/generationBudget";
import { currentSceneFingerprint } from "../src/core/snapshot";
import { writeDiagnostics, readDiagnostics } from "../src/core/diagnostics";
import { projectDir, writeJsonAt, readJsonAt } from "../src/core/projectStore";
import type { MetricSources } from "../src/agents/repairCompare";
import type { SceneSpec } from "../src/validation/schema";
import type { Storyboard } from "../src/validation/storyboardSchema";
import { passScene, missingObjectScene } from "../tests/fixtures/batchD";

const ID = "_batche_visualsem";

const results: [string, boolean, string][] = [];
const check = (label: string, pass: boolean, detail = ""): void => {
  results.push([label, pass, detail]);
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
};

function stage(scenes: SceneSpec[]): string {
  const dir = projectDir(ID);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  for (const sub of ["scenes", "renders", "qa", "input", "concepts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  for (const s of scenes) writeJsonAt(dir, `scenes/${s.sceneId}.json`, s);
  return dir;
}

const proposal = (changes: RepairProposal["changes"], sceneId = "scene_01"): RepairProposal => ({
  sceneId,
  reason: "batch E visual-semantic check",
  changes,
  preserve: ["storyboard promises", "duration"],
});

async function main(): Promise<void> {
  console.log("[batchE-visual-semantic] staging PASS fixture");
  const scene = passScene();
  const dir = stage([scene]);
  const storyboardBefore = JSON.stringify(scene.storyboard);

  /* ------------------------- 1. compatible primitive accepted ------------------------- */
  console.log("\n--- 1. compatible primitive accepted ---");
  const gate = evaluateSemanticEnactment([scene]);
  const personCheck = gate.scenes[0].categories.find((c) => c.id === "person_01")!;
  check("person_01 rendered by Person -> category PASS", personCheck.status === "pass", personCheck.reason);
  const gateCheck = gate.scenes[0].categories.find((c) => c.id === "gate_01")!;
  check(
    "gate_01 rendered by Circle -> accepted as stand-in (NOT VERIFIED, no false certainty)",
    gateCheck.status === "not_verified",
    gateCheck.reason,
  );
  check("no category failure in the PASS gate", gate.ok && !gate.failures.some((f) => f.type === "category_mismatch"), gate.compact.join(" | "));

  // contract accepts a stand-in primitive for the missing gate (Batch D fixture repair)
  const broken = missingObjectScene();
  const missingFailure = classifyFailures({ scenes: [broken], semantic: evaluateSemanticEnactment([broken]) })[0];
  const compatProposal = proposal([
    {
      target: "scene",
      property: "addElement",
      to: {
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
      } as unknown as string,
    },
  ]);
  const compat = validateRepairProposal(broken, compatProposal, missingFailure.type, { implicated: missingFailure.target });
  check("contract accepts a compatible/stand-in addElement", compat.ok, compat.errors.join("; "));

  /* ------------------------- 2. incompatible primitive rejected ----------------------- */
  console.log("\n--- 2. incompatible primitive rejected ---");
  const badProposal = proposal([
    {
      target: "scene",
      property: "addElement",
      to: {
        primitive: "Person",
        position: "right",
        accent: "none",
        role: "semantic",
        purpose: "the gate as a person",
        semanticId: "gate_01",
        delay: 0,
        entrance: "fade",
      } as unknown as string,
    },
  ]);
  const bad = validateRepairProposal(broken, badProposal, missingFailure.type, { implicated: missingFailure.target });
  check("contract rejects Person-for-gate before any render", !bad.ok, bad.errors.join("; "));
  check("rejection names the promised object", /incompatible primitive for promised object "gate_01"/.test(bad.errors.join(" ")));

  const clockRaw = JSON.parse(JSON.stringify(scene)) as SceneSpec;
  (clockRaw.storyboard as Storyboard).semanticObjects[0].objectType = "clock";
  const clockScene = JSON.parse(JSON.stringify(clockRaw)) as SceneSpec;
  const clockReport = evaluateSemanticEnactment([clockScene]);
  const mismatch = clockReport.failures.find((f) => f.type === "category_mismatch");
  check("gate reports category_mismatch (hard, deterministic-semantic)", Boolean(mismatch) && mismatch!.source === "deterministic-semantic", mismatch?.evidence ?? "none");
  check("summary carries category mismatch", /category=1 mismatch/.test(clockReport.scenes[0].summary), clockReport.scenes[0].summary);

  /* -------------- 3 + 4. state / pixel / identity reported separately ---------------- */
  console.log("\n--- 3+4. event cross-check (state vs pixel vs identity) ---");
  // 4 first: isolation disabled -> identity must be explicitly NOT VERIFIED
  const noIso = await collectEventEvidence(ID, [scene], undefined, { maxEventsPerScene: 3, objectIsolation: false, label: "noiso" });
  check("3 event reports written", noIso.reports.length === 3, noIso.reports.map((r) => r.eventId).join(","));
  for (const r of noIso.reports) {
    const cc = r.crossCheck;
    check(
      `${r.eventId} (isolation off): state=${cc.state}, pixel=${cc.pixel_change}, identity=${cc.identity}, combined=${cc.combined}`,
      cc.state === "PASS" && cc.identity === "NOT_VERIFIED" && cc.combined === "NOT_VERIFIED" && cc.methods.identity === "none",
      `frameDiff=${cc.pixelEvidence?.frameDiff ?? "-"}`,
    );
    check(`${r.eventId}: pixel evidence present with its method`, cc.pixel_change === "PASS" && cc.methods.pixel === "frame-diff");
  }

  // 3 with isolation: full separation + combined PASS (identity verified by construction)
  const iso = await collectEventEvidence(ID, [scene], undefined, { maxEventsPerScene: 3, objectIsolation: true, label: "iso" });
  for (const r of iso.reports) {
    const cc = r.crossCheck;
    check(
      `${r.eventId} (isolated): state=${cc.state}, pixel=${cc.pixel_change}, identity=${cc.identity}, combined=${cc.combined}`,
      cc.state === "PASS" && cc.pixel_change === "PASS" && cc.identity === "PASS" && cc.combined === "PASS",
      `frameDiff=${cc.pixelEvidence?.frameDiff ?? "-"} method=${cc.methods.pixel}`,
    );
    check(`${r.eventId}: isolated stills exist`, r.isolatedStills.length === 3 && r.isolatedStills.every((s) => fs.existsSync(path.join(dir, s.file))));
    check(`${r.eventId}: dimensions kept separate in the report`, typeof cc.state === "string" && typeof cc.pixel_change === "string" && typeof cc.identity === "string");
  }

  /* --------------- 5. requirement immutability (no pass-by-deletion) ------------------ */
  console.log("\n--- 5. failed semantic repair cannot remove a storyboard requirement ---");
  const mutateStoryboard = proposal([{ target: "scene", property: "storyboard", to: "{}" }]);
  const mf = classifyFailures({ scenes: [broken], semantic: evaluateSemanticEnactment([broken]) })[0];
  const mutation = validateRepairProposal(broken, mutateStoryboard, mf.type, { implicated: mf.target });
  check("storyboard mutation rejected by the contract", !mutation.ok && /not allow-listed|not allowed/.test(mutation.errors.join(" ")), mutation.errors.join(" "));

  // a whole-storyboard rewrite that drops the gate promise is ROLLED BACK (files restored)
  const legacyDir = projectDir(ID);
  fs.writeFileSync(path.join(legacyDir, "concepts", "storyboard.json"), JSON.stringify({ storyboards: [scene.storyboard] }), "utf8");
  const beforeHash = currentSceneFingerprint(legacyDir).sceneHashes.scene_01;
  const budget = new GenerationBudget({ maxLegacyRepairs: 4 });
  const dropped = JSON.parse(JSON.stringify(scene)) as SceneSpec;
  const droppedSb = dropped.storyboard as Storyboard;
  droppedSb.semanticObjects = droppedSb.semanticObjects.filter((o) => o.id !== "gate_01");
  delete (dropped.elements as { semanticId?: string }[])[1].semanticId;
  const legacyOutcome = await runBoundedLegacyRepair({
    projectId: ID,
    dir: legacyDir,
    scenes: [scene],
    sceneId: "scene_01",
    budget,
    round: 1,
    mode: "storyboard",
    baselineMetrics: { scenes: [scene], semantic: evaluateSemanticEnactment([scene]), artifactConsistent: true } as MetricSources,
    reason: "batchE requirement-immutability probe",
    repair: async () => {
      fs.writeFileSync(path.join(legacyDir, "concepts", "storyboard.json"), JSON.stringify({ storyboards: [] }), "utf8");
      return dropped;
    },
  });
  check("storyboard rewrite that drops gate_01 -> ROLLBACK", legacyOutcome.decision === "ROLLBACK", legacyOutcome.reason.slice(0, 140));
  check("scene bytes restored", currentSceneFingerprint(legacyDir).sceneHashes.scene_01 === beforeHash);
  const restoredSb = readJsonAt<SceneSpec>(legacyDir, "scenes/scene_01.json")!.storyboard!;
  check("baseline storyboard promises intact after rollback", JSON.stringify(restoredSb) === storyboardBefore);
  const conceptFile = JSON.parse(fs.readFileSync(path.join(legacyDir, "concepts", "storyboard.json"), "utf8")) as { storyboards: unknown[] };
  check("storyboard concept file restored", conceptFile.storyboards.length === 1);

  /* ---------------------------- 6. KEEP / ROLLBACK --------------------------- */
  console.log("\n--- 6. KEEP / ROLLBACK (scripted targeted repair) ---");
  const dirK = projectDir("_batche_visualsem_keep");
  if (fs.existsSync(dirK)) fs.rmSync(dirK, { recursive: true, force: true });
  fs.mkdirSync(path.join(dirK, "scenes"), { recursive: true });
  fs.mkdirSync(path.join(dirK, "qa"), { recursive: true });
  const brokenScene = missingObjectScene();
  writeJsonAt(dirK, "scenes/scene_01.json", brokenScene);
  const baselineMetrics: MetricSources = {
    scenes: [brokenScene],
    semantic: evaluateSemanticEnactment([brokenScene]),
    artifactConsistent: true,
  };
  const semanticFailures = classifyFailures({ scenes: [brokenScene], semantic: evaluateSemanticEnactment([brokenScene]) });
  const keep = await runTargetedRepair({
    dir: dirK,
    scenes: [brokenScene],
    round: 1,
    failures: semanticFailures,
    provider: scriptedRepairProvider([{
      proposal: {
        sceneId: "scene_01",
        reason: "restore gate_01 with a compatible primitive",
        changes: compatProposal.changes,
        preserve: ["storyboard promises", "duration"],
      },
    }]),
    baseline: baselineMetrics,
    maxScenes: 1,
  });
  check("KEEP: compatible semantic repair kept", keep.kept.includes("scene_01"), `rolledBack=${keep.rolledBack.join(",") || "-"}`);
  check("KEEP: gate now passes the semantic gate", evaluateSemanticEnactment([readJsonAt<SceneSpec>(dirK, "scenes/scene_01.json")!]).ok);
  check("KEEP: ledger row recorded", readRepairLedger(dirK).some((r) => r.decision === "KEEP" && r.failureType === "missing_semantic_object"));

  const dirR = projectDir("_batche_visualsem_rb");
  if (fs.existsSync(dirR)) fs.rmSync(dirR, { recursive: true, force: true });
  fs.mkdirSync(path.join(dirR, "scenes"), { recursive: true });
  fs.mkdirSync(path.join(dirR, "qa"), { recursive: true });
  const brokenEventScene = JSON.parse(JSON.stringify(scene)) as SceneSpec;
  const planB = brokenEventScene.executionPlan as { events: Record<string, unknown>[] };
  planB.events = planB.events.filter((e) => e.id !== "event_02"); // promise stays, plan loses the move
  writeJsonAt(dirR, "scenes/scene_01.json", brokenEventScene);
  const rbBase: MetricSources = {
    scenes: [brokenEventScene],
    semantic: evaluateSemanticEnactment([brokenEventScene]),
    artifactConsistent: true,
  };
  const rbFailures = classifyFailures({ scenes: [brokenEventScene], semantic: evaluateSemanticEnactment([brokenEventScene]) });
  const rb = await runTargetedRepair({
    dir: dirR,
    scenes: [brokenEventScene],
    round: 1,
    failures: rbFailures,
    provider: scriptedRepairProvider([{
      proposal: {
        sceneId: "scene_01",
        reason: "restore the move event at the wrong time",
        changes: [
          {
            target: "scene",
            property: "addEvent",
            to: {
              id: "event_02",
              atSeconds: 1.0,
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
    }]),
    baseline: rbBase,
    maxScenes: 1,
  });
  check("ROLLBACK: bad semantic repair rolled back", rb.rolledBack.includes("scene_01"), rb.kept.join(",") || "-");
  const rbRestored = readJsonAt<SceneSpec>(dirR, "scenes/scene_01.json")!;
  check(
    "ROLLBACK: baseline bytes restored (event_02 still missing, promise intact)",
    !(rbRestored.executionPlan as { events: { id: string }[] }).events.some((e) => e.id === "event_02"),
  );

  /* ------------------------------ diagnostics -------------------------------- */
  console.log("\n--- diagnostics ---");
  writeJsonAt(dir, "qa/semantic-enactment.json", evaluateSemanticEnactment([scene]));
  const diag = writeDiagnostics(dir);
  check("diagnostics carry category verdicts", (diag.gates.enactment?.perScene[0]?.categoryNotVerified ?? 0) >= 1, JSON.stringify(diag.gates.enactment?.perScene[0]));
  check(
    "diagnostics event trace carries the combined cross-check status",
    (diag.gates.enactment?.events ?? []).every((e) => e.combined !== null),
    (diag.gates.enactment?.events ?? []).map((e) => `${e.eventId}:${e.combined}`).join(","),
  );
  void readDiagnostics;

  const failed = results.filter((r) => !r[1]);
  console.log(`\n[batchE-visual-semantic] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => `${f[0]} ${f[2]}`).join(" | "));
    process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
