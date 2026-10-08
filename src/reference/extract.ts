import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { stageError } from "../core/errors";

const execFileAsync = promisify(execFile);

export interface RefMetadata {
  file: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec?: string;
  frameCount: number;
}

export interface RefScene {
  index: number;
  start: number;
  end: number;
  duration: number;
  isCutStart: boolean;
}

export interface FrameRef {
  sceneIndex: number;
  role: "start" | "mid" | "end" | "before" | "after";
  time: number;
  file: string;
  textLikeRows: number;
  brightRegion: { x0: number; y0: number; x1: number; y1: number } | null;
}

export interface ColorSample {
  frame: string;
  meanLuma: number;
  background: string;
  textPrimary: string | null;
  accents: { hex: string; hue: number; share: number }[];
  topBuckets: { hex: string; share: number; luma: number }[];
}

const run = async (args: string[]): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync("ffmpeg", args, { maxBuffer: 64 * 1024 * 1024 });

export async function probeReference(file: string): Promise<RefMetadata> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames",
    "-of", "json", file,
  ]);
  const json = JSON.parse(stdout) as {
    format: { duration: string };
    streams: { codec_type: string; codec_name: string; width?: number; height?: number; avg_frame_rate?: string; nb_frames?: string }[];
  };
  const v = json.streams.find((s) => s.codec_type === "video");
  const a = json.streams.find((s) => s.codec_type === "audio");
  if (!v || !v.width || !v.height) {
    throw stageError("input", `Reference has no video stream: ${file}`, { recoverable: false });
  }
  const [num, den] = (v.avg_frame_rate ?? "30/1").split("/").map(Number);
  return {
    file,
    durationSec: parseFloat(json.format.duration),
    width: v.width,
    height: v.height,
    fps: den ? num / den : num,
    videoCodec: v.codec_name,
    audioCodec: a?.codec_name,
    frameCount: parseInt(v.nb_frames ?? "0", 10),
  };
}

/** Scene boundaries via ffmpeg scene-cut detection (deterministic, local). */
export async function detectScenes(
  file: string,
  durationSec: number,
  opts: { threshold?: number; minSceneSec?: number; maxScenes?: number } = {},
): Promise<RefScene[]> {
  const threshold = opts.threshold ?? 0.006; // this reference has smooth fades: cut scores peak ~0.01-0.03
  const minScene = opts.minSceneSec ?? 1.5;
  const maxScenes = opts.maxScenes ?? 26;
  let cuts: number[] = [];
  try {
    const { stderr } = await run([
      "-hide_banner", "-i", file,
      "-vf", `select='gt(scene,${threshold})',showinfo`,
      "-an", "-f", "null", "-",
    ]);
    cuts = [...stderr.matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  } catch {
    // ffmpeg exits non-zero on some builds when writing only to null; parse what we have
  }
  // de-dup + enforce minimum scene length
  const kept: number[] = [];
  for (const c of cuts.sort((a, b) => a - b)) {
    if (c < 0.2 || c > durationSec - 0.2) continue;
    if (kept.length === 0 || c - kept[kept.length - 1] >= minScene) kept.push(c);
  }
  // merge shortest scenes until within cap (keeps strongest structure without dropping whole video)
  let boundaries = [0, ...kept, durationSec];
  while (boundaries.length - 1 > maxScenes) {
    let minIdx = 1;
    let minLen = Infinity;
    for (let i = 1; i < boundaries.length - 1; i++) {
      const len = boundaries[i + 1] - boundaries[i - 1];
      if (len < minLen) {
        minLen = len;
        minIdx = i;
      }
    }
    boundaries.splice(minIdx, 1);
  }
  return boundaries.slice(0, -1).map((start, i) => ({
    index: i,
    start: Number(start.toFixed(3)),
    end: Number(boundaries[i + 1].toFixed(3)),
    duration: Number((boundaries[i + 1] - start).toFixed(3)),
    isCutStart: i > 0,
  }));
}

const extractJpg = async (file: string, t: number, out: string, width?: number): Promise<void> => {
  const vf = width ? `scale=${width}:-2` : "scale=1024:-2";
  await run([
    "-hide_banner", "-y", "-ss", t.toFixed(3), "-i", file,
    "-frames:v", "1", "-vf", vf, "-q:v", "3", out,
  ]);
};

const extractRaw = async (file: string, t: number, w: number, h: number, out: string): Promise<void> => {
  await run([
    "-hide_banner", "-y", "-ss", t.toFixed(3), "-i", file,
    "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-pix_fmt", "rgb24", "-f", "rawvideo", out,
  ]);
};

/* ------------------------------- color sampling ------------------------------ */

const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const rgbToHsl = (r: number, g: number, b: number): [number, number, number] => {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
    else if (max === gg) h = ((bb - rr) / d + 2) / 6;
    else h = ((rr - gg) / d + 4) / 6;
  }
  return [h * 360, s, l];
};

export function analyzeRawColors(raw: Buffer, w: number, h: number, frameName: string): ColorSample {
  const px = w * h;
  const bucket = new Map<number, { n: number; r: number; g: number; b: number }>();
  const hueBins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let sumL = 0;
  for (let i = 0; i < px; i++) {
    const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
    const L = luma(r, g, b);
    sumL += L;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const cur = bucket.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    cur.n++; cur.r += r; cur.g += g; cur.b += b;
    bucket.set(key, cur);
    const [hue, sat] = rgbToHsl(r, g, b);
    if (sat > 0.3 && L > 50 && L < 215) {
      const hb = Math.floor(hue / 30) % 12;
      const c = hueBins.get(hb) ?? { n: 0, r: 0, g: 0, b: 0 };
      c.n++; c.r += r; c.g += g; c.b += b;
      hueBins.set(hb, c);
    }
  }
  const meanLuma = sumL / px;
  const topBuckets = [...bucket.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 8)
    .map(([, c]) => ({
      hex: hex(c.r / c.n, c.g / c.n, c.b / c.n),
      share: c.n / px,
      luma: Math.round(luma(c.r / c.n, c.g / c.n, c.b / c.n)),
    }));

  // background: dominant bucket among dark pixels; fallback: overall dominant
  const darkBuckets = [...bucket.values()].filter((c) => luma(c.r / c.n, c.g / c.n, c.b / c.n) < 90);
  const bg =
    darkBuckets.length > 0
      ? darkBuckets.sort((a, b) => b.n - a.n)[0]
      : [...bucket.values()].sort((a, b) => b.n - a.n)[0];
  const background = hex(bg.r / bg.n, bg.g / bg.n, bg.b / bg.n);

  // text primary: dominant bright bucket
  const bright = [...bucket.values()].filter((c) => luma(c.r / c.n, c.g / c.n, c.b / c.n) > 170);
  let textPrimary: string | null = null;
  if (bright.length > 0) {
    const c = bright.sort((a, b) => b.n - a.n)[0];
    textPrimary = hex(c.r / c.n, c.g / c.n, c.b / c.n);
  }

  const accents = [...hueBins.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 5)
    .filter(([, c]) => c.n / px >= 0.01)
    .map(([hue, c]) => ({
      hex: hex(c.r / c.n, c.g / c.n, c.b / c.n),
      hue: hue * 30 + 15,
      share: Number((c.n / px).toFixed(4)),
    }));

  return { frame: frameName, meanLuma: Number(meanLuma.toFixed(1)), background, textPrimary, accents, topBuckets };
}

/** Heuristic text-like region detection on a tiny luma grid (low confidence by design). */
function textLikeRegions(raw: Buffer, w: number, h: number): { rows: number; bbox: FrameRef["brightRegion"] } {
  const lum: number[] = [];
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    const L = luma(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]);
    lum.push(L);
    sum += L;
  }
  const mean = sum / (w * h);
  const thr = Math.max(150, mean + 2.2 * Math.sqrt(lum.reduce((a, L) => a + (L - mean) ** 2, 0) / (w * h)));
  const rowCounts: number[] = [];
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) if (lum[y * w + x] > thr) n++;
    rowCounts.push(n);
  }
  const active = rowCounts.map((n, i) => ({ i, n })).filter((r) => r.n >= 2);
  if (active.length < 2) return { rows: 0, bbox: null };
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (const { i } of active) {
    minY = Math.min(minY, i);
    maxY = Math.max(maxY, i);
    for (let x = 0; x < w; x++) if (lum[i * w + x] > thr) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  }
  return {
    rows: active.length,
    bbox: { x0: minX / w, y0: minY / h, x1: maxX / w, y1: maxY / h },
  };
}

/* ---------------------------------- main ---------------------------------- */

export interface ExtractionResult {
  metadata: RefMetadata;
  scenes: RefScene[];
  frames: FrameRef[];
  contactSheet: string;
  colorSamples: ColorSample[];
  motion: MotionAnalysis;
}

export interface MotionAnalysis {
  globalMeanDiff: number;
  perScene: { sceneIndex: number; meanDiff: number; entryDiff: number; exitDiff: number; samples: number }[];
  method: string;
}

const MW = 64, MH = 36;

async function motionForScene(file: string, scene: RefScene, dir: string): Promise<{ stats: MotionAnalysis["perScene"][number]; seqFiles: string[] }> {
  const n = 5;
  const times: number[] = [];
  for (let i = 0; i < n; i++) times.push(scene.start + ((scene.end - scene.start) * (i + 0.5)) / n);
  const raws: Buffer[] = [];
  const seqFiles: string[] = [];
  for (let i = 0; i < n; i++) {
    const rawPath = path.join(dir, `scene_${String(scene.index).padStart(2, "0")}_${i}.rgb`);
    await extractRaw(file, times[i], MW, MH, rawPath);
    raws.push(fs.readFileSync(rawPath));
    const jpg = path.join(dir, `scene_${String(scene.index).padStart(2, "0")}_${i}.jpg`);
    await extractJpg(file, times[i], jpg, 384);
    seqFiles.push(jpg);
  }
  const diffs: number[] = [];
  for (let i = 1; i < raws.length; i++) {
    let acc = 0;
    for (let p = 0; p < MW * MH * 3; p++) acc += Math.abs(raws[i][p] - raws[i - 1][p]);
    diffs.push(acc / (MW * MH * 3 * 255));
  }
  const mean = diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length);
  return {
    stats: {
      sceneIndex: scene.index,
      meanDiff: Number(mean.toFixed(4)),
      entryDiff: Number((diffs[0] ?? 0).toFixed(4)),
      exitDiff: Number((diffs[diffs.length - 1] ?? 0).toFixed(4)),
      samples: diffs.length,
    },
    seqFiles,
  };
}

export async function runReferenceExtraction(referenceFile: string): Promise<ExtractionResult> {
  const root = path.dirname(referenceFile);
  const analysisDir = path.join(root, "analysis");
  const framesDir = path.join(analysisDir, "frames");
  const motionDir = path.join(analysisDir, "motion-samples");
  for (const d of [analysisDir, framesDir, motionDir]) fs.mkdirSync(d, { recursive: true });

  const metadata = await probeReference(referenceFile);
  fs.writeFileSync(
    path.join(analysisDir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
  );

  const scenes = await detectScenes(referenceFile, metadata.durationSec);
  fs.writeFileSync(path.join(analysisDir, "scenes.json"), JSON.stringify(scenes, null, 2));

  // representative frames: start / mid / end per scene
  const frames: FrameRef[] = [];
  const grid: { t: number; role: FrameRef["role"]; sceneIndex: number }[] = [];
  for (const s of scenes) {
    const inset = Math.min(0.2, s.duration / 4);
    const picks: { t: number; role: FrameRef["role"] }[] = [
      { t: s.start + inset, role: "start" },
      { t: s.start + s.duration / 2, role: "mid" },
      { t: s.end - inset, role: "end" },
    ];
    for (const p of picks) grid.push({ ...p, sceneIndex: s.index });
  }
  // transition-adjacent frames for up to 12 evenly spaced cuts
  const cutIdx = scenes.filter((s) => s.isCutStart).map((s) => s.index);
  const transIdx = cutIdx.filter((_, i) => i % Math.max(1, Math.ceil(cutIdx.length / 12)) === 0).slice(0, 12);
  for (const idx of transIdx) {
    const s = scenes[idx];
    grid.push({ t: Math.max(0, s.start - 0.12), role: "before", sceneIndex: idx });
    grid.push({ t: Math.min(metadata.durationSec - 0.05, s.start + 0.12), role: "after", sceneIndex: idx });
  }

  for (const g of grid) {
    const name = `scene_${String(g.sceneIndex).padStart(2, "0")}_${g.role}.jpg`;
    const file = path.join(framesDir, name);
    await extractJpg(referenceFile, g.t, file, 1024);
    // tiny sample for color + text-region heuristics
    const rawPath = path.join(framesDir, `${name}.rgb`);
    await extractRaw(referenceFile, g.t, 48, 27, rawPath);
    const raw = fs.readFileSync(rawPath);
    const regions = textLikeRegions(raw, 48, 27);
    fs.unlinkSync(rawPath);
    frames.push({
      sceneIndex: g.sceneIndex,
      role: g.role,
      time: Number(g.t.toFixed(3)),
      file: path.relative(root, file).replace(/\\/g, "/"),
      textLikeRows: regions.rows,
      brightRegion: regions.bbox,
    });
  }
  fs.writeFileSync(path.join(analysisDir, "frames-index.json"), JSON.stringify(frames, null, 2));

  // contact sheet of scene mid frames
  const mids = frames.filter((f) => f.role === "mid").slice(0, 36);
  const cols = Math.min(6, Math.max(1, mids.length));
  const rows = Math.max(1, Math.ceil(mids.length / cols));
  if (mids.length > 0) {
    const listFile = path.join(analysisDir, "mids.txt");
    fs.writeFileSync(listFile, mids.map((m) => `file '${path.basename(path.dirname(m.file))}/${path.basename(m.file)}'`).join("\n"));
    try {
      await run([
        "-hide_banner", "-y",
        "-f", "concat", "-safe", "0", "-i", listFile,
        "-vf", `scale=256:144,tile=${cols}x${rows}`,
        "-frames:v", "1", "-q:v", "4", path.join(analysisDir, "contact-sheet.jpg"),
      ]);
    } catch {
      // contact sheet is an analysis convenience - failure must not break extraction
    }
    fs.unlinkSync(listFile);
  }

  // color sampling on representative frames
  const colorSamples: ColorSample[] = [];
  for (const f of frames.filter((f) => f.role === "mid" || f.role === "start").slice(0, 30)) {
    const rawPath = path.join(analysisDir, ".tmp.rgb");
    await extractRaw(referenceFile, f.time, 48, 27, rawPath);
    const raw = fs.readFileSync(rawPath);
    fs.unlinkSync(rawPath);
    colorSamples.push(analyzeRawColors(raw, 48, 27, f.file));
  }
  fs.writeFileSync(path.join(analysisDir, "sampled-colors.json"), JSON.stringify(colorSamples, null, 2));

  // motion analysis on up to 8 scenes spread across the video
  const motionSceneIdx = [...new Set(scenes.map((s) => s.index))]
    .filter((i) => scenes[i].duration >= 0.8)
    .filter((_, i, arr) => i % Math.max(1, Math.ceil(arr.length / 8)) === 0)
    .slice(0, 8);
  const perScene: MotionAnalysis["perScene"] = [];
  const sequences: { sceneIndex: number; files: string[] }[] = [];
  for (const idx of motionSceneIdx) {
    const { stats, seqFiles } = await motionForScene(referenceFile, scenes[idx], motionDir);
    perScene.push(stats);
    sequences.push({ sceneIndex: idx, files: seqFiles.map((f) => path.relative(root, f).replace(/\\/g, "/")) });
  }
  const motion: MotionAnalysis = {
    globalMeanDiff: Number(
      (perScene.reduce((a, s) => a + s.meanDiff, 0) / Math.max(1, perScene.length)).toFixed(4),
    ),
    perScene,
    method: "mean abs RGB diff on 5 evenly spaced frames per scene, 64x36 downscale (deterministic)",
  };
  fs.writeFileSync(
    path.join(analysisDir, "motion-samples", "analysis.json"),
    JSON.stringify({ motion, sequences }, null, 2),
  );

  const contactSheet = path.join(analysisDir, "contact-sheet.jpg");
  return { metadata, scenes, frames, contactSheet: fs.existsSync(contactSheet) ? contactSheet : "", colorSamples, motion };
}
