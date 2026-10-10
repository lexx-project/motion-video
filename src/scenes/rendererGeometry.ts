import { anchor, alignItemsFor, maxWidthFor, headlinePositionFor, FULLSCREEN_ATMOSPHERIC } from "./layout";
import { FRAME, rectUnion, type Rect } from "./bounds";
import { typography } from "../core/designSystem";
import { sizeScale } from "../primitives/sizing";
import {
  ensureTextWidths,
  measureTextWidth,
  type TextStyle,
  type MeasurementSource,
  type MeasurementReport,
} from "../render/measureText";
import type { SceneSpec, SceneElement } from "../validation/schema";

/**
 * Renderer-aware layout geometry (Batch B / B2).
 *
 * The renderer is the source of truth, so this module reproduces - deterministically and
 * without a browser - the exact chain Remotion applies to every element:
 *
 *   anchor() position
 *     -> absolute box shrink-to-fit (`left` set, `width:auto`) then clamped by `max-width`
 *     -> flex column flow: gap 44, alignItems places each item on the cross axis
 *     -> logical text/object box (text measured with the REAL fonts, see render/measureText)
 *     -> wrapper transform: translate(offset) . rotate(deg) . scale(s)   [origin 50% 50%]
 *     -> transformed corners -> axis-aligned bounding box
 *     -> frame / safe-area comparison (performed by validation/layoutGate)
 *
 * Corrections versus the pre-Batch-B model (why scene_03 reported 0 model violations while
 * its rendered frames carried 410-419px of right-edge ink):
 *   1. the flex layout box is UNSCALED - transforms affect painting, not layout;
 *   2. `scale()` grows around the box centre, so the anchored edge does NOT stay put;
 *   3. group width is shrink-to-fit capped by `max-width`, not by the anchor's free space;
 *   4. text is measured with the bundled webfonts, so wrapping and long-word overflow match
 *      what Chrome paints (a 2.2x scaled word can leave the frame although its logical box
 *      sits safely inside the safe area);
 *   5. rotation contributes the AABB of the rotated corners.
 *
 * Object sizes mirrored from components are marked exact; the static fallback table is marked
 * approximate and is never trusted alone - rendered pixel evidence (Batch A) cross-checks it.
 */

export type ItemSource = MeasurementSource | "fixed";

export interface ItemGeometry {
  /** stable id, same format the existing collision messages use */
  id: string;
  pos: string;
  isText: boolean;
  primitive: string;
  /** semantic role declared on the element (undefined for legacy scenes) */
  role?: string;
  /** declared overlap intent (Batch C): "intentional" marks an accepted overlap */
  collisionIntent?: string;
  /** unscaled flex box (pre-transform) */
  layout: Rect;
  /** logical ink box pre-transform (a long unbreakable word can overflow its box) */
  ink: Rect;
  /** AABB after translate/rotate/scale - what the renderer can actually paint */
  rendered: Rect;
  transform: { scale: number; rotation: number; dx: number; dy: number; originX: number; originY: number };
  source: ItemSource;
}

export interface GroupGeometry {
  pos: string;
  rect: Rect;
  itemIds: string[];
  /** shrink-to-fit width the renderer actually uses */
  width: number;
  /** free space right of `left` (input to CSS shrink-to-fit) */
  available: number;
  /** `max-width` cap for this anchor */
  maxWidthCap: number;
  height: number;
}

export interface SceneGeometry {
  canvas: { width: number; height: number };
  items: ItemGeometry[];
  groups: GroupGeometry[];
  /** union of rendered boxes (fullscreen/background layers excluded) */
  contentBox: Rect | null;
  sources: ItemSource[];
}

/** `baseType()` in typography.tsx caps every text block at 928px. */
export const TEXT_BOX_MAX = 928;
/** Gap used by AnchorGroup in SceneRenderer. */
export const ANCHOR_GAP = 44;
/** Approximate line box for small object labels rendered without an explicit line-height. */
const NORMAL_LINE_HEIGHT = 1.3;

const TEXT_TIERS: Record<string, { tier: string; family: "display" | "body" }> = {
  Headline: { tier: "headline", family: "display" },
  WordReveal: { tier: "headline", family: "display" },
  CharacterReveal: { tier: "headline", family: "display" },
  HighlightWord: { tier: "headline", family: "body" },
  CounterText: { tier: "counter", family: "display" },
  Quote: { tier: "quote", family: "display" },
  Subheadline: { tier: "subheadline", family: "body" },
  Label: { tier: "label", family: "body" },
  Caption: { tier: "caption", family: "body" },
};

/** Static logical sizes for primitives whose component geometry is not worth mirroring exactly.
 *  Marked approximate: rendered pixel evidence is the independent cross-check for these. */
const OBJECT_BOX_APPROX: Record<string, [number, number]> = {
  Clock: [380, 380],
  Calendar: [440, 440],
  ProfileCard: [460, 170],
  GenericCard: [380, 160],
  Target: [400, 400],
  ProgressBar: [560, 90],
  Checkbox: [420, 90],
  Person: [170, 300],
  SpeechBubble: [340, 210],
  Timeline: [700, 480],
  Comparison: [900, 500],
  BeforeAfter: [920, 380],
  Flow: [940, 140],
  Branch: [860, 340],
  Relationship: [760, 760],
  Progress: [940, 100],
  Sequence: [820, 440],
};

const numeric = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const percentOf = (value: string, total: number): number => (parseFloat(value) / 100) * total;

interface TextSpec {
  kind: "text";
  text: string;
  style: TextStyle;
  /** primitive-imposed width cap (Quote overrides baseType's 928 with 860) */
  boxMax?: number;
}

interface ObjectSpec {
  kind: "object";
  w: number;
  h: number;
  /** rotation applied inside the component (Arrow direction) - adds an AABB step */
  innerRotation?: number;
}

type ItemSpec = TextSpec | ObjectSpec;

const textStyleFor = (primitive: string): TextStyle | null => {
  const entry = TEXT_TIERS[primitive];
  if (!entry) return null;
  const tier = typography.scale[entry.tier];
  if (!tier) return null;
  return {
    family: entry.family === "body" ? "Inter" : "Archivo",
    sizePx: tier.default,
    weight: tier.weight,
    letterSpacingEm: tier.letterSpacingEm,
    lineHeight: tier.lineHeight,
    uppercase: tier.uppercase,
  };
};

/** Mirrors objects.tsx `fs(base, s) = max(label.min, base * s)`. */
const labelSize = (base: number, s: number): number => Math.max(typography.scale.label.min, base * s);

const objectLabelStyle = (base: number, s: number, weight: number, tracking: number, upper: boolean): TextStyle => ({
  family: "Inter",
  sizePx: labelSize(base, s),
  weight,
  letterSpacingEm: tracking,
  lineHeight: NORMAL_LINE_HEIGHT,
  uppercase: upper,
});

const rotatedAABB = (w: number, h: number, deg: number): { w: number; h: number } => {
  if (!deg) return { w, h };
  const rad = (deg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return { w: w * cos + h * sin, h: w * sin + h * cos };
};

/** Logical size of an object primitive, mirrored from its component source where it matters. */
function objectSpec(el: SceneElement, widthOf: (t: string, s: TextStyle) => number): ObjectSpec | { kind: "fullscreen" } | null {
  const sc = sizeScale(el.size as string | undefined);
  const p = el as unknown as Record<string, unknown>;
  if (FULLSCREEN_ATMOSPHERIC.has(el.primitive)) return { kind: "fullscreen" };

  switch (el.primitive) {
    case "Line": {
      // objects.tsx: component default thickness is 4 (design-system default 3 - renderer wins)
      const horiz = (p.orientation ?? "horizontal") !== "vertical";
      const len = numeric(p.lengthPct, 60);
      const th = Math.max(3, numeric(p.thicknessPx, 4) * sc);
      const pixelLen = Math.round((len / 100) * 440 * sc);
      return horiz
        ? { kind: "object", w: Math.max(80, pixelLen), h: th }
        : { kind: "object", w: th, h: Math.max(160, pixelLen) };
    }
    case "Circle": {
      const d = numeric(p.diameterPct, 40) * 9.2 * sc;
      const label = typeof p.label === "string" && p.label.trim() ? p.label : "";
      if (!label) return { kind: "object", w: d, h: d };
      const style = objectLabelStyle(26, sc, 700, 0.06, true);
      return { kind: "object", w: Math.max(d, widthOf(label, style)), h: d + 16 + style.sizePx * style.lineHeight };
    }
    case "Arrow": {
      const len = numeric(p.lengthPct, 50) * 5.6 * sc;
      const h = 40 * sc;
      const dir = typeof p.direction === "string" ? p.direction : "right";
      const rot = dir === "left" ? 180 : dir === "up" ? -90 : dir === "down" ? 90 : dir === "diagonal" ? 45 : 0;
      return rot === 0 ? { kind: "object", w: len, h } : { kind: "object", w: len, h, innerRotation: rot };
    }
    case "Grid": {
      const cols = numeric(p.cols, 3);
      const rows = numeric(p.rows, 3);
      const cell = 92 * sc;
      const gap = 14 * sc;
      return { kind: "object", w: cols * cell + (cols - 1) * gap, h: rows * cell + (rows - 1) * gap };
    }
    case "Stack": {
      const count = numeric(p.count, 4);
      const label = typeof p.label === "string" && p.label.trim() ? p.label : "";
      const w = 340 * sc;
      const h = (count * 26 + 110) * sc;
      if (!label) return { kind: "object", w, h };
      const style = objectLabelStyle(27, sc, 700, 0.06, true);
      return { kind: "object", w: Math.max(w, widthOf(label, style)), h: h + 20 + style.sizePx * style.lineHeight };
    }
    case "Number": {
      const style: TextStyle = {
        family: "Archivo",
        sizePx: labelSize(170, sc),
        weight: 900,
        letterSpacingEm: -0.03,
        lineHeight: 1.1,
        uppercase: false,
      };
      const text = `${typeof p.prefix === "string" ? p.prefix : ""}${typeof p.value === "number" ? p.value : 0}${typeof p.suffix === "string" ? p.suffix : ""}`;
      return { kind: "object", w: widthOf(text, style), h: style.sizePx * style.lineHeight };
    }
    case "Indicator": {
      const dot = 44 * sc;
      const label = typeof p.label === "string" && p.label.trim() ? p.label : "";
      if (!label) return { kind: "object", w: dot, h: dot };
      const style = objectLabelStyle(30, sc, 700, 0, false);
      return { kind: "object", w: dot + 18 + widthOf(label, style), h: Math.max(dot, style.sizePx * style.lineHeight) };
    }
    case "Badge": {
      const style = objectLabelStyle(28, sc, 800, 0.1, true);
      const text = typeof p.text === "string" ? p.text : "";
      return { kind: "object", w: widthOf(text, style) + 60 * sc, h: style.sizePx * style.lineHeight + 32 * sc };
    }
    case "Checkbox": {
      const box = 74 * sc;
      const label = typeof p.label === "string" && p.label.trim() ? p.label : "";
      if (!label) return { kind: "object", w: box, h: box };
      const style = objectLabelStyle(34, sc, 700, 0, false);
      return { kind: "object", w: box + 22 + widthOf(label, style), h: Math.max(box, style.sizePx * style.lineHeight) };
    }
    default:
      break;
  }
  const approx = OBJECT_BOX_APPROX[el.primitive];
  if (!approx) return null;
  return { kind: "object", w: approx[0] * sc, h: approx[1] * sc };
}

function itemSpecFor(
  el: SceneElement,
  textWidth: (t: string, s: TextStyle) => { width: number; source: MeasurementSource },
): ItemSpec | { kind: "fullscreen" } | null {
  const tier = textStyleFor(el.primitive);
  if (tier) {
    const text = typeof el.text === "string" ? el.text : "";
    if (!text.trim()) return null;
    return { kind: "text", text, style: tier, boxMax: el.primitive === "Quote" ? 860 : undefined };
  }
  return objectSpec(el, (t, st) => textWidth(t, st).width);
}

/* --------------------------------- transforms -------------------------------- */

/**
 * CSS `translate(dx,dy) rotate(r) scale(s)` applied about `origin`
 * (transform-origin: 50% 50%), exactly as `ElementInner` writes it.
 */
export function transformRect(
  box: Rect,
  origin: { x: number; y: number },
  scale: number,
  rotationDeg: number,
  dx: number,
  dy: number,
): Rect {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners: [number, number][] = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x1, box.y1],
    [box.x0, box.y1],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    const sx = origin.x + (x - origin.x) * scale;
    const sy = origin.y + (y - origin.y) * scale;
    const rx = origin.x + (sx - origin.x) * cos - (sy - origin.y) * sin;
    const ry = origin.y + (sx - origin.x) * sin + (sy - origin.y) * cos;
    const fx = rx + dx;
    const fy = ry + dy;
    if (fx < minX) minX = fx;
    if (fx > maxX) maxX = fx;
    if (fy < minY) minY = fy;
    if (fy > maxY) maxY = fy;
  }
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

/* -------------------------------- text helpers ------------------------------- */

const normalizeText = (text: string, style: TextStyle): string =>
  (style.uppercase ? text.toUpperCase() : text).replace(/\s+/g, " ").trim();

function wrapText(
  text: string,
  style: TextStyle,
  boxWidth: number,
  widthOf: (t: string, s: TextStyle) => number,
): { lines: string[]; maxLineWidth: number } {
  const words = normalizeText(text, style).split(" ").filter(Boolean);
  if (words.length === 0) return { lines: [], maxLineWidth: 0 };
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (!current || widthOf(candidate, style) <= boxWidth) current = candidate;
    else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  let maxLineWidth = 0;
  for (const l of lines) maxLineWidth = Math.max(maxLineWidth, widthOf(l, style));
  return { lines, maxLineWidth };
}

interface Intrinsic {
  min: number;
  max: number;
}

/** CSS shrink-to-fit inputs for one flex item (cross-axis content size). */
function intrinsicContentSize(spec: ItemSpec, widthOf: (t: string, s: TextStyle) => number): Intrinsic {
  if (spec.kind === "object") return { min: spec.w, max: spec.w };
  const measured = widthOf(spec.text, spec.style);
  const words = normalizeText(spec.text, spec.style).split(" ").filter(Boolean);
  let longest = 0;
  for (const w of words) longest = Math.max(longest, widthOf(w, spec.style));
  const cap = spec.boxMax;
  const max = cap ? Math.min(measured, cap) : measured;
  const min = cap ? Math.min(longest, cap) : longest;
  return { min, max };
}

/* -------------------------------- main entry --------------------------------- */

interface FlowItem {
  id: string;
  pos: string;
  isText: boolean;
  primitive: string;
  role?: string;
  collisionIntent?: string;
  spec: ItemSpec;
  scale: number;
  rotation: number;
  dx: number;
  dy: number;
  align: "flex-start" | "flex-end" | "center";
  source: ItemSource;
}

function buildFlow(scene: SceneSpec, textWidth: (t: string, s: TextStyle) => { width: number; source: MeasurementSource }): FlowItem[] {
  const flow: FlowItem[] = [];
  const add = (el: SceneElement, id: string, pos: string): void => {
    const spec = itemSpecFor(el, textWidth);
    if (!spec || spec.kind === "fullscreen") return;
    const sc = sizeScale(el.size as string | undefined);
    const source: ItemSource =
      spec.kind === "text" ? textWidth(spec.text, spec.style).source : "fixed";
    flow.push({
      id,
      pos,
      isText: spec.kind === "text",
      primitive: el.primitive,
      role: typeof el.role === "string" ? el.role : undefined,
      collisionIntent: typeof el.collisionIntent === "string" ? el.collisionIntent : undefined,
      spec,
      scale: numeric(el.scale, 1) * sc,
      rotation: numeric(el.rotation, 0),
      dx: (numeric(el.offsetX, 0) / 100) * FRAME.width,
      dy: (numeric(el.offsetY, 0) / 100) * FRAME.height,
      align: alignItemsFor(pos),
      source,
    });
  };

  scene.elements.forEach((el, i) => {
    const pos = (el.position as string | undefined) ?? "center";
    const spec = itemSpecFor(el, textWidth);
    if (!spec || spec.kind === "fullscreen") return;
    const id =
      spec.kind === "text"
        ? `${el.primitive}[${i}]("${spec.text.replace(/\s+/g, " ").slice(0, 18)}...")`
        : `${el.primitive}[${i}]`;
    add(el, id, pos);
  });

  if (scene.headline) {
    const pos = scene.headline.position ?? headlinePositionFor(scene.composition);
    const headlineEl = {
      primitive: "Headline",
      text: scene.headline.text,
      align: scene.headline.align,
      position: pos,
      scale: 1,
      offsetX: (scene.headline as { offsetX?: number }).offsetX,
      offsetY: (scene.headline as { offsetY?: number }).offsetY,
    } as unknown as SceneElement;
    add(
      headlineEl,
      `scene.headline("${scene.headline.text.replace(/\s+/g, " ").slice(0, 18)}...")`,
      pos,
    );
  }
  return flow;
}

interface SizedItem {
  item: FlowItem;
  /** cross-axis box width used by the flex flow */
  boxW: number;
  /** main-axis box height used by the flex flow (UNROTATED - transforms do not affect layout) */
  layoutH: number;
  /** ink box relative to the layout box origin (paint extent, pre-wrapper-transform) */
  ink: { dx: number; dy: number; w: number; h: number };
}

function inkBoxFor(
  item: FlowItem,
  boxW: number,
  widthOf: (t: string, s: TextStyle) => number,
): Omit<SizedItem, "item" | "boxW"> {
  if (item.spec.kind === "object") {
    if (item.spec.innerRotation) {
      const a = rotatedAABB(item.spec.w, item.spec.h, item.spec.innerRotation);
      return {
        layoutH: item.spec.h,
        ink: { dx: (item.spec.w - a.w) / 2, dy: (item.spec.h - a.h) / 2, w: a.w, h: a.h },
      };
    }
    return { layoutH: item.spec.h, ink: { dx: 0, dy: 0, w: item.spec.w, h: item.spec.h } };
  }
  const style = item.spec.style;
  const wrapW = Math.min(boxW, item.spec.boxMax ?? TEXT_BOX_MAX);
  const { lines, maxLineWidth } = wrapText(item.spec.text, style, wrapW, widthOf);
  const h = Math.max(1, lines.length) * style.sizePx * style.lineHeight;
  // the text block starts at the wrapper's leading edge; align distributes lines inside it
  let dx: number;
  if (item.align === "flex-start") dx = 0;
  else if (item.align === "flex-end") dx = wrapW - maxLineWidth;
  else dx = (wrapW - maxLineWidth) / 2;
  return { layoutH: h, ink: { dx, dy: 0, w: maxLineWidth, h } };
}

/**
 * Rendered geometry of one scene: logical box -> transform -> AABB, with group shrink-to-fit.
 * Pure function of (scene JSON, cached text measurements).
 */
export function sceneRenderedGeometry(
  scene: SceneSpec,
  textWidth: (text: string, style: TextStyle) => { width: number; source: MeasurementSource } = (t, s) =>
    measureTextWidth(t, s),
): SceneGeometry {
  const canvas = { width: FRAME.width, height: FRAME.height };
  const widthOf = (t: string, s: TextStyle): number => textWidth(t, s).width;
  const flow = buildFlow(scene, textWidth);

  const groups = new Map<string, FlowItem[]>();
  for (const item of flow) {
    const list = groups.get(item.pos);
    if (list) list.push(item);
    else groups.set(item.pos, [item]);
  }

  const items: ItemGeometry[] = [];
  const groupGeoms: GroupGeometry[] = [];

  for (const [pos, list] of groups) {
    const a = anchor(pos);
    const leftPx = percentOf(a.left, canvas.width);
    const topPx = percentOf(a.top, canvas.height);
    const maxWidthCap = percentOf(maxWidthFor(pos), canvas.width);
    const available = Math.max(0, canvas.width - leftPx);

    // CSS shrink-to-fit: min(max(minContent, available), maxContent) then `max-width` clamp.
    let minContent = 0;
    let maxContent = 0;
    for (const item of list) {
      const size = intrinsicContentSize(item.spec, widthOf);
      minContent = Math.max(minContent, size.min);
      maxContent = Math.max(maxContent, size.max);
    }
    const groupWidth = Math.max(0, Math.min(maxWidthCap, Math.min(Math.max(minContent, available), maxContent)));

    const sized: SizedItem[] = list.map((item) => {
      const boxW = Math.min(intrinsicContentSize(item.spec, widthOf).max, groupWidth);
      const rest = inkBoxFor(item, boxW, widthOf);
      return { item, boxW, layoutH: rest.layoutH, ink: rest.ink };
    });

    const groupHeight = sized.reduce((n, s) => n + s.layoutH, 0) + ANCHOR_GAP * Math.max(0, sized.length - 1);
    const groupX = leftPx + (a.tx / 100) * groupWidth;
    const groupY = topPx + (a.ty / 100) * groupHeight;

    groupGeoms.push({
      pos,
      rect: { x0: groupX, y0: groupY, x1: groupX + groupWidth, y1: groupY + groupHeight },
      itemIds: sized.map((s) => s.item.id),
      width: groupWidth,
      available,
      maxWidthCap,
      height: groupHeight,
    });

    let cursorY = groupY;
    for (const s of sized) {
      let boxX: number;
      if (s.item.align === "flex-start") boxX = groupX;
      else if (s.item.align === "flex-end") boxX = groupX + groupWidth - s.boxW;
      else boxX = groupX + (groupWidth - s.boxW) / 2;

      const layout: Rect = { x0: boxX, y0: cursorY, x1: boxX + s.boxW, y1: cursorY + s.layoutH };
      const ink: Rect = {
        x0: layout.x0 + s.ink.dx,
        y0: layout.y0 + s.ink.dy,
        x1: layout.x0 + s.ink.dx + s.ink.w,
        y1: layout.y0 + s.ink.dy + s.ink.h,
      };
      const origin = { x: (layout.x0 + layout.x1) / 2, y: (layout.y0 + layout.y1) / 2 };
      const rendered = transformRect(ink, origin, s.item.scale, s.item.rotation, s.item.dx, s.item.dy);
      items.push({
        id: s.item.id,
        pos,
        isText: s.item.isText,
        primitive: s.item.primitive,
        role: s.item.role,
        collisionIntent: s.item.collisionIntent,
        layout,
        ink,
        rendered,
        transform: {
          scale: s.item.scale,
          rotation: s.item.rotation,
          dx: s.item.dx,
          dy: s.item.dy,
          originX: origin.x,
          originY: origin.y,
        },
        source: s.item.source,
      });
      cursorY += s.layoutH + ANCHOR_GAP;
    }
  }

  return {
    canvas,
    items,
    groups: groupGeoms,
    contentBox: rectUnion(items.map((i) => i.rendered)),
    sources: [...new Set(items.map((i) => i.source))],
  };
}

/**
 * Measure every text string this scene's geometry needs, in ONE browser batch.
 *
 * Strategy: run the geometry with a recording provider (pass 1), collect every string it asks
 * for - full strings, wrap candidates, object labels - measure them, then repeat until a pass
 * asks for nothing new. Wrapping can change once real widths arrive, so one pass is not enough.
 *
 * Never throws: a failed measurement pass simply leaves the labelled estimates in place, and
 * the returned report says so (`browserUsed`, `failed`).
 */
export async function ensureSceneTextMetrics(
  scene: SceneSpec,
  maxPasses = 3,
): Promise<MeasurementReport> {
  return ensureTextMetricsForScenes([scene], maxPasses);
}

/**
 * Same as ensureSceneTextMetrics but for a whole project in ONE browser batch
 * (the layout gate runs per scene; measuring per scene would open Chrome N times).
 */
export async function ensureTextMetricsForScenes(
  scenes: SceneSpec[],
  maxPasses = 3,
): Promise<MeasurementReport> {
  const recorded = new Map<string, { text: string; style: TextStyle }>();
  const recording = (text: string, style: TextStyle): { width: number; source: MeasurementSource } => {
    const key = `${style.family}|${style.weight}|${style.sizePx}|${style.letterSpacingEm}|${text}`;
    if (!recorded.has(key)) recorded.set(key, { text, style });
    return measureTextWidth(text, style);
  };

  let merged: MeasurementReport = { measured: 0, fromCache: 0, failed: 0, browserUsed: false };
  for (let pass = 0; pass < maxPasses; pass++) {
    const before = recorded.size;
    for (const scene of scenes) sceneRenderedGeometry(scene, recording); // pass N may ask for new strings
    const addedDuringPass = recorded.size - before;
    const report = await ensureTextWidths([...recorded.values()]);
    merged = {
      measured: merged.measured + report.measured,
      fromCache: report.fromCache,
      failed: report.failed,
      browserUsed: merged.browserUsed || report.browserUsed,
      ...(report.error ? { error: report.error } : {}),
    };
    if (!report.browserUsed && report.failed > 0) break; // browser unavailable - keep estimates
    if (pass > 0 && addedDuringPass === 0 && report.measured === 0) break; // converged
  }
  return merged;
}
