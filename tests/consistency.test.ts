import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { writeJsonAt, readJsonAt } from "../src/core/projectStore";
import {
  ensureRenderRecord,
  readQaRecord,
  readRenderRecord,
  recordFinal,
  recordQa,
  recordRender,
  resolveRecordPath,
  toRecordPath,
  verifyConsistency,
} from "../src/core/artifacts";
import { buildDiagnostics, writeDiagnostics, DIAGNOSTICS_PATH } from "../src/core/diagnostics";
import { createSnapshot } from "../src/core/snapshot";

interface Project {
  dir: string;
  scenes: { sceneId: string; duration: number; elements: unknown[] }[];
}

const sceneA = { sceneId: "scene_01", duration: 3, elements: [{ primitive: "Circle" }] };
const sceneB = { sceneId: "scene_02", duration: 2, elements: [{ primitive: "Line" }] };

function makeProject(): Project {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consistency-"));
  const scenes = [sceneA, sceneB];
  for (const s of scenes) writeJsonAt(dir, `scenes/${s.sceneId}.json`, s);
  fs.mkdirSync(path.join(dir, "renders"), { recursive: true });
  fs.mkdirSync(path.join(dir, "qa"), { recursive: true });
  return { dir, scenes };
}

function writeArtifact(dir: string, name: string, content: string): string {
  const file = path.join(dir, "renders", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const codes = (r: { issues: { code: string }[] }): string[] => r.issues.map((i) => i.code);

describe("artifact identity records (A4)", () => {
  it("same artifact + same scene state => same identity", () => {
    const { dir, scenes } = makeProject();
    const file = writeArtifact(dir, "preview.mp4", "RENDER-BYTES");
    const first = recordRender(dir, { file, scenes, label: "preview" });
    const second = recordRender(dir, { file, scenes, label: "preview" });
    expect(second.sha256).toBe(first.sha256);
    expect(second.scenesHash).toBe(first.scenesHash);
    expect(ensureRenderRecord(dir, file, scenes).sha256).toBe(first.sha256);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("changed artifact => new rendered-video identity, changed scene => new scene identity", () => {
    const { dir, scenes } = makeProject();
    const file = writeArtifact(dir, "preview.mp4", "RENDER-BYTES");
    const first = recordRender(dir, { file, scenes, label: "preview" });

    writeArtifact(dir, "preview.mp4", "RENDER-BYTES-V2");
    const rerendered = recordRender(dir, { file, scenes, label: "preview" });
    expect(rerendered.sha256).not.toBe(first.sha256);

    const mutated = { ...sceneB, duration: 9 };
    const rescened = recordRender(dir, { file, scenes: [sceneA, mutated], label: "preview" });
    expect(rescened.scenesHash).not.toBe(first.scenesHash);
    expect(rescened.sha256).toBe(rerendered.sha256);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stores portable project-relative paths when the artifact lives inside the project", () => {
    const { dir } = makeProject();
    const file = path.join(dir, "renders", "preview.mp4");
    expect(toRecordPath(dir, file)).toBe("renders/preview.mp4");
    expect(toRecordPath(dir, path.join(os.tmpdir(), "elsewhere.mp4"))).toContain("elsewhere.mp4");
    // relative records resolve back to the artifact
    expect(path.resolve(resolveRecordPath(dir, toRecordPath(dir, file)))).toBe(path.resolve(file));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("QA cannot be attached to a different artifact identity", () => {
    const { dir, scenes } = makeProject();
    const file = writeArtifact(dir, "preview.mp4", "RENDER-BYTES");
    recordRender(dir, { file, scenes, label: "preview" });

    // artifact silently replaced after rendering
    writeArtifact(dir, "preview.mp4", "SILENTLY-REPLACED");
    expect(() => recordQa(dir, { status: "pass", overallQuality: 9 })).toThrow(
      /render artifact changed after rendering/,
    );

    // no render record at all
    const other = makeProject();
    expect(() => recordQa(other.dir, { status: "pass" })).toThrow(/no render record/);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other.dir, { recursive: true, force: true });
  });

  it("QA identity is stable for the same payload and self-described in the summary", () => {
    const { dir, scenes } = makeProject();
    const file = writeArtifact(dir, "preview.mp4", "RENDER-BYTES");
    recordRender(dir, { file, scenes, label: "preview" });
    const payload = { status: "needs_repair", overallQuality: 6.16, reasons: ["overall quality 6.2 < 8"] };
    const rec = recordQa(dir, payload, { round: 0 });
    const again = recordQa(dir, payload, { round: 1 });
    expect(again.qaSha256).toBe(rec.qaSha256);

    const summary = readJsonAt<Record<string, any>>(dir, "qa/qa-summary.json")!;
    expect(summary.identity.qaSha256).toBe(rec.qaSha256);
    expect(summary.identity.renderSha256).toBe(rec.renderSha256);
    expect(summary.status).toBe("needs_repair");
    expect(readQaRecord(dir)!.renderSha256).toBe(readRenderRecord(dir)!.sha256);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("render / QA / final consistency (A6)", () => {
  const finalize = (p: Project, renderBytes: string): string => {
    const file = writeArtifact(p.dir, "preview.mp4", renderBytes);
    recordRender(p.dir, { file, scenes: p.scenes, label: "preview" });
    recordQa(p.dir, { status: "needs_repair", overallQuality: 6.2 }, { round: 0 });
    const finalFile = path.join(p.dir, "renders", "final.mp4");
    fs.copyFileSync(file, finalFile);
    recordFinal(p.dir, { file: finalFile, copiedFrom: file, scenes: p.scenes });
    return file;
  };

  it("accepts a fully consistent run", () => {
    const p = makeProject();
    finalize(p, "RENDER-BYTES");
    const r = verifyConsistency(p.dir, { requireQa: true, requireFinal: true });
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.renderSha256).toBe(r.qaRenderSha256);
    expect(r.finalSha256).toBe(r.renderSha256);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it("detects a stale final artifact (final.mp4 not the render QA scored)", () => {
    const p = makeProject();
    finalize(p, "RENDER-BYTES");
    // re-render + re-QA, but final.mp4 was never re-copied
    writeArtifact(p.dir, "preview.mp4", "RENDER-BYTES-V2");
    recordRender(p.dir, { file: path.join(p.dir, "renders", "preview.mp4"), scenes: p.scenes, label: "preview" });
    recordQa(p.dir, { status: "needs_repair", overallQuality: 6.4 }, { round: 1 });

    const r = verifyConsistency(p.dir, { requireQa: true, requireFinal: true });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("final_stale");
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it("detects QA that belongs to a different render", () => {
    const p = makeProject();
    finalize(p, "RENDER-BYTES");
    writeArtifact(p.dir, "preview.mp4", "RENDER-BYTES-V2");
    recordRender(p.dir, { file: path.join(p.dir, "renders", "preview.mp4"), scenes: p.scenes, label: "preview" });

    const r = verifyConsistency(p.dir, { requireQa: true, requireFinal: true });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("qa_render_mismatch");
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it("detects scene JSON changed after the render", () => {
    const p = makeProject();
    finalize(p, "RENDER-BYTES");
    writeJsonAt(p.dir, "scenes/scene_02.json", { ...sceneB, duration: 7 });

    const r = verifyConsistency(p.dir, { requireQa: true, requireFinal: true });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("scenes_changed_after_render");
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it("detects a render artifact that changed after it was recorded", () => {
    const p = makeProject();
    finalize(p, "RENDER-BYTES");
    writeArtifact(p.dir, "preview.mp4", "CORRUPTED-AFTER-RENDER");

    const r = verifyConsistency(p.dir, { requireQa: true, requireFinal: true });
    expect(codes(r)).toContain("render_hash_mismatch");
    expect(r.ok).toBe(false);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it("detects a QA summary edited after it was recorded", () => {
    const p = makeProject();
    finalize(p, "RENDER-BYTES");
    const summary = readJsonAt<Record<string, unknown>>(p.dir, "qa/qa-summary.json")!;
    summary.overallQuality = 9.9;
    writeJsonAt(p.dir, "qa/qa-summary.json", summary);

    const r = verifyConsistency(p.dir, { requireQa: true, requireFinal: true });
    expect(codes(r)).toContain("qa_hash_mismatch");
    expect(r.ok).toBe(false);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it("refuses to claim 'complete' while artifacts disagree", () => {
    const p = makeProject();
    finalize(p, "RENDER-BYTES");
    writeJsonAt(p.dir, "scenes/scene_01.json", { ...sceneA, duration: 8 });

    const r = verifyConsistency(p.dir, { requireQa: true, requireFinal: true, manifest: { status: "complete" } });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("manifest_complete_inconsistent");
    fs.rmSync(p.dir, { recursive: true, force: true });
  });
});

describe("diagnostic report (A7)", () => {
  it("answers what was rendered, which QA belongs to it, what changed and what is restorable", () => {
    const p = makeProject();
    const file = writeArtifact(p.dir, "preview.mp4", "RENDER-BYTES");
    recordRender(p.dir, { file, scenes: p.scenes, label: "preview" });

    createSnapshot(p.dir, "accepted-baseline", { scenes: p.scenes });

    recordQa(p.dir, { status: "needs_repair", overallQuality: 6.16 }, { round: 0 });

    writeJsonAt(p.dir, "qa/frame-evidence.json", {
      schema: "frame-evidence/1",
      label: "r1",
      generatedAt: "2026-10-08T00:00:00.000Z",
      fps: 30,
      sourceRender: { file: "renders/preview.mp4", sha256: readRenderRecord(p.dir)!.sha256 },
      scenesHash: readRenderRecord(p.dir)!.scenesHash,
      samples: [
        {
          sceneId: "scene_01",
          sampleIndex: 0,
          reason: "mid",
          timeSec: 1.5,
          sceneFrame: 45,
          absoluteFrame: 45,
          file: "qa/frames/r1/x.png",
          sha256: "f".repeat(64),
          metrics: { occupancy: 0.03, edgeInk: { left: 0, right: 0, top: 0, bottom: 0 }, contentOutsideFrame: false },
        },
      ],
      sceneRollup: [
        {
          sceneId: "scene_01",
          sampleCount: 1,
          minOccupancy: 0.03,
          maxEdgeInk: 0,
          maxSafeAreaOverflowPx: 0,
          contentOutsideFrame: false,
          motionDelta: 0.004,
        },
      ],
    });

    // change one scene after the baseline was accepted
    writeJsonAt(p.dir, "scenes/scene_02.json", { ...sceneB, duration: 4 });

    const report = buildDiagnostics(p.dir);
    expect(report.schema).toBe("diagnostics/1");
    expect(report.projectId).toBe(path.basename(p.dir));
    expect(report.render!.sha256).toBe(readRenderRecord(p.dir)!.sha256);
    expect(report.qa!.qaSha256).toBe(readQaRecord(p.dir)!.qaSha256);
    expect(report.qa!.overallQuality).toBe(6.16);
    expect(report.frames!.sampleCount).toBe(1);
    expect(report.frames!.samples[0].file).toBe("qa/frames/r1/x.png");
    expect(report.frames!.matchesCurrentRender).toBe(true);
    expect(report.frames!.sceneRollup[0].motionDelta).toBe(0.004);
    expect(report.baseline!.label).toBe("accepted-baseline");
    expect(report.changesSinceBaseline!.changed).toEqual(["scene_02"]);
    expect(report.changesSinceBaseline!.unchanged).toEqual(["scene_01"]);
    // the same drift is reported as a consistency problem (scene state moved after the render)
    expect(report.frames!.matchesCurrentScenes).toBe(false);
    expect(report.consistency.ok).toBe(false);
    expect(codes(report.consistency)).toContain("scenes_changed_after_render");
    expect(report.project.scenes.map((s) => s.sceneId)).toEqual(["scene_01", "scene_02"]);
    // model-side bounds evidence is part of the report (A3)
    expect(report.sceneBounds.map((b) => b.sceneId)).toEqual(["scene_01", "scene_02"]);
    expect(report.sceneBounds[0].contentBox).not.toBeNull();
    expect(report.sceneBounds[0].frameViolations).toBe(0);

    const written = readJsonAt<Record<string, unknown>>(p.dir, DIAGNOSTICS_PATH);
    expect(written).toBeNull(); // buildDiagnostics does not write
    writeDiagnostics(p.dir);
    expect(readJsonAt<Record<string, unknown>>(p.dir, DIAGNOSTICS_PATH)).not.toBeNull();
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it("reports missing artifacts without throwing", () => {
    const p = makeProject();
    const report = buildDiagnostics(p.dir);
    expect(report.render).toBeNull();
    expect(report.qa).toBeNull();
    expect(report.final).toBeNull();
    expect(report.frames).toBeNull();
    expect(report.baseline).toBeNull();
    expect(report.changesSinceBaseline).toBeNull();
    expect(report.consistency.issues.map((i) => i.code)).toContain("render_record_missing");
    fs.rmSync(p.dir, { recursive: true, force: true });
  });
});
