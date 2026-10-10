import fs from "fs";
import path from "path";
import { listSceneFilesAt, readJsonAt, writeJsonAt } from "./projectStore";
import { scenesFingerprint, type SceneFingerprint } from "./identity";

/**
 * Snapshot + restore foundation (Batch A / A5).
 *
 * Enables the autonomous loop's basic transaction:
 *
 *     BASELINE -> EXPERIMENT -> KEEP or RESTORE
 *
 * This module only preserves and restores state. Deciding whether an experiment was better
 * (KEEP vs RESTORE) belongs to the repair loop (Batch B) - do not implement comparison here.
 *
 * Layout (fits the existing per-project architecture):
 *   projects/<id>/snapshots/<label>/snapshot.json     metadata + identities
 *   projects/<id>/snapshots/<label>/scenes/*.json     scene specs as accepted
 *   projects/<id>/snapshots/index.json                ordered list of snapshots
 */

export const SNAPSHOT_SCHEMA = "snapshot/1";

export interface SnapshotRecord {
  schema: typeof SNAPSHOT_SCHEMA;
  label: string;
  createdAt: string;
  sceneIds: string[];
  scenesHash: string;
  sceneHashes: Record<string, string>;
  /** identity of the artifact that was accepted at this baseline, when available */
  render: { file: string; sha256: string } | null;
  /** identity of the QA result that accepted this baseline, when available */
  qa: { qaSha256: string; status: string; renderSha256: string | null } | null;
  /** relative path of this snapshot's directory inside the project */
  dir: string;
}

export interface SnapshotIndex {
  schema: typeof SNAPSHOT_SCHEMA;
  snapshots: { label: string; createdAt: string; scenesHash: string }[];
}

const snapshotsRoot = (dir: string): string => path.join(dir, "snapshots");
const snapshotDir = (dir: string, label: string): string => path.join(snapshotsRoot(dir), sanitize(label));

/** Filesystem-safe label (scene ids, round names, timestamps). */
export function sanitize(label: string): string {
  const clean = String(label)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return clean.length > 0 ? clean : `snap-${Date.now()}`;
}

const readIndex = (dir: string): SnapshotIndex =>
  readJsonAt<SnapshotIndex>(dir, "snapshots/index.json") ?? { schema: SNAPSHOT_SCHEMA, snapshots: [] };

const writeIndex = (dir: string, index: SnapshotIndex): void => {
  writeJsonAt(dir, "snapshots/index.json", index);
};

/** Current scene state of a project directory as a fingerprint. */
export function currentSceneFingerprint(dir: string): SceneFingerprint {
  return scenesFingerprint(listSceneFilesAt(dir).map((s) => s.data));
}

export interface CreateSnapshotOptions {
  /** explicit scene specs; defaults to whatever is currently in <dir>/scenes */
  scenes?: unknown[];
  render?: { file: string; sha256: string } | null;
  qa?: { qaSha256: string; status: string; renderSha256: string | null } | null;
  createdAt?: string;
}

/**
 * Preserve the current (accepted) scene state plus artifact/QA identity.
 * Overwrites an existing snapshot with the same label only when the state is identical;
 * a different state under an existing label is a bug, so it fails loudly.
 */
export function createSnapshot(dir: string, label: string, opts: CreateSnapshotOptions = {}): SnapshotRecord {
  const safeLabel = sanitize(label);
  const scenes =
    opts.scenes ?? listSceneFilesAt(dir).map((s) => s.data);
  const fp = scenesFingerprint(scenes);
  const dirRel = path.join("snapshots", safeLabel);
  const target = path.join(dir, dirRel);

  const record: SnapshotRecord = {
    schema: SNAPSHOT_SCHEMA,
    label: safeLabel,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    sceneIds: fp.sceneIds,
    scenesHash: fp.scenesHash,
    sceneHashes: fp.sceneHashes,
    render: opts.render ?? null,
    qa: opts.qa ?? null,
    dir: dirRel,
  };

  const existing = readJsonAt<SnapshotRecord>(dir, path.join(dirRel, "snapshot.json"));
  if (existing && existing.scenesHash !== record.scenesHash) {
    throw new Error(
      `snapshot "${safeLabel}" already exists with different state (${existing.scenesHash} != ${record.scenesHash}). ` +
        `Use a new label instead of overwriting a baseline.`,
    );
  }

  fs.mkdirSync(path.join(target, "scenes"), { recursive: true });
  writeJsonAt(dir, path.join(dirRel, "snapshot.json"), record);
  for (const scene of scenes) {
    const id = (scene as { sceneId?: unknown } | null)?.sceneId;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) continue;
    writeJsonAt(dir, path.join(dirRel, "scenes", `${id}.json`), scene);
  }

  const index = readIndex(dir);
  if (!index.snapshots.some((s) => s.label === record.label)) {
    index.snapshots.push({ label: record.label, createdAt: record.createdAt, scenesHash: record.scenesHash });
    index.snapshots.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    writeIndex(dir, index);
  }
  return record;
}

/**
 * Same as createSnapshot but never collides: when the label already holds a different state,
 * a numeric suffix is appended (`round-1`, `round-1-2`, ...). Used by the pipeline where the
 * label repeats across resumed runs but the state does not.
 */
export function createSnapshotUnique(dir: string, label: string, opts: CreateSnapshotOptions = {}): SnapshotRecord {
  const base = sanitize(label);
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const existing = readJsonAt<SnapshotRecord>(dir, path.join("snapshots", candidate, "snapshot.json"));
    if (!existing) return createSnapshot(dir, candidate, opts);
    const fp = scenesFingerprint(opts.scenes ?? listSceneFilesAt(dir).map((s) => s.data));
    if (existing.scenesHash === fp.scenesHash) return existing; // identical baseline, reuse it
  }
  return createSnapshot(dir, `${base}-${Date.now()}`, opts);
}

export function listSnapshots(dir: string): SnapshotRecord[] {
  const index = readIndex(dir);
  const out: SnapshotRecord[] = [];
  for (const s of index.snapshots) {
    const rec = readJsonAt<SnapshotRecord>(dir, path.join("snapshots", s.label, "snapshot.json"));
    if (rec) out.push(rec);
  }
  return out;
}

export function readSnapshot(dir: string, label: string): SnapshotRecord | null {
  return readJsonAt<SnapshotRecord>(dir, path.join("snapshots", sanitize(label), "snapshot.json"));
}

/** Most recent snapshot (the current restorable baseline). */
export function latestSnapshot(dir: string): SnapshotRecord | null {
  const all = listSnapshots(dir);
  return all.length ? all[all.length - 1] : null;
}

export interface RestoreResult {
  label: string;
  restored: string[];
  /** scene ids that exist now but are not part of the snapshot (left untouched, flagged) */
  extras: string[];
  scenesHash: string;
  /** true only when the restored on-disk state matches the snapshot identity exactly */
  verified: boolean;
}

/**
 * Restore a snapshot's scene specs into <dir>/scenes.
 *
 * - restores every scene in the snapshot;
 * - does NOT delete scenes that the snapshot does not contain (never destroys data);
 * - verifies the restored state by re-hashing it against the recorded identity.
 */
export function restoreSnapshot(dir: string, label: string): RestoreResult {
  const rec = readSnapshot(dir, label);
  if (!rec) throw new Error(`snapshot not found: ${label}`);

  const snapScenesDir = path.join(dir, rec.dir, "scenes");
  if (!fs.existsSync(snapScenesDir)) throw new Error(`snapshot scenes missing: ${rec.dir}/scenes`);

  const restored: string[] = [];
  for (const file of fs.readdirSync(snapScenesDir).filter((f) => f.endsWith(".json"))) {
    const id = file.replace(/\.json$/, "");
    fs.mkdirSync(path.join(dir, "scenes"), { recursive: true });
    fs.copyFileSync(path.join(snapScenesDir, file), path.join(dir, "scenes", file));
    restored.push(id);
  }

  const after = currentSceneFingerprint(dir);
  const snapshotIds = new Set(rec.sceneIds);
  const extras = listSceneFilesAt(dir)
    .map((s) => s.sceneId)
    .filter((id) => !snapshotIds.has(id));

  // verified only when the restored set matches the baseline exactly (no extras, same hashes)
  const sameIds =
    after.sceneIds.length === rec.sceneIds.length && after.sceneIds.every((id) => snapshotIds.has(id));
  const sameHashes = rec.sceneIds.every((id) => after.sceneHashes[id] === rec.sceneHashes[id]);
  return {
    label: rec.label,
    restored: restored.sort(),
    extras,
    scenesHash: after.scenesHash,
    verified: sameIds && sameHashes && after.scenesHash === rec.scenesHash,
  };
}

/** Snapshot identity check helper (used by tests and diagnostics). */
export const snapshotMatchesState = (rec: SnapshotRecord, scenes: unknown[]): boolean =>
  rec.scenesHash === scenesFingerprint(scenes).scenesHash;
