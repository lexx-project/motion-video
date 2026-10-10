/**
 * Batch C E2E (deterministic, scripted provider - no model latency):
 *
 *   load fixture -> detect the Scene 03 layout failure -> classify -> snapshot baseline
 *   -> propose (constrained) -> validate contract -> apply -> render candidate
 *   -> collect evidence -> compare metric vectors -> KEEP (or ROLLBACK)
 *   -> artifact identity + diagnostics contain the decision
 *
 * Plus a rollback fixture where the candidate deliberately worsens the project.
 *
 * Run: npx tsx e2e/batchC-repair.ts
 */
import fs from "fs";
import path from "path";
import { renderProject, probeRender } from "../src/render/renderProject";
import { collectFrameEvidence, collectFrames } from "../src/agents/qa";
import { evaluateProjectLayoutGate } from "../src/validation/layoutGate";
import { evaluateVisualGates } from "../src/validation/visualGates";
import { evaluatePreRenderGate, summarizePreRenderGate } from "../src/validation/preRenderGate";
import { collisionSemantics } from "../src/validation/collisionSemantics";
import { classifyFailures } from "../src/agents/repairContext";
import { runTargetedRepair, readRepairLedger } from "../src/agents/repairLoop";
import { scriptedRepairProvider } from "../src/agents/repairProviders";
import type { MetricSources } from "../src/agents/repairCompare";
import { createSnapshot, currentSceneFingerprint, latestSnapshot, listSnapshots } from "../src/core/snapshot";
import { recordRender, recordQa, recordFinal, verifyConsistency, readRenderRecord, summarizeConsistency, readQaRecord } from "../src/core/artifacts";
import { writeDiagnostics, readDiagnostics } from "../src/core/diagnostics";
import { projectDir, listSceneFilesAt } from "../src/core/projectStore";
import { sha256File, scenesFingerprint } from "../src/core/identity";
import type { SceneSpec } from "../src/validation/schema";

const KEEP_ID = "_batchc_e2e";
const ROLLBACK_ID = "_batchc_e2e_rb";
const SRC = "proj_p3_demo";
const BASE_EVIDENCE_PROJECT = "_batcha_e2e";

const results: [string, boolean, string][] = [];
const check = (label: string, pass: boolean, detail = ""): void => {
  results.push([label, pass, detail]);
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
};

function stage(id: string, sceneIds: string[]): { dir: string; scenes: SceneSpec[] } {
  const dir = projectDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "scenes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "renders"), { recursive: true });
  fs.mkdirSync(path.join(dir, "qa"), { recursive: true });
  fs.mkdirSync(path.join(dir, "input"), { recursive: true });
  const src = projectDir(SRC);
  for (const f of fs.readdirSync(path.join(src, "scenes"))) {
    if (!/^scene_\d+\.json$/.test(f)) continue;
    if (!sceneIds.some((id2) => f.startsWith(id2))) continue;
    fs.copyFileSync(path.join(src, "scenes", f), path.join(dir, "scenes", f));
  }
  fs.copyFileSync(path.join(src, "input", "voice.wav"), path.join(dir, "input", "voice.wav"));
  const pub = path.join(process.cwd(), "public", id);
  fs.mkdirSync(pub, { recursive: true });
  fs.copyFileSync(path.join(dir, "input", "voice.wav"), path.join(pub, "voice.wav"));
  const scenes = listSceneFilesAt(dir).map((s) => s.data as SceneSpec);
  return { dir, scenes };
}

const maxEdgeInk = (e: { sceneRollup: { maxEdgeInk: number | null }[] }): number =>
  e.sceneRollup.reduce((m, r) => Math.max(m, r.maxEdgeInk ?? 0), 0);

async function main(): Promise<void> {
  console.log("[batchC-repair] staging fixtures");
  const { dir, scenes } = stage(KEEP_ID, ["scene_01", "scene_02", "scene_03"]);
  const ID = KEEP_ID;
  const audioPath = `${ID}/voice.wav`;
  const scenesHashBefore = scenesFingerprint(scenes).scenesHash;

  /* --- 1/2. detect the Scene 03 layout failure ------------------------------ */
  console.log("\n--- 1-2. detect + classify ---");
  const preGate = await evaluatePreRenderGate(scenes);
  writeDiagnosticJson(dir, "qa/pre-render-gate.json", preGate);
  console.log(`  pre-render gate: ${summarizePreRenderGate(preGate)}`);
  check("Scene 03 layout failure detected before rendering", preGate.hard.some((h) => h.sceneId === "scene_03" && h.failureType === "layout_clip"), preGate.hard.filter((h) => h.sceneId === "scene_03").map((h) => h.failureType).join(","));
  check("only model-detectable issues appear pre-render (no empty-band prediction)", !preGate.hard.some((h) => h.failureType === "empty_visual_band"));

  const failures = classifyFailures({ scenes, preRenderIssues: [...preGate.hard, ...preGate.warnings] });
  const primary = failures.filter((f) => f.severity === "hard");
  const clip = primary.find((f) => f.sceneId === "scene_03" && f.type === "layout_clip");
  check("failure classified as layout_clip with an affected object", Boolean(clip && (clip.target ?? []).length > 0), clip ? `${clip.type} target=${clip.target?.join(",")}` : "none");
  console.log(`  classified: ${primary.map((f) => `${f.sceneId}/${f.type}`).join(", ")}`);

  /* --- 3. baseline snapshot + baseline evidence ----------------------------- */
  console.log("\n--- 3. baseline ---");
  // reuse the Batch A fixture's measured baseline evidence (identical scene state)
  const baseEvidencePath = path.join(projectDir(BASE_EVIDENCE_PROJECT), "qa", "frame-evidence.json");
  const baseEvidence = JSON.parse(fs.readFileSync(baseEvidencePath, "utf8"));
  const srcDir = projectDir(SRC);
  const srcScenes = listSceneFilesAt(srcDir).map((s) => s.data as SceneSpec);
  const srcFingerprint = scenesFingerprint(srcScenes);
  const stagedFingerprint = scenesFingerprint(scenes);
  check(
    "baseline evidence describes the source scene state",
    baseEvidence.scenesHash === srcFingerprint.scenesHash,
    `evidence=${String(baseEvidence.scenesHash).slice(0, 12)} source=${srcFingerprint.scenesHash.slice(0, 12)}`,
  );
  check(
    "staged scenes are byte-identical to the source project",
    Object.entries(stagedFingerprint.sceneHashes).every(([id, h]) => srcFingerprint.sceneHashes[id] === h),
    Object.keys(stagedFingerprint.sceneHashes).join(","),
  );

  const baselineLayout = await evaluateProjectLayoutGate(scenes, baseEvidence);
  const baselineVisual = evaluateVisualGates(scenes, baseEvidence);
  const baselineCollisions: Record<string, ReturnType<typeof collisionSemantics>> = {};
  for (const s of scenes) baselineCollisions[s.sceneId] = collisionSemantics(s);
  const baselineMetrics: MetricSources = {
    scenes,
    layoutGate: baselineLayout,
    visualGates: baselineVisual,
    collisions: baselineCollisions,
    frameEdgeInk: maxEdgeInk(baseEvidence),
    artifactConsistent: true,
  };
  const baselineHash = currentSceneFingerprint(dir).sceneHashes.scene_03!;
  const snapshot = createSnapshot(dir, "c-keep-baseline", {
    scenes,
    render: readRenderRecord(dir) ? { file: readRenderRecord(dir)!.file, sha256: readRenderRecord(dir)!.sha256 } : null,
    qa: null,
  });
  check("baseline snapshot captured", snapshot.scenesHash === scenesHashBefore, `label=${snapshot.label}`);

  /* --- 4/5/6/7. constrained repair -> render candidate -> evidence ---------- */
  console.log("\n--- 4-7. constrained repair + candidate render ---");
  const proposal = {
    sceneId: "scene_03",
    reason: "measured: hero word overflows the right frame edge after transform",
    changes: [{ target: "elements:0", property: "scale", from: 2.2, to: 1.3 }],
    preserve: ["scene meaning", "timing", "voice synchronization", "typography style"],
  };

  const measure = async (next: SceneSpec[]): Promise<MetricSources> => {
    const out = await renderProject({ scenes: next, audioPath, outputName: "batchc-candidate.mp4" });
    const dest = path.join(dir, "renders", "preview.mp4");
    fs.copyFileSync(out, dest);
    const rr = recordRender(dir, { file: dest, scenes: next, label: "candidate" });
    const probe = await probeRender(dest, next.reduce((n, s) => n + s.duration, 0));
    const ev = await collectFrameEvidence(ID, next, audioPath, "cand");
    await collectFrames(ID, next, audioPath, "cand");
    const lg = await evaluateProjectLayoutGate(next, ev);
    const vg = evaluateVisualGates(next, ev);
    const collisions: Record<string, ReturnType<typeof collisionSemantics>> = {};
    for (const s of next) collisions[s.sceneId] = collisionSemantics(s);
    const consistent =
      rr.sha256 === sha256File(dest) && rr.scenesHash === scenesFingerprint(next).scenesHash && probe.errors.length === 0;
    return {
      scenes: next,
      layoutGate: lg,
      visualGates: vg,
      collisions,
      frameEdgeInk: maxEdgeInk(ev),
      artifactConsistent: consistent,
    };
  };

  const repair = await runTargetedRepair({
    dir,
    scenes,
    round: 1,
    failures: failures,
    provider: scriptedRepairProvider([{ proposal }]),
    baseline: baselineMetrics,
    measure,
    maxScenes: 1,
  });

  check("repair KEPT the improving candidate", repair.kept.includes("scene_03"), `kept=${repair.kept.join(",") || "-"} rolledBack=${repair.rolledBack.join(",") || "-"}`);
  const candidateScale = (readScene(dir, "scene_03").elements[0] as { scale: number }).scale;
  check("candidate applied to the scene JSON", candidateScale === 1.3, `scale=${candidateScale}`);
  check("candidate differs from the baseline hash", currentSceneFingerprint(dir).sceneHashes.scene_03 !== baselineHash);

  /* --- 8/9. candidate evidence + comparison --------------------------------- */
  console.log("\n--- 8-9. candidate evidence + decision ---");
  const candEvidence = JSON.parse(fs.readFileSync(path.join(dir, "qa", "frame-evidence.json"), "utf8"));
  const candScene03 = candEvidence.sceneRollup.find((r: { sceneId: string }) => r.sceneId === "scene_03");
  const baseScene03 = baseEvidence.sceneRollup.find((r: { sceneId: string }) => r.sceneId === "scene_03");
  console.log(`  baseline  scene_03 edgeInk=${baseScene03.maxEdgeInk} safeOvf=${baseScene03.maxSafeAreaOverflowPx}`);
  console.log(`  candidate scene_03 edgeInk=${candScene03.maxEdgeInk} safeOvf=${candScene03.maxSafeAreaOverflowPx}`);
  check("candidate rendered frame no longer clips (pixel evidence)", candScene03.maxEdgeInk === 0 && !candScene03.contentOutsideFrame, `edgeInk=${candScene03.maxEdgeInk}`);
  check("baseline DID clip (so this is a real improvement)", baseScene03.maxEdgeInk > 100, `edgeInk=${baseScene03.maxEdgeInk}`);

  const ledger = readRepairLedger(dir);
  const keepRow = ledger.find((r) => r.decision === "KEEP");
  check("ledger records the KEEP decision", Boolean(keepRow), keepRow ? `${keepRow.failureType} ${keepRow.decision}` : "none");
  check("ledger stores evidence before and after", Boolean(keepRow && keepRow.evidenceBefore && keepRow.evidenceAfter), keepRow ? `${keepRow.evidenceBefore.slice(0, 40)} -> ${keepRow.evidenceAfter.slice(0, 40)}` : "");
  check("ledger stores baseline + candidate hashes", Boolean(keepRow && keepRow.baselineHash && keepRow.candidateHash && keepRow.baselineHash !== keepRow.candidateHash));
  check("ledger stores the repair proposal and comparison", Boolean(keepRow && keepRow.proposal && keepRow.comparison?.includes("KEEP")), keepRow?.comparison ?? "");

  /* --- 10/11/12. artifact identity + diagnostics ---------------------------- */
  console.log("\n--- 10-12. artifact identity + diagnostics ---");
  recordQa(dir, { status: "pass", overallQuality: null, note: "Batch C E2E (deterministic gates + scripted provider)" }, { round: 1 });
  fs.copyFileSync(path.join(dir, "renders", "preview.mp4"), path.join(dir, "renders", "final.mp4"));
  recordFinal(dir, { file: path.join(dir, "renders", "final.mp4"), copiedFrom: path.join(dir, "renders", "preview.mp4"), scenes: readScenes(dir) });
  const consistency = verifyConsistency(dir, { requireQa: true, requireFinal: true });
  check("artifact identity consistent after KEEP", consistency.ok, summarizeConsistency(consistency));
  check("final.mp4 equals the candidate render", sha256File(path.join(dir, "renders", "final.mp4")) === sha256File(path.join(dir, "renders", "preview.mp4")));

  const diag = writeDiagnostics(dir);
  const rows = diag.repairs.rows;
  check("diagnostics contain the repair decision", rows.some((r) => r.decision === "KEEP" && r.sceneId === "scene_03"), rows.map((r) => `${r.sceneId}:${r.decision}`).join(","));
  check("diagnostics contain evidence before/after", Boolean(rows[0]?.evidenceBefore && rows[0]?.evidenceAfter));
  check("diagnostics contain the pre-render gate", diag.gates.preRender !== null && diag.gates.preRender.hard > 0, `hard=${diag.gates.preRender?.hard ?? 0}`);
  const snapshots = listSnapshots(dir);
  check(
    "a restorable baseline with the pre-repair state exists",
    snapshots.some((s) => s.scenesHash === scenesHashBefore),
    snapshots.map((s) => `${s.label}=${s.scenesHash.slice(0, 12)}`).join(", "),
  );
  check("diagnostics expose a restorable baseline", Boolean(diag.baseline?.label), diag.baseline?.label ?? "none");

  /* --- 13. ROLLBACK fixture ------------------------------------------------- */
  console.log("\n--- 13. rollback fixture ---");
  const rb = stage(ROLLBACK_ID, ["scene_03"]);
  const rbHash = currentSceneFingerprint(rb.dir).sceneHashes.scene_03!;
  const rbFailures = classifyFailures({
    scenes: rb.scenes,
    preRenderIssues: (await evaluatePreRenderGate(rb.scenes)).hard,
  });
  const badProposal = {
    sceneId: "scene_03",
    reason: "deliberately worse: bigger scale",
    changes: [{ target: "elements:0", property: "scale", from: 2.2, to: 2.9 }],
    preserve: ["scene meaning", "timing"],
  };
  const rbResult = await runTargetedRepair({
    dir: rb.dir,
    scenes: rb.scenes,
    round: 1,
    failures: rbFailures,
    provider: scriptedRepairProvider([{ proposal: badProposal }]),
    baseline: { scenes: rb.scenes, artifactConsistent: true },
    // model-only measurement: the worsening is visible in the geometry (no render needed)
    measure: async (next) => {
      const gate = await evaluatePreRenderGate(next);
      return {
        scenes: next,
        preRenderHard: gate.hard.map((h) => ({ sceneId: h.sceneId, failureType: h.failureType, magnitude: h.magnitude })),
        artifactConsistent: true,
      };
    },
    maxScenes: 1,
  });
  check("worse candidate was ROLLED BACK", rbResult.rolledBack.includes("scene_03"), `rolledBack=${rbResult.rolledBack.join(",") || "-"}`);
  check("baseline restored byte-for-byte after rollback", currentSceneFingerprint(rb.dir).sceneHashes.scene_03 === rbHash);
  check("scale reverted to the baseline value", (readScene(rb.dir, "scene_03").elements[0] as { scale: number }).scale === 2.2);
  const rbRow = readRepairLedger(rb.dir)[0];
  check("rollback recorded with reason", rbRow?.decision === "ROLLBACK" && /worsened|regressed|new hard/.test(rbRow.reason), rbRow?.reason ?? "");
  check("rollback restores the baseline snapshot", latestSnapshot(rb.dir)?.label === "r1-scene_03", latestSnapshot(rb.dir)?.label ?? "none");

  const failed = results.filter((r) => !r[1]);
  console.log(`\n[batchC-repair] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f[0]).join(" | "));
    process.exitCode = 1;
  } else {
    console.log(`  keep ledger rows: ${readRepairLedger(dir).length}`);
    console.log(`  rollback ledger rows: ${readRepairLedger(rb.dir).length}`);
  }
}

function readScene(dir: string, sceneId: string): SceneSpec {
  return JSON.parse(fs.readFileSync(path.join(dir, "scenes", `${sceneId}.json`), "utf8")) as SceneSpec;
}

function readScenes(dir: string): SceneSpec[] {
  return listSceneFilesAt(dir).map((s) => s.data as SceneSpec);
}

function writeDiagnosticJson(dir: string, rel: string, data: unknown): void {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(data, null, 2), "utf8");
}

void main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
