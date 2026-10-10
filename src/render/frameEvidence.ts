import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { createStillRenderer, type StillRenderer } from "./renderProject";
import { OUTPUT } from "../core/output";
import { safeAreaRect, subtitleBandRect } from "../scenes/bounds";
import type { SceneSpec } from "../validation/schema";

const execFileAsync = promisify(execFile);

export { createStillRenderer };
export type { StillRenderer };

/**
 * Deterministic frame evidence (Batch A / A1 + A2).
 *
 * A1: a small fixed set of diagnostic frames per scene (early / middle / late, plus extra
 *     samples on known motion events when the scene has room) - never a dataset dump.
 * A2: deterministic pixel metrics per sampled frame - occupancy, edge ink, content bounds,
 *     caption-band occupancy, bright/accent share, frame-to-frame motion delta.
 *
 * These metrics are EVIDENCE for later deterministic gates. They do not understand semantics
 * and must never be presented as a substitute for visual judgment.
 *
 * Node-only (child_process / fs / @remotion/renderer). Never import from render-bundle code.
 */

/* ------------------------------- A1: sampling ------------------------------- */

export type SampleReason = "early" | "mid" | "late" | "motion";

export interface FrameSample {
  index: number;
  /** seconds relative to scene start */
  timeSec: number;
  /** frame index relative to scene start */
  frame: number;
  reason: SampleReason;
}

export interface ProjectSample extends FrameSample {
  sceneId: string;
  sceneStartFrame: number;
  /** absolute frame within the project timeline (matches <Sequence from=...>) */
  absoluteFrame: number;
}

export const BASE_SAMPLE_PLAN: { fraction: number; reason: SampleReason }[] = [
  { fraction: 0.15, reason: "early" },
  { fraction: 0.5, reason: "mid" },
  { fraction: 0.85, reason: "late" },
];

/** Cap keeps evidence cheap: QA evidence, not dataset generation. */
export const MAX_SAMPLES_PER_SCENE = 6;
/** Two samples closer than this cannot tell anything apart. */
export const MIN_SAMPLE_GAP_SEC = 0.12;

const clampFrame = (frame: number, durationFrames: number): number =>
  Math.max(0, Math.min(Math.max(0, durationFrames - 1), frame));

/**
 * Deterministic sample plan for one scene (pure function of scene JSON + fps).
 * Always includes early/mid/late; adds motion-event samples only when there is budget.
 */
export function planFrameSamples(scene: SceneSpec, fps: number = OUTPUT.fps): FrameSample[] {
  const duration = Math.max(0.1, Number(scene.duration) || 0.1);
  const durationFrames = Math.max(1, Math.round(duration * fps));
  const picked: { timeSec: number; reason: SampleReason }[] = [];

  const add = (timeSec: number, reason: SampleReason): void => {
    if (!Number.isFinite(timeSec)) return;
    const t = Math.max(0, Math.min(duration, timeSec));
    const frame = clampFrame(Math.round(t * fps), durationFrames);
    if (picked.some((p) => Math.abs(Math.round(p.timeSec * fps) - frame) < 1)) return;
    if (picked.some((p) => Math.abs(p.timeSec - t) < MIN_SAMPLE_GAP_SEC)) return;
    picked.push({ timeSec: t, reason });
  };

  // base plan first so early/mid/late are never evicted
  for (const p of BASE_SAMPLE_PLAN) add(duration * p.fraction, p.reason);

  // known motion events, in scene order, budget-limited
  if (picked.length < MAX_SAMPLES_PER_SCENE) {
    const events: number[] = [];
    if (typeof scene.timing?.emphasisAt === "number") events.push(scene.timing.emphasisAt);
    if (typeof scene.timing?.exitAt === "number") events.push(scene.timing.exitAt);
    for (const el of scene.elements ?? []) {
      if (typeof el.delay === "number") events.push(el.delay);
      if (typeof el.emphasisAt === "number") events.push(el.emphasisAt);
    }
    for (const t of [...new Set(events)].sort((a, b) => a - b)) {
      if (picked.length >= MAX_SAMPLES_PER_SCENE) break;
      if (t <= 0 || t >= duration) continue;
      add(t, "motion");
    }
  }

  const sorted = picked.sort((a, b) => a.timeSec - b.timeSec || a.reason.localeCompare(b.reason));
  return sorted.map((p, i) => ({
    index: i,
    timeSec: Number(p.timeSec.toFixed(4)),
    frame: clampFrame(Math.round(p.timeSec * fps), durationFrames),
    reason: p.reason,
  }));
}

/** Absolute sample plan for a whole project, mirroring ProjectRenderer's Sequence offsets. */
export function planProjectSamples(
  scenes: SceneSpec[],
  fps: number = OUTPUT.fps,
): ProjectSample[] {
  const out: ProjectSample[] = [];
  let startFrame = 0;
  for (const scene of scenes) {
    const durationFrames = Math.max(1, Math.round(scene.duration * fps));
    for (const s of planFrameSamples(scene, fps)) {
      out.push({
        ...s,
        sceneId: scene.sceneId,
        sceneStartFrame: startFrame,
        absoluteFrame: startFrame + s.frame,
      });
    }
    startFrame += durationFrames;
  }
  return out;
}

/* ------------------------------- A2: metrics -------------------------------- */

/** Analysis canvas: half resolution keeps metrics cheap and stable. */
export const ANALYSIS_WIDTH = 540;
/** Edge band expressed in FULL-RES px. */
export const EDGE_BAND_FULL_PX = 12;
/** A pixel counts as "ink" when it differs from the modal background by more than this (0-255). */
export const INK_DELTA = 24;

export interface RectPx {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface EdgeOverflowPx {
  left: number;
  top: number;
  right: number;
  bottom: number;
  outside: boolean;
}

export interface FrameMetrics {
  width: number;
  height: number;
  analysisWidth: number;
  analysisHeight: number;
  /** analysis px per full-res px */
  scale: number;
  background: string;
  /** non-background share 0..1 */
  occupancy: number;
  /** bright (luma > 120) share 0..1 */
  brightShare: number;
  /** saturated accent share 0..1 */
  accentShare: number;
  meanLuma: number;
  /** ink pixels inside the edge band, in analysis px */
  edgeInk: { left: number; right: number; top: number; bottom: number };
  edgeBandAnalysisPx: number;
  /** content bounding box in FULL-RES px; null when the frame carries no ink */
  contentBox: RectPx | null;
  /** how far the content box crosses the design-system safe area (FULL-RES px) */
  safeAreaOverflow: EdgeOverflowPx;
  /** true when content reaches the very frame edge (clipping evidence) */
  contentOutsideFrame: boolean;
  regionOccupancy: { top: number; middle: number; bottom: number; subtitleBand: number };
}

const PNG_DIMENSIONS = (file: string): { width: number; height: number } | null => {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const header = Buffer.alloc(24);
      if (fs.readSync(fd, header, 0, 24, 0) < 24) return null;
      const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      for (let i = 0; i < sig.length; i++) if (header[i] !== sig[i]) return null;
      const width = header.readUInt32BE(16);
      const height = header.readUInt32BE(20);
      if (!width || !height) return null;
      return { width, height };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
};

async function rawRgb(file: string, width: number, height: number): Promise<Buffer> {
  const tmp = `${file}.${width}x${height}.rgb`;
  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", file,
      "-frames:v", "1",
      "-vf", `scale=${width}:${height}`,
      "-f", "rawvideo", "-pix_fmt", "rgb24",
      tmp,
    ]);
    return fs.readFileSync(tmp);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

interface PixelScan {
  width: number;
  height: number;
  count: number;
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
}

function scan(buf: Buffer, width: number, height: number): PixelScan {
  const count = width * height;
  const r = new Uint8Array(count), g = new Uint8Array(count), b = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    r[i] = buf[i * 3];
    g[i] = buf[i * 3 + 1];
    b[i] = buf[i * 3 + 2];
  }
  return { width, height, count, r, g, b };
}

/** Modal background colour from dark pixels (same bucketing idea as conformance.frameStats). */
function detectBackground(px: PixelScan): string {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < px.count; i++) {
    const r = px.r[i], g = px.g[i], b = px.b[i];
    if (luma(r, g, b) > 100) continue;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const c = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    c.n++; c.r += r; c.g += g; c.b += b;
    buckets.set(key, c);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const c of buckets.values()) if (!best || c.n > best.n) best = c;
  if (!best || best.n === 0) return "#000000";
  const hex = (v: number): string => Math.round(v).toString(16).padStart(2, "0");
  return `#${hex(best.r / best.n)}${hex(best.g / best.n)}${hex(best.b / best.n)}`;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
};

/**
 * Deterministic metrics for one rendered frame. Returns null only when decode fails.
 * Same file => same metrics (no timestamps, no randomness).
 */
export async function analyzeFrame(file: string): Promise<FrameMetrics | null> {
  if (!fs.existsSync(file)) return null;
  const dims = PNG_DIMENSIONS(file) ?? { width: OUTPUT.width, height: OUTPUT.height };
  const analysisWidth = Math.min(ANALYSIS_WIDTH, dims.width);
  const analysisHeight = Math.max(1, Math.round((dims.height * analysisWidth) / dims.width));
  let buf: Buffer;
  try {
    buf = await rawRgb(file, analysisWidth, analysisHeight);
  } catch {
    return null;
  }
  if (buf.length < analysisWidth * analysisHeight * 3) return null;

  const px = scan(buf, analysisWidth, analysisHeight);
  const scale = analysisWidth / dims.width;
  const band = Math.max(1, Math.round(EDGE_BAND_FULL_PX * scale));

  const background = detectBackground(px);
  const [br, bg, bb] = hexToRgb(background);

  const bandRect = subtitleBandRect("render", dims);
  const by0 = Math.max(0, Math.floor(bandRect.y0 * scale));
  const by1 = Math.min(analysisHeight, Math.ceil(bandRect.y1 * scale));
  const bx0 = Math.max(0, Math.floor(bandRect.x0 * scale));
  const bx1 = Math.min(analysisWidth, Math.ceil(bandRect.x1 * scale));

  let ink = 0, bright = 0, accent = 0, lumaSum = 0;
  let minX = analysisWidth, minY = analysisHeight, maxX = -1, maxY = -1;
  let edgeL = 0, edgeR = 0, edgeT = 0, edgeB = 0;
  let bandInk = 0, bandCells = 0;
  let topInk = 0, midInk = 0, botInk = 0;
  const topCut = Math.floor(analysisHeight * 0.35);
  const midCut = Math.floor(analysisHeight * 0.75);
  const topCells = topCut * analysisWidth;
  const midCells = (midCut - topCut) * analysisWidth;
  const botCells = (analysisHeight - midCut) * analysisWidth;

  for (let y = 0; y < analysisHeight; y++) {
    const region = y < topCut ? 0 : y < midCut ? 1 : 2;
    const inBandY = y >= by0 && y < by1;
    for (let x = 0; x < analysisWidth; x++) {
      const i = y * analysisWidth + x;
      const r = px.r[i], g = px.g[i], b = px.b[i];
      const L = luma(r, g, b);
      lumaSum += L;
      const delta = Math.max(Math.abs(r - br), Math.abs(g - bg), Math.abs(b - bb));
      if (delta > INK_DELTA) {
        ink++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (region === 0) topInk++;
        else if (region === 1) midInk++;
        else botInk++;
        if (x < band) edgeL++;
        else if (x >= analysisWidth - band) edgeR++;
        if (y < band) edgeT++;
        else if (y >= analysisHeight - band) edgeB++;
        if (inBandY && x >= bx0 && x < bx1) bandInk++;
      }
      if (L > 120) bright++;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      if (sat > 0.3 && L > 50 && L < 230) accent++;
      if (inBandY && x >= bx0 && x < bx1) bandCells++;
    }
  }

  const total = px.count;
  const contentBox: RectPx | null =
    maxX >= 0
      ? {
          x0: Math.round(minX / scale),
          y0: Math.round(minY / scale),
          x1: Math.round((maxX + 1) / scale),
          y1: Math.round((maxY + 1) / scale),
        }
      : null;

  const sa = safeAreaRect(dims);
  const safe: EdgeOverflowPx = contentBox
    ? (() => {
        const left = Math.max(0, sa.x0 - contentBox.x0);
        const top = Math.max(0, sa.y0 - contentBox.y0);
        const right = Math.max(0, contentBox.x1 - sa.x1);
        const bottom = Math.max(0, contentBox.y1 - sa.y1);
        return {
          left: Math.round(left),
          top: Math.round(top),
          right: Math.round(right),
          bottom: Math.round(bottom),
          outside: left + top + right + bottom > 0.5,
        };
      })()
    : { left: 0, top: 0, right: 0, bottom: 0, outside: false };

  const contentOutsideFrame = contentBox
    ? contentBox.x0 <= 0 || contentBox.y0 <= 0 || contentBox.x1 >= dims.width || contentBox.y1 >= dims.height
    : false;

  return {
    width: dims.width,
    height: dims.height,
    analysisWidth,
    analysisHeight,
    scale: Number(scale.toFixed(6)),
    background,
    occupancy: round4(ink / total),
    brightShare: round4(bright / total),
    accentShare: round4(accent / total),
    meanLuma: Number((lumaSum / total).toFixed(2)),
    edgeInk: { left: edgeL, right: edgeR, top: edgeT, bottom: edgeB },
    edgeBandAnalysisPx: band,
    contentBox,
    safeAreaOverflow: safe,
    contentOutsideFrame,
    regionOccupancy: {
      top: round4(topCells ? topInk / topCells : 0),
      middle: round4(midCells ? midInk / midCells : 0),
      bottom: round4(botCells ? botInk / botCells : 0),
      subtitleBand: round4(bandCells ? bandInk / bandCells : 0),
    },
  };
}

/** Mean absolute pixel difference between two frames (0 = identical, 1 = opposite). */
export async function frameDiff(fileA: string, fileB: string): Promise<number | null> {
  try {
    const a = await rawRgb(fileA, 270, 480);
    const b = await rawRgb(fileB, 270, 480);
    if (a.length !== b.length || a.length === 0) return null;
    let acc = 0;
    for (let i = 0; i < a.length; i++) acc += Math.abs(a[i] - b[i]);
    return Number((acc / (a.length * 255)).toFixed(6));
  } catch {
    return null;
  }
}

/* ------------------------- evidence report assembly -------------------------- */

export interface FrameEvidenceSample {
  sceneId: string;
  sampleIndex: number;
  reason: SampleReason;
  timeSec: number;
  sceneFrame: number;
  absoluteFrame: number;
  /** path relative to the project directory (portable) */
  file: string;
  sha256: string | null;
  metrics: FrameMetrics | null;
}

export interface SceneEvidenceRollup {
  sceneId: string;
  sampleCount: number;
  minOccupancy: number | null;
  maxEdgeInk: number | null;
  maxSafeAreaOverflowPx: number | null;
  contentOutsideFrame: boolean;
  /** mean abs frame diff across consecutive samples; null when fewer than 2 decoded samples */
  motionDelta: number | null;
}

export interface FrameEvidenceReport {
  schema: "frame-evidence/1";
  label: string;
  generatedAt: string;
  fps: number;
  sourceRender: { file: string; sha256: string | null } | null;
  scenesHash: string | null;
  samples: FrameEvidenceSample[];
  sceneRollup: SceneEvidenceRollup[];
}

/**
 * Attach metrics (and per-scene motion deltas) to already-extracted samples.
 * `resolve` maps a relative sample path back to an absolute path on disk.
 */
export async function buildFrameEvidence(opts: {
  label: string;
  fps?: number;
  samples: Omit<FrameEvidenceSample, "metrics" | "sha256">[];
  resolve: (relFile: string) => string;
  sourceRender?: { file: string; sha256: string | null } | null;
  scenesHash?: string | null;
  generatedAt?: string;
}): Promise<FrameEvidenceReport> {
  const fps = opts.fps ?? OUTPUT.fps;
  const samples: FrameEvidenceSample[] = [];
  for (const s of opts.samples) {
    const abs = opts.resolve(s.file);
    const metrics = await analyzeFrame(abs);
    const sha = fs.existsSync(abs) ? shaOf(abs) : null;
    samples.push({ ...s, sha256: sha, metrics });
  }

  const sceneIds = [...new Set(samples.map((s) => s.sceneId))];
  const sceneRollup: SceneEvidenceRollup[] = [];
  for (const sceneId of sceneIds) {
    const mine = samples.filter((s) => s.sceneId === sceneId);
    const decoded = mine.filter((m) => m.metrics !== null);
    const metrics = decoded.map((m) => m.metrics as FrameMetrics);
    const occupancies = metrics.map((m) => m.occupancy);
    const edge = metrics.map((m) =>
      Math.max(m.edgeInk.left, m.edgeInk.right, m.edgeInk.top, m.edgeInk.bottom),
    );
    const safe = metrics.map((m) =>
      Math.max(m.safeAreaOverflow.left, m.safeAreaOverflow.top, m.safeAreaOverflow.right, m.safeAreaOverflow.bottom),
    );
    let motionDelta: number | null = null;
    if (decoded.length >= 2) {
      const deltas: number[] = [];
      for (let i = 1; i < decoded.length; i++) {
        const d = await frameDiff(opts.resolve(decoded[i - 1].file), opts.resolve(decoded[i].file));
        if (d !== null) deltas.push(d);
      }
      motionDelta = deltas.length
        ? Number((deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(6))
        : null;
    }
    sceneRollup.push({
      sceneId,
      sampleCount: mine.length,
      minOccupancy: occupancies.length ? Math.min(...occupancies) : null,
      maxEdgeInk: edge.length ? Math.max(...edge) : null,
      maxSafeAreaOverflowPx: safe.length ? Math.max(...safe) : null,
      contentOutsideFrame: metrics.some((m) => m.contentOutsideFrame),
      motionDelta,
    });
  }

  return {
    schema: "frame-evidence/1",
    label: opts.label,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    fps,
    sourceRender: opts.sourceRender ?? null,
    scenesHash: opts.scenesHash ?? null,
    samples,
    sceneRollup,
  };
}

const shaOf = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
