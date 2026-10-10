import fs from "fs";
import path from "path";
import { PATHS } from "./config";
import { stageError, StudioError } from "./errors";

export type ProjectStatus =
  | "created"
  | "analyzing"
  | "directing"
  | "generating"
  | "validating"
  | "rendering"
  | "qa"
  | "repairing"
  | "complete"
  | "failed";

export interface StageRecord {
  status: "pending" | "running" | "done" | "failed";
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface Manifest {
  projectId: string;
  createdAt: string;
  updatedAt: string;
  status: ProjectStatus;
  title?: string;
  scriptPreview: string;
  hasAudio: boolean;
  audioDurationSec?: number;
  timingSource?: "word" | "phrase" | "silence" | "proportional" | "estimated" | "provided";
  sceneIds: string[];
  stages: Record<string, StageRecord>;
  lastError?: string;
}

export interface MemoryEntry {
  projectId: string;
  sceneId: string;
  visualConcept: string;
  metaphor: string;
  composition: string;
  dominantObjects: string[];
  primitiveCombination: string[];
  motionPattern: string;
  semanticPurpose: string;
  /** Phase 3: visual mechanism used (storyboard taxonomy) for mechanism-frequency novelty. */
  visualMechanism?: string;
}

const ensure = (dir: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

export const projectDir = (projectId: string): string =>
  path.join(PATHS.projects, projectId);

const sub = (projectId: string, name: string): string =>
  ensure(path.join(projectDir(projectId), name));

export function initProject(projectId: string, script: string, title?: string): Manifest {
  sub(projectId, "input");
  sub(projectId, "analysis");
  sub(projectId, "concepts");
  sub(projectId, "scenes");
  sub(projectId, "qa");
  sub(projectId, "renders");
  const now = new Date().toISOString();
  const manifest: Manifest = {
    projectId,
    createdAt: now,
    updatedAt: now,
    status: "created",
    title,
    scriptPreview: script.slice(0, 240),
    hasAudio: false,
    sceneIds: [],
    stages: {},
  };
  writeJson(projectId, "manifest.json", manifest);
  writeText(projectId, path.join("input", "script.md"), script);
  return manifest;
}

export function readManifest(projectId: string): Manifest {
  const p = path.join(projectDir(projectId), "manifest.json");
  if (!fs.existsSync(p)) {
    throw stageError("input", `Project not found: ${projectId}`, { projectId });
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as Manifest;
}

export function updateManifest(
  projectId: string,
  patch: Partial<Manifest>,
): Manifest {
  const m = readManifest(projectId);
  const next: Manifest = { ...m, ...patch, updatedAt: new Date().toISOString() };
  writeJson(projectId, "manifest.json", next);
  return next;
}

export function markStage(
  projectId: string,
  stage: string,
  status: StageRecord["status"],
  error?: string,
): void {
  const m = readManifest(projectId);
  const rec = m.stages[stage] ?? { status: "pending" };
  if (status === "running") {
    rec.startedAt = new Date().toISOString();
    rec.status = "running";
    delete rec.finishedAt;
    delete rec.error;
  } else if (status === "done" || status === "failed") {
    rec.finishedAt = new Date().toISOString();
    rec.status = status;
    if (error) rec.error = error;
  } else {
    rec.status = status;
  }
  m.stages[stage] = rec;
  m.updatedAt = new Date().toISOString();
  writeJson(projectId, "manifest.json", m);
}

export function writeJson(projectId: string, relPath: string, data: unknown): string {
  return writeJsonAt(projectDir(projectId), relPath, data);
}

/** Directory-based JSON write (used by Batch A modules that take an explicit project dir). */
export function writeJsonAt(dir: string, relPath: string, data: unknown): string {
  const target = path.join(dir, relPath);
  ensure(path.dirname(target));
  fs.writeFileSync(target, JSON.stringify(data, null, 2), "utf8");
  return target;
}

export function readJson<T>(projectId: string, relPath: string): T | null {
  return readJsonAt<T>(projectDir(projectId), relPath);
}

/** Directory-based JSON read (mirror of writeJsonAt). */
export function readJsonAt<T>(dir: string, relPath: string): T | null {
  const target = path.join(dir, relPath);
  if (!fs.existsSync(target)) return null;
  try {
    return JSON.parse(fs.readFileSync(target, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeText(projectId: string, relPath: string, text: string): string {
  const target = path.join(projectDir(projectId), relPath);
  ensure(path.dirname(target));
  fs.writeFileSync(target, text, "utf8");
  return target;
}

export function listProjects(): Manifest[] {
  if (!fs.existsSync(PATHS.projects)) return [];
  return fs
    .readdirSync(PATHS.projects)
    .filter((d) => d !== "_memory" && fs.existsSync(path.join(PATHS.projects, d, "manifest.json")))
    .map((d) => {
      try {
        return readManifest(d);
      } catch {
        return null;
      }
    })
    .filter((m): m is Manifest => m !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function listScenes(projectId: string): { sceneId: string; file: string; data: unknown }[] {
  return listSceneFilesAt(projectDir(projectId));
}

/** Directory-based scene listing (mirror of listScenes). */
export function listSceneFilesAt(dir: string): { sceneId: string; file: string; data: unknown }[] {
  const scenesDir = path.join(dir, "scenes");
  if (!fs.existsSync(scenesDir)) return [];
  return fs
    .readdirSync(scenesDir)
    .filter((f) => /^scene_\d+\.json$/.test(f))
    .sort()
    .map((f) => {
      const file = path.join(scenesDir, f);
      try {
        return { sceneId: f.replace(/\.json$/, ""), file, data: JSON.parse(fs.readFileSync(file, "utf8")) };
      } catch {
        return null;
      }
    })
    .filter((x): x is { sceneId: string; file: string; data: unknown } => x !== null);
}

/** Project memory used by the Novelty Checker (MASTER_SPEC section 10/13). Re-committing the
 *  same scene replaces the old entry instead of duplicating it. */
export function appendMemory(entry: MemoryEntry): void {
  ensure(PATHS.memory);
  const file = path.join(PATHS.memory, "history.json");
  const history: MemoryEntry[] = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : [];
  const next = history.filter(
    (h) => !(h.projectId === entry.projectId && h.sceneId === entry.sceneId),
  );
  next.push(entry);
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  const idxFile = path.join(PATHS.memory, "projects.json");
  const idx: { projectId: string; updatedAt: string }[] = fs.existsSync(idxFile)
    ? JSON.parse(fs.readFileSync(idxFile, "utf8"))
    : [];
  if (!idx.some((p) => p.projectId === entry.projectId)) {
    idx.push({ projectId: entry.projectId, updatedAt: new Date().toISOString() });
    fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2), "utf8");
  }
}

export function readGlobalMemory(): MemoryEntry[] {
  const file = path.join(PATHS.memory, "history.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")) as MemoryEntry[];
}

export function wrapUnknown(e: unknown, stage: StudioError["stage"], projectId?: string): StudioError {
  // StudioError instances pass through unchanged, so structured outcomes
  // (budget exhaustion, duplicate-prompt refusal) survive stage wrapping.
  if (e instanceof StudioError) return e;
  return stageError(stage, e instanceof Error ? e.message : String(e), {
    projectId,
    recoverable: false,
  });
}
