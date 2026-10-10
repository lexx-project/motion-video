import crypto from "crypto";
import fs from "fs";

/**
 * Artifact identity (Batch A / A4).
 *
 * Every meaningful artifact in a project gets a deterministic fingerprint so later stages can
 * answer "which scene state produced this video?", "which QA result belongs to it?" and
 * "did anything change after QA?" without relying on filenames or timestamps.
 *
 * Rules:
 * - identity = sha256 of content, never of path or mtime;
 * - hashing is CANONICAL (sorted keys, stable number/string formatting) so the same logical
 *   value hashes identically regardless of JSON formatting or key order;
 * - node-only (crypto/fs) - never import from render-bundle code.
 */

/** Stable JSON: object keys sorted recursively so formatting/key-order never changes a hash. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src).sort()) {
        const item = src[key];
        if (item === undefined) continue;
        out[key] = walk(item);
      }
      return out;
    }
    if (typeof v === "number" && !Number.isFinite(v)) return String(v);
    return v;
  };
  return JSON.stringify(walk(value));
}

export const sha256 = (input: string | Buffer): string =>
  crypto.createHash("sha256").update(input).digest("hex");

export const sha256Json = (value: unknown): string => sha256(canonicalJson(value));

export interface FileFingerprint {
  file: string;
  sha256: string;
  sizeBytes: number;
}

/** Content fingerprint of a file on disk. Returns null when the file does not exist. */
export function fingerprintFile(file: string): FileFingerprint | null {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  if (!stat.isFile()) return null;
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let bytes = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      bytes = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytes <= 0) break;
      hash.update(buf.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { file, sha256: hash.digest("hex"), sizeBytes: stat.size };
}

export const sha256File = (file: string): string | null => fingerprintFile(file)?.sha256 ?? null;

/** Hard variant: throws when the file is missing (for call sites where absence is a bug). */
export function requireFingerprint(file: string): FileFingerprint {
  const fp = fingerprintFile(file);
  if (!fp) throw new Error(`artifact missing: ${file}`);
  return fp;
}

export interface SceneFingerprint {
  scenesHash: string;
  sceneIds: string[];
  /** per-scene canonical hash, keyed by sceneId - used by change detection / snapshots */
  sceneHashes: Record<string, string>;
}

/** Identity of a scene state (the JSON that produces a render). */
export function scenesFingerprint(scenes: unknown[]): SceneFingerprint {
  const sceneHashes: Record<string, string> = {};
  const sceneIds: string[] = [];
  for (const s of scenes) {
    const id = (s as { sceneId?: unknown } | null)?.sceneId;
    const key = typeof id === "string" && id.length > 0 ? id : `anon_${sceneIds.length}`;
    sceneIds.push(key);
    sceneHashes[key] = sha256Json(s);
  }
  const scenesHash = sha256Json(scenes.map((s) => sha256Json(s)));
  return { scenesHash, sceneIds, sceneHashes };
}

/** Short, human-usable prefix (never used as the identity itself). */
export const shortHash = (hash: string, len = 12): string => hash.slice(0, len);
