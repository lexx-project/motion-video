/**
 * Batch A pipeline integration E2E: resumes a copy of the Phase-3 demo through the REAL
 * generateProject() pipeline so the Batch A wiring (render record, frame evidence, baseline
 * snapshots, QA attachment, finalization gate, diagnostics) is exercised in production code.
 *
 * All LLM stages are served from the resumed project's cache; only novelty/render/QA/repair
 * (which need vision) actually run. No historical project is modified.
 *
 * Run: npx tsx e2e/batchA-pipeline.ts
 */
import fs from "fs";
import path from "path";
import { generateProject } from "../src/agents/pipeline";
import {
  readFinalRecord,
  readQaRecord,
  readRenderRecord,
  verifyConsistency,
  summarizeConsistency,
} from "../src/core/artifacts";
import { listSnapshots } from "../src/core/snapshot";
import { readDiagnostics } from "../src/core/diagnostics";
import { sha256File } from "../src/core/identity";
import { projectDir } from "../src/core/projectStore";

const SRC = "proj_p3_demo";
const ID = "_batcha_pipeline";
const root = process.cwd();
const src = path.join(root, "projects", SRC);
const dst = projectDir(ID);

const results: [string, boolean, string][] = [];
const check = (label: string, pass: boolean, detail = ""): void => {
  results.push([label, pass, detail]);
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
};

function stage(): void {
  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    if (entry === "manifest.json" || entry === "renders" || entry === "qa") continue; // fresh artifacts
    fs.cpSync(path.join(src, entry), path.join(dst, entry), { recursive: true });
  }
  fs.mkdirSync(path.join(dst, "renders"), { recursive: true });
  fs.mkdirSync(path.join(dst, "qa"), { recursive: true });
}

async function main(): Promise<void> {
  console.log(`[batchA-pipeline] staging copy of ${SRC} -> ${ID}`);
  stage();

  const script = fs.readFileSync(path.join(src, "input", "script.md"), "utf8");
  let threw = "";
  try {
    const res = await generateProject({
      projectId: ID,
      script,
      resume: true,
      // Batch C §16: this project is a COPY of SRC - novelty must not compare it against its
      // own source (that is what sent the pre-Batch-C run into a >11 minute repair stall).
      fixture: { copiedFrom: SRC },
      onProgress: (stageName, detail) => console.log(`[${stageName}] ${detail ?? ""}`),
    });
    console.log(`[batchA-pipeline] generateProject -> status=${res.status} qa=${res.qa?.status}`);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
    console.error(`[batchA-pipeline] generateProject threw: ${threw.slice(0, 400)}`);
  }

  console.log("\n--- Batch A wiring checks ---");
  const render = readRenderRecord(dst);
  check("render record written", render !== null, render?.sha256.slice(0, 12));
  const preview = path.join(dst, "renders", "preview.mp4");
  check(
    "render record matches preview.mp4",
    Boolean(render && sha256File(preview) === render.sha256),
  );

  const evidencePath = path.join(dst, "qa", "frame-evidence.json");
  const evidence = fs.existsSync(evidencePath) ? JSON.parse(fs.readFileSync(evidencePath, "utf8")) : null;
  check("frame evidence written", evidence !== null, evidence ? `${evidence.samples.length} samples/${evidence.label}` : "");
  if (evidence && render) {
    check("frame evidence references the rendered artifact", evidence.sourceRender?.sha256 === render.sha256);
    check("frame evidence carries per-scene metrics", (evidence.sceneRollup ?? []).length > 0,
      (evidence.sceneRollup ?? []).map((r: { sceneId: string; maxEdgeInk: number }) => `${r.sceneId}:${r.maxEdgeInk}`).join(" "));
  }

  const qa = readQaRecord(dst);
  check("QA record written", qa !== null, qa ? `status=${qa.status}` : "");
  if (qa && render) check("QA attached to that render", qa.renderSha256 === render.sha256);

  const snaps = listSnapshots(dst);
  check("baseline snapshots exist (pre-repair)", snaps.length > 0, snaps.map((s) => s.label).join(","));

  const final = readFinalRecord(dst);
  check("final record written", final !== null, final?.sha256.slice(0, 12));
  if (final && render) {
    check("final.mp4 is byte-identical to the rendered artifact", sha256File(path.join(dst, "renders", "final.mp4")) === final.sha256);
    check("final matches the render QA scored", final.sha256 === qa?.renderSha256);
  }

  const diag = readDiagnostics(dst);
  check("diagnostics written", diag !== null, diag ? `${diag.frames?.sampleCount ?? 0} samples` : "");
  if (diag) {
    check("diagnostics consistency", diag.consistency.ok, summarizeConsistency(diag.consistency));
    check("diagnostics baseline restorable", Boolean(diag.baseline?.label), diag.baseline?.label ?? "");
    console.log(`  info: sceneBounds=${JSON.stringify(diag.sceneBounds?.map((b) => ({ id: b.sceneId, frame: b.frameViolations })))}`);
  }

  const consistency = verifyConsistency(dst, { requireQa: true, requireFinal: Boolean(final), manifest: null });
  check("verifyConsistency (post-run)", consistency.ok, summarizeConsistency(consistency));

  if (threw) check("generateProject completed", false, threw.slice(0, 160));

  const failed = results.filter((r) => !r[1]);
  console.log(`\n[batchA-pipeline] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f[0]).join(" | "));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exitCode = 1;
});
