import { composition } from "../core/designSystem";
import { OUTPUT } from "../core/output";

/**
 * Unified frame / safe-area / caption-band geometry (Batch A / A3).
 *
 * This is the single source of truth for "where is the frame edge", "where is the safe area"
 * and "where does the caption band live". Both the deterministic layout evidence and the
 * rendered-frame metrics read from here, so the validator and the renderer can no longer drift
 * apart silently.
 *
 * IMPORTANT: these are EVIDENCE helpers (Batch A). They report violations; they do not gate.
 * The hard layout gate is Batch B - do not add validation failures here.
 */

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Canvas {
  width: number;
  height: number;
}

export const FRAME: Canvas = { width: OUTPUT.width, height: OUTPUT.height };

export const frameRect = (canvas: Canvas = FRAME): Rect => ({
  x0: 0,
  y0: 0,
  x1: canvas.width,
  y1: canvas.height,
});

/** Safe area from design-system tokens (marginX / marginTop / marginTop-bottom percentages). */
export function safeAreaRect(canvas: Canvas = FRAME): Rect {
  const sa = composition.safeArea;
  return {
    x0: (sa.marginXPercent / 100) * canvas.width,
    y0: (sa.marginTopPercent / 100) * canvas.height,
    x1: canvas.width - (sa.marginXPercent / 100) * canvas.width,
    y1: canvas.height - (sa.marginBottomPercent / 100) * canvas.height,
  };
}

/**
 * Geometry of the rendered caption band.
 *
 * `render` mirrors `SubtitleBand` in src/scenes/SceneRenderer.tsx exactly (left/right 8%,
 * bottom 14.5%, up to 2 lines of 34px text at line-height 1.3 + padding).
 * `validate` is the band the collision model has always used (7% side margins) - it is
 * deliberately 1% WIDER than the rendered band on each side and must stay that way:
 * narrowing it would silently lower an existing threshold.
 */
export const SUBTITLE_BAND = {
  render: { leftPct: 8, rightPct: 8, bottomPct: 14.5, heightPx: 110 },
  validate: { leftPct: 7, rightPct: 7, bottomPct: 14.5, heightPx: 110 },
} as const;

export type SubtitleBandMode = keyof typeof SUBTITLE_BAND;

export function subtitleBandRect(
  mode: SubtitleBandMode = "validate",
  canvas: Canvas = FRAME,
): Rect {
  const b = SUBTITLE_BAND[mode];
  const y1 = canvas.height * (1 - b.bottomPct / 100);
  return {
    x0: (b.leftPct / 100) * canvas.width,
    y0: y1 - b.heightPx,
    x1: canvas.width * (1 - b.rightPct / 100),
    y1,
  };
}

export const rectWidth = (r: Rect): number => Math.max(0, r.x1 - r.x0);
export const rectHeight = (r: Rect): number => Math.max(0, r.y1 - r.y0);
export const rectArea = (r: Rect): number => rectWidth(r) * rectHeight(r);

export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const r: Rect = {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
}

export function rectUnion(rects: Rect[]): Rect | null {
  const list = rects.filter((r) => Number.isFinite(r.x0) && Number.isFinite(r.x1));
  if (list.length === 0) return null;
  return {
    x0: Math.min(...list.map((r) => r.x0)),
    y0: Math.min(...list.map((r) => r.y0)),
    x1: Math.max(...list.map((r) => r.x1)),
    y1: Math.max(...list.map((r) => r.y1)),
  };
}

export interface EdgeOverflow {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** true when the rect extends beyond `bounds` on at least one side */
  outside: boolean;
}

const overflow = (r: Rect, bounds: Rect): EdgeOverflow => {
  const left = Math.max(0, bounds.x0 - r.x0);
  const top = Math.max(0, bounds.y0 - r.y0);
  const right = Math.max(0, r.x1 - bounds.x1);
  const bottom = Math.max(0, r.y1 - bounds.y1);
  return { left, top, right, bottom, outside: left + top + right + bottom > 0.5 };
};

/** How far `r` extends outside the frame (px). `outside === true` means clipped/unrenderable. */
export const frameOverflow = (r: Rect, canvas: Canvas = FRAME): EdgeOverflow =>
  overflow(r, frameRect(canvas));

/** How far `r` extends outside the safe area (px). Evidence only - the frame edge is the hard line. */
export const safeAreaOverflow = (r: Rect, canvas: Canvas = FRAME): EdgeOverflow =>
  overflow(r, safeAreaRect(canvas));

export const clampRect = (r: Rect, bounds: Rect): Rect => ({
  x0: Math.min(Math.max(r.x0, bounds.x0), bounds.x1),
  y0: Math.min(Math.max(r.y0, bounds.y0), bounds.y1),
  x1: Math.max(Math.min(r.x1, bounds.x1), bounds.x0),
  y1: Math.max(Math.min(r.y1, bounds.y1), bounds.y0),
});

/** Normalize a px rect to 0..1 fractions of the canvas (stable across resolutions). */
export function normalizeRect(r: Rect, canvas: Canvas = FRAME): Rect {
  return {
    x0: r.x0 / canvas.width,
    y0: r.y0 / canvas.height,
    x1: r.x1 / canvas.width,
    y1: r.y1 / canvas.height,
  };
}

/** Rounded px rect for reports (2 decimals keeps JSON compact and comparisons stable). */
export const roundRect = (r: Rect, digits = 1): Rect => {
  const f = 10 ** digits;
  return {
    x0: Math.round(r.x0 * f) / f,
    y0: Math.round(r.y0 * f) / f,
    x1: Math.round(r.x1 * f) / f,
    y1: Math.round(r.y1 * f) / f,
  };
};

/** True when two rects overlap by more than `minArea` px (deterministic, no epsilon surprises). */
export function rectsOverlap(a: Rect, b: Rect, minArea = 1): boolean {
  const i = rectIntersection(a, b);
  return i !== null && rectArea(i) >= minArea;
}
