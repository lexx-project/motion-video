import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition, ensureBrowser, renderStill } from "@remotion/renderer";
import { OUTPUT } from "../core/output";
import { stageError } from "../core/errors";
import type { SceneSpec } from "../validation/schema";

const execFileAsync = promisify(execFile);

const entry = path.join(process.cwd(), "src", "index.ts");
const outDir = path.join(process.cwd(), "out");

let bundleCache: { serveUrl: string; key: string } | null = null;

/**
 * Newest mtime under src/ + design-system/ + public/ (bundle must rebuild when the
 * renderer changes OR when a project's VO/static asset is added - public/ assets are
 * snapshotted into the bundle at creation time, so a stale cache = 404 on voice files).
 */
function sourceRevision(): string {
  let latest = 0;
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const m = fs.statSync(p).mtimeMs;
        if (m > latest) latest = m;
      }
    }
  };
  walk(path.join(process.cwd(), "src"));
  walk(path.join(process.cwd(), "design-system"));
  walk(path.join(process.cwd(), "public"));
  return String(latest);
}

export async function getBundle(): Promise<string> {
  const key = sourceRevision();
  if (bundleCache && bundleCache.key === key) return bundleCache.serveUrl;
  const serveUrl = await bundle({
    entryPoint: entry,
    publicDir: path.join(process.cwd(), "public"),
    onProgress: () => {},
  });
  bundleCache = { serveUrl, key };
  return serveUrl;
}

/**
 * Safety net: if a render/still fails because a file under /public/ 404s (asset was
 * copied into public/ after this process's bundle snapshot), invalidate the cache and
 * retry exactly once with a fresh bundle.
 */
async function withStaleBundleRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (bundleCache && /404/.test(msg) && /\/public\//.test(msg)) {
      bundleCache = null;
      return await fn();
    }
    throw e;
  }
}

export interface RenderOptions {
  scenes: SceneSpec[];
  audioPath?: string;
  outputName: string;
  onProgress?: (progress: number) => void;
  /** Batch E / Phase 4: isolated-object render (per-object pixel evidence) */
  isolateSemanticId?: string;
}

/** Programmatic render: 1080x1920 @30fps, H.264 + AAC (OUTPUT is the single source). */
export async function renderProject(opts: RenderOptions): Promise<string> {
  return withStaleBundleRetry(async () => {
    await ensureBrowser();
    const serveUrl = await getBundle();
    const inputProps = {
      scenes: opts.scenes,
      audioPath: opts.audioPath,
      ...(opts.isolateSemanticId ? { isolateSemanticId: opts.isolateSemanticId } : {}),
    };
    const composition = await selectComposition({
      serveUrl,
      id: "Project",
      inputProps,
    });
    fs.mkdirSync(outDir, { recursive: true });
    const outputLocation = path.join(outDir, opts.outputName);
    await renderMedia({
      composition,
      serveUrl,
      codec: OUTPUT.videoCodec,
      audioCodec: OUTPUT.audioCodec,
      outputLocation,
      inputProps,
      onProgress: ({ progress }) => opts.onProgress?.(progress),
      timeoutInMilliseconds: 180000,
    });
    return outputLocation;
  });
}

export type StillRenderer = (frame: number, output: string) => Promise<void>;

/**
 * One bundle + one composition, N stills. Shared by the judge-frame extractor (below) and the
 * frame-evidence collector so both render from the exact same inputProps (Batch A / A1).
 */
export async function createStillRenderer(
  scenes: SceneSpec[],
  audioPath?: string,
  opts: { isolateSemanticId?: string } = {},
): Promise<StillRenderer> {
  await ensureBrowser();
  const serveUrl = await getBundle();
  const inputProps = {
    scenes,
    audioPath,
    ...(opts.isolateSemanticId ? { isolateSemanticId: opts.isolateSemanticId } : {}),
  };
  const composition = await selectComposition({ serveUrl, id: "Project", inputProps });
  return async (frame: number, output: string): Promise<void> => {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await renderStill({
      composition,
      serveUrl,
      output,
      frame,
      inputProps,
      timeoutInMilliseconds: 120000,
    });
  };
}

/** Extract one representative still per scene (used by Vision QA / Slop Critic). */
export async function extractSceneFrames(
  scenes: SceneSpec[],
  audioPath: string | undefined,
  targetDir: string,
  prefix = "frame",
): Promise<{ sceneId: string; file: string; atSec: number }[]> {
  fs.mkdirSync(targetDir, { recursive: true });
  return withStaleBundleRetry(async () => {
    const renderStillAt = await createStillRenderer(scenes, audioPath);
    const results: { sceneId: string; file: string; atSec: number }[] = [];
    let cursor = 0;
    for (const scene of scenes) {
      const mid = cursor + scene.duration * 0.55;
      cursor += scene.duration;
      const file = path.join(targetDir, `${prefix}_${scene.sceneId}.png`);
      await renderStillAt(Math.round(mid * OUTPUT.fps), file);
      results.push({ sceneId: scene.sceneId, file, atSec: mid });
    }
    return results;
  });
}

export interface TechnicalQaResult {
  file: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec?: string;
  errors: string[];
}

/** Technical QA: ffprobe ground truth vs expected output config (MASTER_SPEC 11). */
export async function probeRender(file: string, expectedDurationSec: number): Promise<TechnicalQaResult> {
  const errors: string[] = [];
  if (!fs.existsSync(file)) {
    return {
      file,
      durationSec: 0,
      width: 0,
      height: 0,
      fps: 0,
      hasAudio: false,
      videoCodec: "",
      errors: ["render output missing"],
    };
  }
  const run = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", ...args, file]);
    return stdout.replace(/\r/g, "").trim();
  };
  let durationSec = 0;
  let width = 0;
  let height = 0;
  let fps = 0;
  let videoCodec = "";
  let audioCodec: string | undefined;
  let hasAudio = false;
  try {
    durationSec = parseFloat(await run(["-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1"]));
    const v = await run([
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate,codec_name",
      "-of",
      "default=noprint_wrappers=1",
    ]);
    const get = (key: string): string => v.split("\n").find((l) => l.startsWith(`${key}=`))?.split("=")[1] ?? "";
    width = parseInt(get("width"), 10);
    height = parseInt(get("height"), 10);
    videoCodec = get("codec_name");
    const [num, den] = get("avg_frame_rate").split("/").map(Number);
    fps = den ? num / den : num;
    try {
      const a = await run([
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name",
        "-of",
        "default=noprint_wrappers=1",
      ]);
      audioCodec = a.replace("codec_name=", "");
      hasAudio = Boolean(audioCodec);
    } catch {
      hasAudio = false;
    }
  } catch (e) {
    errors.push(`ffprobe failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (width !== OUTPUT.width || height !== OUTPUT.height)
    errors.push(`dimensions ${width}x${height} != ${OUTPUT.width}x${OUTPUT.height}`);
  if (Math.abs(fps - OUTPUT.fps) > 0.05) errors.push(`fps ${fps} != ${OUTPUT.fps}`);
  if (Math.abs(durationSec - expectedDurationSec) > 1.2)
    errors.push(`duration ${durationSec.toFixed(2)}s != expected ${expectedDurationSec.toFixed(2)}s`);
  if (videoCodec !== "h264") errors.push(`video codec ${videoCodec} != h264`);

  return { file, durationSec, width, height, fps, hasAudio, videoCodec, audioCodec, errors };
}
