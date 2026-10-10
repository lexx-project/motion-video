import fs from "fs";
import path from "path";
import { readJsonAt, writeJsonAt, listSceneFilesAt } from "./projectStore";
import {
  fingerprintFile,
  scenesFingerprint,
  sha256Json,
  type FileFingerprint,
  type SceneFingerprint,
} from "./identity";

/**
 * Artifact identity records + render/QA/final consistency (Batch A / A4 + A6).
 *
 * Three identities, kept apart on purpose:
 *   - scene-state identity  : sha256 of the scene JSON set            (`scenesHash`)
 *   - rendered-video identity: sha256 of the mp4 on disk              (`renderSha256`)
 *   - QA-result identity    : sha256 of the QA payload (canonical)    (`qaSha256`)
 *
 * Records are written at the moment the work happens, so later stages can prove
 * "this QA result belongs to this render, which was produced by this scene state".
 *
 * `verifyConsistency` is the evidence behind A6: it reports drift instead of trusting
 * filenames or status strings. It does NOT enforce any QA quality threshold - a run may only
 * be `complete` when its artifacts are mutually consistent, never merely because status says so.
 */

export const RENDER_RECORD_PATH = "renders/record.json";
export const QA_RECORD_PATH = "qa/record.json";
export const QA_SUMMARY_PATH = "qa/qa-summary.json";
export const FINAL_RECORD_PATH = "renders/final.record.json";

export interface RenderRecord {
  schema: "render-record/1";
  label: string;
  /** project-relative when the artifact lives inside the project dir */
  file: string;
  sha256: string;
  sizeBytes: number;
  scenesHash: string;
  sceneIds: string[];
  generatedAt: string;
}

export interface QaRecord {
  schema: "qa-record/1";
  file: string;
  qaSha256: string;
  status: string | null;
  overallQuality: number | null;
  renderFile: string;
  renderSha256: string;
  scenesHash: string;
  generatedAt: string;
}

export interface FinalRecord {
  schema: "final-record/1";
  file: string;
  sha256: string;
  sizeBytes: number;
  copiedFrom: string;
  copiedFromSha256: string;
  scenesHash: string;
  qaSha256: string | null;
  generatedAt: string;
}

export type ConsistencySeverity = "error" | "warn" | "info";

export interface ConsistencyIssue {
  code:
    | "render_record_missing"
    | "render_artifact_missing"
    | "render_hash_mismatch"
    | "scenes_changed_after_render"
    | "qa_record_missing"
    | "qa_summary_missing"
    | "qa_hash_mismatch"
    | "qa_render_mismatch"
    | "qa_artifact_missing"
    | "final_record_missing"
    | "final_artifact_missing"
    | "final_hash_mismatch"
    | "final_stale"
    | "manifest_complete_inconsistent";
  severity: ConsistencySeverity;
  detail: string;
}

export interface ConsistencyReport {
  ok: boolean;
  issues: ConsistencyIssue[];
  renderSha256: string | null;
  qaRenderSha256: string | null;
  finalSha256: string | null;
  currentScenesHash: string;
}

/* --------------------------------- helpers ---------------------------------- */

/** Store project-relative paths when possible so records survive moving the project folder.
 *  Always slash-separated: the same record must resolve on Windows and POSIX. */
export function toRecordPath(dir: string, file: string): string {
  const abs = path.resolve(file);
  const root = path.resolve(dir);
  const rel =
    abs === root
      ? path.basename(file)
      : abs.startsWith(root + path.sep)
        ? path.relative(root, abs)
        : abs;
  return rel.split(path.sep).join("/");
}

export function resolveRecordPath(dir: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(dir, ...file.split(/[\\/]/));
}

export const currentScenes = (dir: string): unknown[] => listSceneFilesAt(dir).map((s) => s.data);
export const currentScenesFingerprint = (dir: string): SceneFingerprint => scenesFingerprint(currentScenes(dir));

const nowIso = (explicit?: string): string => explicit ?? new Date().toISOString();

/* -------------------------------- render record ------------------------------ */

export interface RecordRenderOptions {
  file: string;
  scenes: unknown[];
  label: string;
  generatedAt?: string;
}

/** Bind a freshly rendered artifact to the scene state that produced it. */
export function recordRender(dir: string, opts: RecordRenderOptions): RenderRecord {
  const fp = fingerprintFile(resolveRecordPath(dir, opts.file));
  if (!fp) throw new Error(`cannot record render: artifact missing (${opts.file})`);
  const sf = scenesFingerprint(opts.scenes);
  const rec: RenderRecord = {
    schema: "render-record/1",
    label: opts.label,
    file: toRecordPath(dir, fp.file),
    sha256: fp.sha256,
    sizeBytes: fp.sizeBytes,
    scenesHash: sf.scenesHash,
    sceneIds: sf.sceneIds,
    generatedAt: nowIso(opts.generatedAt),
  };
  writeJsonAt(dir, RENDER_RECORD_PATH, rec);
  return rec;
}

export const readRenderRecord = (dir: string): RenderRecord | null => readJsonAt<RenderRecord>(dir, RENDER_RECORD_PATH);

/**
 * Guarantee a render record matches the artifact actually on disk.
 * Idempotent: an unchanged artifact keeps byte-identical identity (only `generatedAt` refreshes
 * when the record has to be rewritten).
 */
export function ensureRenderRecord(
  dir: string,
  file: string,
  scenes: unknown[],
  label = "preview",
): RenderRecord {
  const abs = resolveRecordPath(dir, file);
  const fp = fingerprintFile(abs);
  if (!fp) throw new Error(`cannot bind render record: artifact missing (${file})`);
  const sf = scenesFingerprint(scenes);
  const existing = readRenderRecord(dir);
  if (
    existing &&
    existing.sha256 === fp.sha256 &&
    existing.scenesHash === sf.scenesHash &&
    toRecordPath(dir, abs) === existing.file
  ) {
    return existing;
  }
  return recordRender(dir, { file: abs, scenes, label });
}

/* ---------------------------------- QA record -------------------------------- */

export interface RecordQaOptions {
  round?: number;
  generatedAt?: string;
}

/**
 * Attach a QA result to the render that was actually inspected.
 *
 * Refuses (throws) when the render artifact changed after it was recorded - QA must never be
 * bound to a different artifact identity than the one it scored.
 */
export function recordQa(dir: string, qaPayload: unknown, opts: RecordQaOptions = {}): QaRecord {
  const render = readRenderRecord(dir);
  if (!render) {
    throw new Error(
      "cannot record QA: no render record - bind the artifact first with ensureRenderRecord/recordRender",
    );
  }
  const abs = resolveRecordPath(dir, render.file);
  const fp: FileFingerprint | null = fingerprintFile(abs);
  if (!fp) throw new Error(`cannot record QA: recorded render artifact missing (${render.file})`);
  if (fp.sha256 !== render.sha256) {
    throw new Error(
      `cannot record QA: render artifact changed after rendering (recorded ${render.sha256.slice(0, 12)}, ` +
        `on disk ${fp.sha256.slice(0, 12)}). Re-render or re-bind with ensureRenderRecord.`,
    );
  }

  const payload = qaPayload ?? {};
  const body = (typeof payload === "object" && payload !== null ? payload : { value: payload }) as Record<string, unknown>;
  const status = (body as { status?: unknown }).status;
  const overallQuality = (body as { overallQuality?: unknown }).overallQuality;
  const rec: QaRecord = {
    schema: "qa-record/1",
    file: QA_SUMMARY_PATH,
    qaSha256: sha256Json(body),
    status: typeof status === "string" ? status : null,
    overallQuality: typeof overallQuality === "number" ? overallQuality : null,
    renderFile: render.file,
    renderSha256: render.sha256,
    scenesHash: render.scenesHash,
    generatedAt: nowIso(opts.generatedAt),
  };
  writeJsonAt(dir, QA_RECORD_PATH, rec);

  // self-describing summary: the QA payload plus the identity of what it describes
  writeJsonAt(dir, QA_SUMMARY_PATH, {
    ...body,
    identity: {
      schema: "qa-identity/1",
      qaSha256: rec.qaSha256,
      renderSha256: rec.renderSha256,
      renderFile: rec.renderFile,
      scenesHash: rec.scenesHash,
      round: opts.round ?? null,
      generatedAt: rec.generatedAt,
    },
  });
  return rec;
}

export const readQaRecord = (dir: string): QaRecord | null => readJsonAt<QaRecord>(dir, QA_RECORD_PATH);

/** Payload hash of a summary file that carries an `identity` block (used to detect edits). */
export function summaryPayloadSha256(dir: string): string | null {
  const summary = readJsonAt<Record<string, unknown>>(dir, QA_SUMMARY_PATH);
  if (!summary) return null;
  const { identity: _identity, ...rest } = summary;
  return sha256Json(rest);
}

/* -------------------------------- final record ------------------------------- */

export interface RecordFinalOptions {
  file: string;
  copiedFrom: string;
  scenes: unknown[];
  generatedAt?: string;
}

export function recordFinal(dir: string, opts: RecordFinalOptions): FinalRecord {
  const target = fingerprintFile(resolveRecordPath(dir, opts.file));
  const source = fingerprintFile(resolveRecordPath(dir, opts.copiedFrom));
  if (!target) throw new Error(`cannot record final: artifact missing (${opts.file})`);
  if (!source) throw new Error(`cannot record final: source artifact missing (${opts.copiedFrom})`);
  const qa = readQaRecord(dir);
  const rec: FinalRecord = {
    schema: "final-record/1",
    file: toRecordPath(dir, target.file),
    sha256: target.sha256,
    sizeBytes: target.sizeBytes,
    copiedFrom: toRecordPath(dir, source.file),
    copiedFromSha256: source.sha256,
    scenesHash: scenesFingerprint(opts.scenes).scenesHash,
    qaSha256: qa?.qaSha256 ?? null,
    generatedAt: nowIso(opts.generatedAt),
  };
  writeJsonAt(dir, FINAL_RECORD_PATH, rec);
  return rec;
}

export const readFinalRecord = (dir: string): FinalRecord | null => readJsonAt<FinalRecord>(dir, FINAL_RECORD_PATH);

/* -------------------------------- consistency -------------------------------- */

export interface VerifyOptions {
  /** finalization context: absence of QA/final artifacts becomes an error */
  requireQa?: boolean;
  requireFinal?: boolean;
  manifest?: { status?: string } | null;
}

/**
 * Evidence-based consistency check across scene state, render, QA and final artifact.
 * Reports drift; never rewrites anything; never judges visual quality.
 */
export function verifyConsistency(dir: string, opts: VerifyOptions = {}): ConsistencyReport {
  const issues: ConsistencyIssue[] = [];
  const add = (code: ConsistencyIssue["code"], severity: ConsistencySeverity, detail: string): void => {
    issues.push({ code, severity, detail });
  };

  const scenes = currentScenesFingerprint(dir);
  const render = readRenderRecord(dir);
  const qa = readQaRecord(dir);
  const final = readFinalRecord(dir);

  let renderSha: string | null = null;
  let qaRenderSha: string | null = null;
  let finalSha: string | null = null;

  if (!render) {
    add("render_record_missing", opts.requireQa ? "error" : "warn", "no renders/record.json - nothing has been bound to a render yet");
  } else {
    renderSha = render.sha256;
    const fp = fingerprintFile(resolveRecordPath(dir, render.file));
    if (!fp) {
      add("render_artifact_missing", "error", `recorded render artifact is gone: ${render.file}`);
    } else if (fp.sha256 !== render.sha256) {
      add(
        "render_hash_mismatch",
        "error",
        `render artifact changed after it was recorded (${render.sha256.slice(0, 12)} -> ${fp.sha256.slice(0, 12)})`,
      );
    }
    if (render.scenesHash !== scenes.scenesHash) {
      add(
        "scenes_changed_after_render",
        "error",
        `scene state changed after rendering (render ${render.scenesHash.slice(0, 12)} != current ${scenes.scenesHash.slice(0, 12)})`,
      );
    }
  }

  if (!qa) {
    if (opts.requireQa) add("qa_record_missing", "error", "no qa/record.json - QA has not been attached to this render");
  } else {
    qaRenderSha = qa.renderSha256;
    if (render && qa.renderSha256 !== render.sha256) {
      add(
        "qa_render_mismatch",
        "error",
        `QA was attached to a different render (${qa.renderSha256.slice(0, 12)} != ${render.sha256.slice(0, 12)})`,
      );
    }
    const summary = summaryPayloadSha256(dir);
    if (summary === null) {
      add("qa_summary_missing", "warn", `${QA_SUMMARY_PATH} is missing although a QA record exists`);
    } else if (summary !== qa.qaSha256) {
      add("qa_hash_mismatch", "error", `${QA_SUMMARY_PATH} no longer matches its recorded QA identity`);
    }
    const qaArtifact = fingerprintFile(resolveRecordPath(dir, qa.renderFile));
    if (!qaArtifact) {
      add("qa_artifact_missing", "error", `the artifact QA inspected is gone: ${qa.renderFile}`);
    } else if (qaArtifact.sha256 !== qa.renderSha256) {
      add(
        "qa_render_mismatch",
        "error",
        `the artifact QA inspected changed (recorded ${qa.renderSha256.slice(0, 12)}, on disk ${qaArtifact.sha256.slice(0, 12)})`,
      );
    }
    if (qa.scenesHash !== scenes.scenesHash) {
      add(
        "scenes_changed_after_render",
        "error",
        `scene state changed after QA (QA ${qa.scenesHash.slice(0, 12)} != current ${scenes.scenesHash.slice(0, 12)})`,
      );
    }
  }

  if (!final) {
    add(
      "final_record_missing",
      opts.requireFinal ? "error" : "info",
      "no renders/final.record.json - final.mp4 has not been committed in this run",
    );
  } else {
    finalSha = final.sha256;
    const fp = fingerprintFile(resolveRecordPath(dir, final.file));
    if (!fp) {
      add("final_artifact_missing", "error", `recorded final artifact is gone: ${final.file}`);
    } else if (fp.sha256 !== final.sha256) {
      add("final_hash_mismatch", "error", `final artifact changed after it was recorded`);
    }
    if (final.copiedFromSha256 !== final.sha256) {
      add("final_hash_mismatch", "error", `final.mp4 is not a byte-identical copy of ${final.copiedFrom}`);
    }
    if (qa && final.sha256 !== qa.renderSha256) {
      add(
        "final_stale",
        "error",
        `final.mp4 (${final.sha256.slice(0, 12)}) does not match the render QA scored (${qa.renderSha256.slice(0, 12)})`,
      );
    }
    if (final.scenesHash !== scenes.scenesHash) {
      add(
        "scenes_changed_after_render",
        "error",
        `scene state changed after the final artifact was committed (final ${final.scenesHash.slice(0, 12)} != current ${scenes.scenesHash.slice(0, 12)})`,
      );
    }
  }

  const hasErrors = issues.some((i) => i.severity === "error");
  if (opts.manifest?.status === "complete" && hasErrors) {
    add(
      "manifest_complete_inconsistent",
      "error",
      `manifest claims "complete" but the artifacts are inconsistent: ${issues
        .filter((i) => i.severity === "error")
        .map((i) => i.code)
        .join(", ")}`,
    );
  }

  return {
    ok: !hasErrors,
    issues,
    renderSha256: renderSha,
    qaRenderSha256: qaRenderSha,
    finalSha256: finalSha,
    currentScenesHash: scenes.scenesHash,
  };
}

/** Compact single-line summary for progress logs / stage errors. */
export const summarizeConsistency = (r: ConsistencyReport): string =>
  r.ok
    ? "consistent"
    : r.issues
        .filter((i) => i.severity === "error")
        .map((i) => `${i.code}: ${i.detail}`)
        .join(" | ");

/** True when the file exists (small helper used by callers deciding what to record). */
export const artifactExists = (dir: string, file: string): boolean =>
  fs.existsSync(resolveRecordPath(dir, file));
