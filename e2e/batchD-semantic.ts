/**
 * Batch D E2E - semantic temporal execution (deterministic, scripted fixtures):
 *
 *   PASS CASE
 *     storyboard contract resolves (objects, events, relationships)
 *     -> execution plan actually changes the RENDERED scene (pixel diff over event windows)
 *     -> semantic enactment gate PASS (timing inside tolerance)
 *     -> existing layout/visual gates PASS on the rendered frames
 *     -> event evidence stills (pre/at/post) + qa/events/<scene>/<event>.json
 *     -> artifact identity + diagnostics carry the enactment trace
 *
 *   FAILURE CASES (each deterministic, exactly one classification)
 *     missing object / missing event / event not executed / timing mismatch /
 *     relationship failure (+ unsupported event)
 *
 * Run: npx tsx e2e/batchD-semantic.ts
 */
import fs from "fs";
import path from "path";
import { renderProject, createStillRenderer } from "../src/render/renderProject";
import { collectFrameEvidence } from "../src/agents/qa";
import { frameDiff, analyzeFrame } from "../src/render/frameEvidence";
import { evaluateProjectLayoutGate } from "../src/validation/layoutGate";
import { evaluateVisualGates } from "../src/validation/visualGates";
import { evaluateSemanticEnactment, ENACTMENT } from "../src/validation/semanticEnactment";
import { collectEventEvidence } from "../src/agents/eventEvidence";
import { classifyFailures } from "../src/agents/repairContext";
import { recordRender, recordQa, recordFinal, verifyConsistency, summarizeConsistency, readRenderRecord } from "../src/core/artifacts";
import { writeDiagnostics } from "../src/core/diagnostics";
import { projectDir, writeJsonAt } from "../src/core/projectStore";
import { scenesFingerprint } from "../src/core/identity";
import { OUTPUT } from "../src/core/output";
import type { SceneSpec } from "../src/validation/schema";
import {
  passScene,
  allBrokenFixtures,
  legacyStoryboardScene,
} from "../tests/fixtures/batchD";

const ID = "_batchd_semantic";

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
  console.log("[batchD-semantic] staging PASS fixture");
  const scene = passScene();
  const dir = stage([scene]);

  /* ------------------------------- PASS CASE ------------------------------- */
  console.log("\n--- 1. contract resolution ---");
  const gate = evaluateSemanticEnactment([scene]);
  const s0 = gate.scenes[0];
  check("semantic contract active", s0.contractActive);
  check("objects resolve (person_01, gate_01 present)", s0.objects.missing.length === 0 && s0.objects.present.length === 2, s0.objects.present.join(","));
  check("events resolve (3 promised, 3 in plan)", s0.events.length === 3 && s0.events.every((e) => e.planAt !== null), s0.events.map((e) => `${e.eventId}@${e.planAt}`).join(" "));
  check("relationships resolve (movesToward present)", s0.relationships.length === 1 && s0.relationships[0].type === "movesToward", `${s0.relationships[0]?.type}`);
  check("semantic gate PASS", gate.ok, gate.compact.join(" | "));
  check("compact evidence line format", /^objects=2\/2 events=3\/3 relationships=1\/1$/.test(s0.summary) && gate.compact[0] === `scene_01: ${s0.summary}`, gate.compact[0]);
  check(
    "every event timed inside tolerance",
    s0.events.every((e) => e.status === "pass" && Math.abs(e.timingDeltaSec ?? 9) <= ENACTMENT.timingToleranceSec),
    s0.events.map((e) => `${e.id}:d=${e.timingDeltaSec}`).join(" "),
  );

  console.log("\n--- 2. execution plan changes the rendered scene ---");
  const audioPath = `${ID}/voice.wav`;
  const outFile = await renderProject({ scenes: [scene], outputName: "batchd-semantic.mp4" });
  const dest = path.join(dir, "renders", "preview.mp4");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(outFile, dest);
  const rr = recordRender(dir, { file: dest, scenes: [scene], label: "preview" });
  check("render recorded", Boolean(rr.sha256), rr.sha256.slice(0, 12));

  const still = await createStillRenderer([scene], undefined);
  const shot = async (t: number, name: string): Promise<string> => {
    const file = path.join(dir, "qa", "events", "stills", `${name}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await still(Math.round(t * OUTPUT.fps), file);
    return file;
  };
  const preEnter = await shot(0.2, "t0_pre_enter");
  const postEnter = await shot(1.4, "t1_entered");
  const beforeMove = await shot(2.0, "t2_before_move");
  const afterMove = await shot(3.2, "t3_after_move");
  const gateOpen = await shot(4.2, "t4_gate_open");

  const dEnter = await frameDiff(preEnter, postEnter);
  const dMove = await frameDiff(beforeMove, afterMove);
  const dGate = await frameDiff(afterMove, gateOpen);
  check("enter visibly changes pixels (person appears)", (dEnter ?? 0) > 0.004, `frameDiff=${dEnter}`);
  check("move visibly changes pixels (person crosses)", (dMove ?? 0) > 0.002, `frameDiff=${dMove}`);
  check("gate open visibly changes pixels (gate scales)", (dGate ?? 0) > 0.0005, `frameDiff=${dGate}`);

  const occupancy = async (file: string): Promise<number> => (await analyzeFrame(file))?.occupancy ?? 0;
  const occPre = await occupancy(preEnter);
  const occPost = await occupancy(postEnter);
  check("pre-enter frame carries less ink than entered frame", occPost > occPre, `occupancy ${occPre} -> ${occPost}`);

  console.log("\n--- 3. existing Batch A/B gates stay PASS on the render ---");
  const evidence = await collectFrameEvidence(ID, [scene], undefined, "r1");
  check("frame evidence written", evidence.samples.length > 0, `${evidence.samples.length} samples`);
  const layoutGate = await evaluateProjectLayoutGate([scene], evidence);
  const visualGates = evaluateVisualGates([scene], evidence);
  check("layout gate PASS (no hard findings)", layoutGate.hard.length === 0, layoutGate.hard.join(" | ") || "hard=0");
  check("visual gates PASS (no hard findings)", visualGates.hard.length === 0, visualGates.hard.join(" | ") || "hard=0");

  console.log("\n--- 4. event evidence stills (pre/at/post per event) ---");
  const ev = await collectEventEvidence(ID, [scene], undefined, { label: "events", maxEventsPerScene: 3 });
  check("event evidence reports written", ev.written.length === 3, ev.written.join(", "));
  for (const report of ev.reports) {
    const jsonPath = path.join(dir, report.stills[0].file.replace(/_[a-z]+\.png$/, ".json"));
    const exists = fs.existsSync(jsonPath);
    const parsed = exists ? JSON.parse(fs.readFileSync(jsonPath, "utf8")) : null;
    check(`${report.eventId}: json + 3 stills`, exists && report.stills.length === 3 && report.stills.every((st) => fs.existsSync(path.join(dir, st.file)) && st.sha256), `${report.status}`);
    if (parsed) {
      check(`${report.eventId}: before/at/after state recorded`, Boolean(parsed.state?.before && parsed.state?.at && parsed.state?.after), `detected=${parsed.detectedAt}`);
      check(`${report.eventId}: explains the verdict`, typeof parsed.evidence === "string" && parsed.evidence.length > 10, parsed.evidence.slice(0, 60));
    }
  }

  console.log("\n--- 5. artifact identity + diagnostics ---");
  recordQa(dir, { status: "pass", overallQuality: null, note: "Batch D semantic enactment E2E" }, { round: 1 });
  fs.copyFileSync(dest, path.join(dir, "renders", "final.mp4"));
  recordFinal(dir, { file: path.join(dir, "renders", "final.mp4"), copiedFrom: dest, scenes: [scene] });
  const consistency = verifyConsistency(dir, { requireQa: true, requireFinal: true });
  check("artifact consistency PASS", consistency.ok, summarizeConsistency(consistency));
  check("scenesHash stable across evidence", evidence.scenesHash === scenesFingerprint([scene]).scenesHash, `${String(evidence.scenesHash).slice(0, 12)}`);

  writeJsonAt(dir, "qa/semantic-enactment.json", gate); // same artifact the pipeline persists
  const diag = writeDiagnostics(dir);
  check("diagnostics carry the enactment gate", diag.gates.enactment !== null && diag.gates.enactment.ok, `hard=${diag.gates.enactment?.hard ?? "?"}`);
  check(
    "diagnostics answer 'why did event_03 happen?' without source code",
    (diag.gates.enactment?.events ?? []).some(
      (e) => e.eventId === "event_03" && e.status === "pass" && typeof e.detectedAt === "number" && e.evidence.length > 10,
    ),
    (diag.gates.enactment?.events ?? []).map((e) => `${e.eventId}:${e.status}@${e.detectedAt}`).join(" "),
  );

  /* ------------------------------ FAILURE CASES ----------------------------- */
  console.log("\n--- 6. broken fixtures classify deterministically ---");
  for (const fixture of allBrokenFixtures()) {
    const r = evaluateSemanticEnactment([fixture.scene]);
    const types = r.failures.map((f) => f.type);
    check(`${fixture.name} -> ${fixture.expected}`, !r.ok && types.length === 1 && types[0] === fixture.expected, types.join(","));
    const classified = classifyFailures({ scenes: [fixture.scene], semantic: r });
    check(`${fixture.name} classified for repair`, classified.some((f) => f.type === fixture.expected && f.severity === "hard" && f.source === "deterministic-semantic"));
  }

  console.log("\n--- 7. legacy scene stays untouched ---");
  const legacy = evaluateSemanticEnactment([legacyStoryboardScene()]);
  check("legacy scene: no contract, no failures", legacy.ok && !legacy.scenes[0].contractActive, legacy.compact.join(""));

  const failed = results.filter((r) => !r[1]);
  console.log(`\n[batchD-semantic] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => `${f[0]} ${f[2]}`).join(" | "));
    process.exitCode = 1;
  } else {
    console.log(`  render sha=${(readRenderRecord(dir)?.sha256 ?? "").slice(0, 12)}  event reports=${ev.written.length}`);
  }
}

void main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
