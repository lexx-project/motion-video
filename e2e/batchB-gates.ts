/**
 * Batch B deterministic E2E: layout gate + readability gates + VO timing on the REAL
 * Phase-3 scenes and the REAL frame evidence produced by the Batch A E2E.
 *
 * No LLM is called. Run after e2e/batchA-e2e.ts (which produces the artifacts this reads).
 *
 * Run: npx tsx e2e/batchB-gates.ts
 */
import fs from "fs";
import path from "path";
import { evaluateProjectLayoutGate } from "../src/validation/layoutGate";
import { evaluateVisualGates } from "../src/validation/visualGates";
import { aggregateQa } from "../src/agents/qa";
import { fitBeatDurations } from "../src/agents/voTiming";
import {
  detectSpeechEvidence,
  alignTilingToGaps,
  MIN_BEAT_DURATION_SEC,
  BOUNDARY_SNAP_TOLERANCE_SEC,
} from "../src/core/timing";
import { listSceneFilesAt, projectDir, writeJsonAt, readJsonAt } from "../src/core/projectStore";
import { writeDiagnostics, readDiagnostics } from "../src/core/diagnostics";
import { verifyConsistency, summarizeConsistency, readRenderRecord } from "../src/core/artifacts";
import type { SceneSpec } from "../src/validation/schema";
import type { FrameEvidenceReport } from "../src/render/frameEvidence";
import type { Beat } from "../src/agents/schemas";

const PROJECT = "_batcha_e2e";
const dir = projectDir(PROJECT);

const results: [string, boolean, string][] = [];
const check = (label: string, pass: boolean, detail = ""): void => {
  results.push([label, pass, detail]);
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
};

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(dir, "qa", "frame-evidence.json"))) {
    throw new Error("run e2e/batchA-e2e.ts first - frame evidence missing");
  }
  // the Batch A fixture stages scenes+voice only; bring the VO timing artifacts across so the
  // diagnostics can report timing provenance for the same voice file
  const sourceDir = projectDir("proj_p3_demo");
  if (!fs.existsSync(path.join(dir, "analysis"))) {
    fs.cpSync(path.join(sourceDir, "analysis"), path.join(dir, "analysis"), { recursive: true });
  }
  const scenes = listSceneFilesAt(dir).map((s) => s.data as SceneSpec);
  const evidence = readJsonAt<FrameEvidenceReport>(dir, "qa/frame-evidence.json")!;
  console.log(`[batchB-gates] ${scenes.length} scenes, evidence label=${evidence.label} samples=${evidence.samples.length}`);

  /* --- B2/B4/B7: layout + readability gates over the real evidence ------------- */
  console.log("\n--- layout gate ---");
  const layoutGate = await evaluateProjectLayoutGate(scenes, evidence);
  writeJsonAt(dir, "qa/layout-gate.json", layoutGate);
  for (const f of layoutGate.findings) console.log(`  ${f.sceneId}: ${f.summary}${f.hard.length ? ` HARD=[${f.hard.join(" | ")}]` : ""}`);

  const s03 = layoutGate.findings.find((f) => f.sceneId === "scene_03")!;
  check("scene_03 hard failure reported by the layout gate", s03.hard.length > 0, s03.hard.join("; ").slice(0, 110));
  check("scene_03 model AND pixels agree the frame is clipped", s03.agreement.frame === "both", s03.agreement.frame);
  const s03clip = s03.model.frameViolations.find((v) => v.side === "right");
  check("scene_03 model predicts right-edge overflow (>=8px)", (s03clip?.px ?? 0) >= 8, `model=${s03clip?.px ?? 0}px pixelEdgeInk=${s03?.rendered?.edgeInk.right}`);

  const s01 = layoutGate.findings.find((f) => f.sceneId === "scene_01")!;
  const s01Model = Math.max(...s01.model.safeAreaViolations.map((v) => v.px), 0);
  const s01Pixel = Math.max(...(s01.rendered ? Object.values(s01.rendered.safeAreaOverflowPx) : [0]), 0);
  check("scene_01 model/pixel safe-area crossing agree within 6px", s01Pixel > 0 && Math.abs(s01Model - s01Pixel) <= 6, `model=${s01Model} pixel=${s01Pixel}`);
  check("scene_01 is a warning, not a hard failure", s01.hard.length === 0 && s01.warnings.length > 0);

  for (const id of ["scene_02", "scene_05", "scene_06"]) {
    const f = layoutGate.findings.find((x) => x.sceneId === id)!;
    check(`${id} has no hard layout failure`, f.hard.length === 0, f.hard.join("; ").slice(0, 90));
  }

  console.log("\n--- readability / empty-scene gates ---");
  const visualGates = evaluateVisualGates(scenes, evidence);
  writeJsonAt(dir, "qa/visual-gates.json", visualGates);
  for (const s of visualGates.scenes) {
    console.log(`  ${s.sceneId}: empty=${s.empty.status} (${s.empty.reason.slice(0, 90)}) readability=${s.readability.status}`);
  }
  const s04 = visualGates.scenes.find((s) => s.sceneId === "scene_04")!;
  check("scene_04 flagged as accidentally empty (not trusted by element count)", s04.empty.status === "fail", s04.empty.reason.slice(0, 110));
  check("scene_04 emptiness cites the dead band", /middle/.test(s04.empty.reason));
  for (const id of ["scene_01", "scene_02", "scene_03", "scene_05", "scene_06"]) {
    const s = visualGates.scenes.find((x) => x.sceneId === id)!;
    check(`${id} not flagged empty`, s.empty.status !== "fail", s.empty.status);
  }

  /* --- B5/B7: aggregate QA consumes the gates ---------------------------------- */
  console.log("\n--- aggregate QA ---");
  const technical = readJsonAt<Record<string, unknown>>(dir, "qa/record.json");
  const qaPayload = {
    status: "fail",
    overallQuality: null,
    note: "Batch B E2E: deterministic gates only (LLM judges not run here)",
    technical: technical ?? null,
  };
  const aggregated = aggregateQa(
    { file: "renders/preview.mp4", durationSec: 24.939, width: 1080, height: 1920, fps: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac", errors: [] },
    {
      evaluatorCount: 3,
      projectStatus: "pass",
      overall: { scriptRelevance: 9, visualClarity: 9, designConsistency: 9, typography: 9, composition: 9, motionQuality: 9, novelty: 8, aiSlopSeverity: 1, technicalCorrectness: "pass", stats: { mean: 9, median: 9, variance: 0, confidence: 1 } },
      scenes: scenes.map((s) => ({
        sceneId: s.sceneId,
        scores: { scriptRelevance: 9, visualClarity: 9, designConsistency: 9, typography: 9, composition: 9, motionQuality: 9, novelty: 8, aiSlopSeverity: 1 },
        stats: { mean: 9, median: 9, variance: 0, confidence: 1 },
        technicalCorrectness: "pass",
        issues: [],
        recommendedRepair: [],
      })),
    },
    { projectSeverity: 1, verdict: "acceptable", findings: [] },
    { results: [], rejectedSceneIds: [], status: "pass" },
    undefined,
    undefined,
    { layoutGate, visualGates },
  );
  check("aggregate QA fails on the deterministic findings", aggregated.status === "fail", aggregated.status);
  check("scene_03 clipping reaches the QA reasons", aggregated.reasons.join(" ").includes("scene_03"), "");
  check("scene_04 empty scene reaches the QA reasons", aggregated.reasons.join(" ").includes("scene_04"), "");
  check("passing vision score contradiction is called out", aggregated.reasons.join(" ").includes("contradicts a passing vision score"));

  /* --- B1: VO timing evidence -------------------------------------------------- */
  console.log("\n--- VO timing ---");
  const voice = path.join(dir, "input", "voice.wav");
  const speech = await detectSpeechEvidence(voice);
  check("speech pauses measured from the VO", speech.source === "silence" && speech.gaps.length >= 5, `${speech.gaps.length} gaps, ${speech.segments.length} segments`);

  // beats/phrases come from the staged analysis (same voice file)
  const storedBeats = readJsonAt<{ beats: (Beat & { timing?: { start: number; end: number } })[] }>(dir, "analysis/beats.json")!;
  const phrases = readJsonAt<{ phrases: { text: string; start: number; end: number }[] }>(dir, "analysis/timestamps.json")!.phrases;
  const oldTiling = storedBeats.beats.map((b) => ({ start: b.timing!.start, end: b.timing!.end }));
  const oldError = oldTiling.slice(0, -1).reduce((n, seg, i) => {
    const nearest = speech.gaps.reduce((best, g) => Math.min(best, Math.abs(g.mid - seg.end)), Infinity);
    return n + nearest;
  }, 0);
  const fitted = fitBeatDurations(storedBeats.beats as Beat[], phrases, speech.durationSec, "silence", { gaps: speech.gaps });
  const newError = fitted.slice(0, -1).reduce((n, b) => {
    const nearest = speech.gaps.reduce((best, g) => Math.min(best, Math.abs(g.mid - b.end)), Infinity);
    return n + nearest;
  }, 0);
  const total = fitted.reduce((n, b) => n + b.duration, 0);
  const aligned = fitted.filter((b) => b.evidence?.aligned).length;
  check("scene durations still tile the audio exactly", Math.abs(total - speech.durationSec) < 0.02, `${total.toFixed(3)}s of ${speech.durationSec.toFixed(3)}s`);
  check("every scene respects the minimum duration", fitted.every((b) => b.duration >= MIN_BEAT_DURATION_SEC - 1e-6), `min=${Math.min(...fitted.map((b) => b.duration)).toFixed(2)}s`);
  check("boundaries snap onto measured pauses", aligned >= 3, `${aligned}/${fitted.length} aligned`);
  check("total boundary error against real pauses shrinks", newError < oldError, `old=${oldError.toFixed(2)}s new=${newError.toFixed(2)}s`);
  check("provenance recorded per scene", fitted.every((b) => b.evidence !== undefined && (b.evidence.alignedTo === "silence-gap" || b.evidence.alignedTo === "proportional")), fitted[0].evidence?.alignedTo ?? "?");

  // write the aligned timing back exactly as the timing stage would, so the diagnostics
  // report the new provenance instead of the pre-Batch-B placeholder
  const phraseTiling = phrases.map((p) => ({ start: p.start, end: p.end }));
  const alignedPhrases = alignTilingToGaps(phraseTiling, speech.gaps, {
    minSegmentSec: 0.5,
    toleranceSec: BOUNDARY_SNAP_TOLERANCE_SEC,
  });
  writeJsonAt(dir, "analysis/timestamps.json", {
    source: "silence",
    audioDurationSec: speech.durationSec,
    phrases: phrases.map((p, i) => ({
      ...p,
      start: Number(alignedPhrases.tiling[i].start.toFixed(3)),
      end: Number(alignedPhrases.tiling[i].end.toFixed(3)),
    })),
    gaps: speech.gaps,
    segments: speech.segments,
    snapToleranceSec: BOUNDARY_SNAP_TOLERANCE_SEC,
  });
  writeJsonAt(dir, "analysis/beats.json", {
    ...storedBeats,
    beats: storedBeats.beats.map((b, i) => ({ ...b, timing: fitted[i] })),
  });

  /* --- diagnostics + artifact consistency ------------------------------------- */
  console.log("\n--- diagnostics / consistency ---");
  const diag = writeDiagnostics(dir);
  check("diagnostics carry the layout gate", diag.gates?.layout !== null, `hard=${diag.gates?.layout?.hard.length ?? "?"}`);
  check("diagnostics carry the visual gates", diag.gates?.visual !== null, `scene_04=${diag.gates?.visual?.perScene.find((s) => s.sceneId === "scene_04")?.empty ?? "?"}`);
  check(
    "diagnostics carry timing provenance",
    diag.timing !== null && diag.timing.source === "silence" && diag.timing.measuredGaps >= 5 && diag.timing.alignedBoundaries >= 3,
    `${diag.timing?.source ?? "?"} gaps=${diag.timing?.measuredGaps ?? 0} aligned=${diag.timing?.alignedBoundaries ?? 0}`,
  );

  const consistency = verifyConsistency(dir, { requireQa: true, requireFinal: true });
  check("no stale-artifact behaviour introduced (Batch A consistency still holds)", consistency.ok, summarizeConsistency(consistency));
  const render = readRenderRecord(dir)!;
  check("frame evidence still references the recorded render", evidence.sourceRender?.sha256 === render.sha256);

  const failed = results.filter((r) => !r[1]);
  console.log(`\n[batchB-gates] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f[0]).join(" | "));
    process.exitCode = 1;
  } else {
    console.log(`  layout hard: ${layoutGate.hard.length}`);
    console.log(`  visual hard: ${visualGates.hard.length}`);
    console.log(`  aligned boundaries: ${aligned}`);
    console.log(`  diagnostics: ${path.join(dir, "qa", "diagnostics.json")}`);
  }
}

void main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
