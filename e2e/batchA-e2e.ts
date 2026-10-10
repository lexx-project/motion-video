/**
 * Batch A E2E (read-only against historical projects): renders the Phase-3 demo scenes,
 * then exercises the full observability chain end to end:
 *
 *   render -> recordRender -> collectFrames -> collectFrameEvidence -> recordQa
 *          -> recordFinal -> verifyConsistency -> snapshot baseline -> experiment
 *          -> drift detected -> restore -> verifyConsistency again -> diagnostics
 *
 * No LLM is called: technical QA is deterministic (ffprobe), everything else is measurement.
 * Run: npx tsx e2e/batchA-e2e.ts
 */
import fs from "fs";
import path from "path";
import { renderProject, probeRender } from "../src/render/renderProject";
import { collectFrames, collectFrameEvidence } from "../src/agents/qa";
import { technicalQa } from "../src/agents/qa";
import {
  readQaRecord,
  readRenderRecord,
  readFinalRecord,
  recordFinal,
  recordQa,
  recordRender,
  verifyConsistency,
  summarizeConsistency,
} from "../src/core/artifacts";
import { createSnapshot, restoreSnapshot, latestSnapshot } from "../src/core/snapshot";
import { buildDiagnostics, writeDiagnostics } from "../src/core/diagnostics";
import { sha256File, scenesFingerprint } from "../src/core/identity";
import { listSceneFilesAt, projectDir, writeJsonAt } from "../src/core/projectStore";
import type { SceneSpec } from "../src/validation/schema";

const ROOT = process.cwd();
const SRC_PROJECT = "proj_p3_demo";
const PROJECT = "_batcha_e2e";
const dir = projectDir(PROJECT);

const fail = (msg: string): never => {
  throw new Error(`E2E FAILED: ${msg}`);
};
const ok = (msg: string): void => {
  console.log(`  ok  ${msg}`);
};

async function main(): Promise<void> {
  console.log(`[batchA-e2e] project dir: ${dir}`);

  /* 0. stage a working project from the existing Phase-3 scenes (no historical files touched) */
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "scenes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "renders"), { recursive: true });
  fs.mkdirSync(path.join(dir, "qa"), { recursive: true });
  fs.mkdirSync(path.join(dir, "input"), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, "projects", SRC_PROJECT, "scenes"))) {
    if (/^scene_\d+\.json$/.test(f)) {
      fs.copyFileSync(path.join(ROOT, "projects", SRC_PROJECT, "scenes", f), path.join(dir, "scenes", f));
    }
  }
  fs.copyFileSync(path.join(ROOT, "projects", SRC_PROJECT, "input", "voice.wav"), path.join(dir, "input", "voice.wav"));
  const pubDir = path.join(ROOT, "public", PROJECT);
  fs.mkdirSync(pubDir, { recursive: true });
  fs.copyFileSync(path.join(dir, "input", "voice.wav"), path.join(pubDir, "voice.wav"));
  const audioPath = `${PROJECT}/voice.wav`;

  const sceneFiles = listSceneFilesAt(dir);
  const scenes = sceneFiles.map((s) => s.data as SceneSpec);
  if (scenes.length !== 6) fail(`expected 6 scenes, found ${scenes.length}`);
  const baselineFp = scenesFingerprint(scenes);
  console.log(`[batchA-e2e] staged ${scenes.length} scenes, scenesHash=${baselineFp.scenesHash.slice(0, 12)}`);

  /* 1. render */
  console.log("[batchA-e2e] rendering preview...");
  const out = await renderProject({ scenes, audioPath, outputName: "batcha-preview.mp4" });
  const preview = path.join(dir, "renders", "preview.mp4");
  fs.copyFileSync(out, preview);
  const previewSha = sha256File(preview)!;
  const probe = await probeRender(preview, scenes.reduce((n, s) => n + s.duration, 0));
  if (probe.errors.length) fail(`technical probe: ${probe.errors.join("; ")}`);
  ok(`rendered preview.mp4 sha256=${previewSha.slice(0, 12)} ${probe.width}x${probe.height} ${probe.durationSec}s`);

  /* 2. record render identity (A4) */
  const renderRec = recordRender(dir, { file: preview, scenes, label: "preview" });
  if (renderRec.sha256 !== previewSha) fail("render record hash != file hash");
  if (renderRec.scenesHash !== baselineFp.scenesHash) fail("render record scenesHash mismatch");
  ok(`render record bound: ${renderRec.sha256.slice(0, 12)} / ${renderRec.scenesHash.slice(0, 12)}`);

  /* 3. frame evidence (A1 + A2) */
  const judgeFrames = await collectFrames(PROJECT, scenes, audioPath, "e2e");
  const evidence = await collectFrameEvidence(PROJECT, scenes, audioPath, "e2e");
  if (evidence.samples.length < scenes.length * 3) fail(`only ${evidence.samples.length} samples`);
  if (evidence.sourceRender?.sha256 !== previewSha) fail("frame evidence does not reference the rendered artifact");
  if (evidence.scenesHash !== baselineFp.scenesHash) fail("frame evidence scenesHash mismatch");
  for (const s of evidence.samples) {
    if (!s.metrics) fail(`no metrics for ${s.sceneId} ${s.reason}`);
    if (!fs.existsSync(path.join(dir, s.file))) fail(`missing frame file ${s.file}`);
  }
  ok(`frame evidence: ${evidence.samples.length} samples over ${evidence.sceneRollup.length} scenes, ${judgeFrames.length} judge stills`);

  /* 4. deterministic technical QA + QA attachment (A4/A6) */
  const technical = await technicalQa(preview, scenes, true);
  const qaPayload = { status: technical.errors.length ? "fail" : "pass", technical, note: "Batch A E2E: deterministic technical QA only (no LLM judges run)" };
  const qaRec = recordQa(dir, qaPayload, { round: 0 });
  if (qaRec.renderSha256 !== previewSha) fail("QA attached to a different artifact");
  ok(`QA record attached to render ${qaRec.renderSha256.slice(0, 12)} (status=${qaRec.status})`);

  /* 5. final artifact + consistency (A6) */
  const finalFile = path.join(dir, "renders", "final.mp4");
  fs.copyFileSync(preview, finalFile);
  recordFinal(dir, { file: finalFile, copiedFrom: preview, scenes });
  let consistency = verifyConsistency(dir, { requireQa: true, requireFinal: true });
  if (!consistency.ok) fail(`fresh finalize not consistent: ${summarizeConsistency(consistency)}`);
  if (sha256File(finalFile) !== previewSha) fail("final.mp4 is not byte-identical to preview.mp4");
  ok(`final.mp4 committed + consistent (${summarizeConsistency(consistency)})`);

  /* 6. baseline snapshot (A5) */
  const base = createSnapshot(dir, "accepted-baseline", {
    scenes,
    render: { file: renderRec.file, sha256: renderRec.sha256 },
    qa: { qaSha256: qaRec.qaSha256, status: qaRec.status ?? "unknown", renderSha256: qaRec.renderSha256 },
  });
  ok(`baseline snapshot "${base.label}" scenesHash=${base.scenesHash.slice(0, 12)}`);

  /* 7. experiment: mutate a real scene, detect drift, restore */
  const target = scenes.find((s) => s.sceneId === "scene_04")!;
  const mutated: SceneSpec = { ...target, purpose: `${target.purpose} [E2E EXPERIMENT]` };
  writeJsonAt(dir, "scenes/scene_04.json", mutated);

  consistency = verifyConsistency(dir, { requireQa: true, requireFinal: true });
  if (consistency.ok) fail("drift after a scene edit was NOT detected");
  if (!consistency.issues.some((i) => i.code === "scenes_changed_after_render"))
    fail(`expected scenes_changed_after_render, got: ${consistency.issues.map((i) => i.code).join(",")}`);
  ok(`experiment detected: ${summarizeConsistency(consistency)}`);

  const diagBeforeRestore = buildDiagnostics(dir);
  if (diagBeforeRestore.changesSinceBaseline?.changed.join(",") !== "scene_04")
    fail(`diagnostics change set wrong: ${JSON.stringify(diagBeforeRestore.changesSinceBaseline)}`);
  ok(`diagnostics reports changed=[scene_04] against baseline "${diagBeforeRestore.baseline?.label}"`);

  const restored = restoreSnapshot(dir, "accepted-baseline");
  if (!restored.verified) fail("restore did not verify against the baseline identity");
  if (scenesFingerprint(listSceneFilesAt(dir).map((s) => s.data)).scenesHash !== base.scenesHash)
    fail("restored state hash != baseline hash");

  consistency = verifyConsistency(dir, { requireQa: true, requireFinal: true });
  if (!consistency.ok) fail(`not consistent after restore: ${summarizeConsistency(consistency)}`);
  ok(`RESTORE verified: scene_04 back to baseline, consistency=${summarizeConsistency(consistency)}`);

  /* 8. diagnostics (A7) */
  const diag = writeDiagnostics(dir);
  const checks: [string, boolean][] = [
    ["render sha matches file", diag.render?.sha256 === previewSha],
    ["final sha matches render", diag.final?.sha256 === diag.render?.sha256],
    ["qa attached to that render", diag.qa?.renderSha256 === diag.render?.sha256],
    ["frame evidence references that render", diag.frames?.sourceRenderSha256 === diag.render?.sha256],
    ["frame evidence matches current scenes", diag.frames?.matchesCurrentScenes === true],
    ["frame samples listed", (diag.frames?.sampleCount ?? 0) >= 18],
    ["per-scene metrics present", diag.frames?.sceneRollup.length === 6],
    ["baseline restorable", diag.baseline?.label === "accepted-baseline"],
    ["no changes since baseline", (diag.changesSinceBaseline?.changed.length ?? -1) === 0],
    ["consistency ok", diag.consistency.ok === true],
    ["scene list complete", diag.project.sceneIds.length === 6],
  ];
  for (const [label, pass] of checks) {
    if (!pass) fail(`diagnostics check failed: ${label}`);
    ok(`diagnostics: ${label}`);
  }
  if (!fs.existsSync(path.join(dir, "qa", "diagnostics.json"))) fail("diagnostics.json not written");

  console.log("\n[batchA-e2e] ALL CHECKS PASSED");
  console.log(`  preview   ${previewSha}`);
  console.log(`  evidence  ${evidence.samples.length} samples -> qa/frame-evidence.json`);
  console.log(`  baseline  ${latestSnapshot(dir)?.label}`);
  console.log(`  artifacts ${dir}`);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
