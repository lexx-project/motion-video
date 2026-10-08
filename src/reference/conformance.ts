import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import {
  colors,
  composition,
  motion,
  typography,
} from "../core/designSystem";
import { headlinePositionFor, availableWidthPx, textBoxFor, horizontalTextBoxFor, overlapArea, maxWidthFor, type TextBox } from "../scenes/layout";
import type { SceneSpec } from "../validation/schema";
import { markStage, writeJson } from "../core/projectStore";

const sizeScaleOf = (size: unknown): number =>
  size === "sm" ? 0.7 : size === "lg" ? 1.35 : size === "xl" ? 1.8 : 1;

const execFileAsync = promisify(execFile);

/**
 * Reference conformance evaluator (Phase 2 §8).
 *
 * Judges "same design language, different content" against design-system V2 tokens
 * which are themselves reference-derived. NEVER pixel similarity, never content copying.
 * Deterministic structural checks + optional rendered-frame color statistics.
 */

export interface DimensionScores {
  visualStyle: number;
  typography: number;
  color: number;
  composition: number;
  motion: number;
  density: number;
  negativeSpace: number;
}

export interface SceneConformance {
  sceneId: string;
  scores: DimensionScores;
  overall: number;
  evidence: string[];
}

export interface ConformanceReport {
  scenes: SceneConformance[];
  overall: number;
  method: string;
}

const clamp = (v: number): number => Math.max(0, Math.min(10, v));
const round1 = (v: number): number => Math.round(v * 10) / 10;

const GLOW_PRIMITIVES = new Set(["GradientGlow", "SoftOrb"]);
const ATMOSPHERIC_PRIMITIVES = new Set(["GradientGlow", "SoftOrb", "Grain", "GridBackground", "LightSweep"]);
const OBJECT_PRIMITIVES = new Set([
  "Clock", "Calendar", "ProfileCard", "GenericCard", "Target", "ProgressBar", "Checkbox",
  "Arrow", "Line", "Circle", "Stack", "Grid", "Indicator", "Number", "Badge",
]);

const referenceShare = (grammar: string): number =>
  (composition as unknown as { referenceShares?: Record<string, { share: number }> }).referenceShares?.[grammar]?.share ?? 0;

/** Cross-anchor collision ratio threshold (override with COLLISION_RATIO env for calibration). */
const COLLISION_RATIO = Number(process.env.COLLISION_RATIO ?? "0.2");

const TEXT_FONT_SIZE: Record<string, number> = {
  Headline: typography.scale.headline.default,
  WordReveal: typography.scale.headline.default,
  CharacterReveal: typography.scale.headline.default,
  HighlightWord: typography.scale.headline.default,
  CounterText: typography.scale.counter.default,
  Quote: typography.scale.quote.default,
  Subheadline: typography.scale.subheadline.default,
  Label: typography.scale.label.default,
  Caption: typography.scale.caption.default,
};

/** Text-carrying primitives (for text-only detection; subtitles render separately). */
const TEXT_PRIMITIVES = new Set([...Object.keys(TEXT_FONT_SIZE), "Badge", "Subtitle"]);

/**
 * Primitives that are generic shapes UNLESS they document role+purpose (Phase 3 §22:
 * "why does this object exist?" - 'to look interesting' is not an answer).
 */
const GENERIC_SHAPES = new Set([
  "Circle", "Arrow", "Line", "Grid", "Indicator", "Number", "Stack", "ProgressBar",
]);

/** Base visual sizes (px @ scale 1) of object/diagram primitives for layout collision math. */
const OBJECT_BOX: Record<string, [number, number]> = {
  Clock: [380, 380],
  Calendar: [440, 440],
  ProfileCard: [460, 170],
  GenericCard: [380, 160],
  Target: [400, 400],
  ProgressBar: [560, 90],
  Checkbox: [420, 90],
  Arrow: [320, 48],
  Line: [640, 12],
  Circle: [368, 368],
  Stack: [340, 260],
  Grid: [340, 340],
  Indicator: [260, 60],
  Number: [320, 180],
  Badge: [220, 70],
  Timeline: [700, 480],
  Comparison: [900, 500],
  BeforeAfter: [920, 380],
  Flow: [940, 140],
  Branch: [860, 340],
  Relationship: [760, 760],
  Progress: [940, 100],
  Sequence: [820, 440],
  Person: [170, 300],
  SpeechBubble: [340, 210],
};

interface FlowItem {
  id: string;
  isText: boolean;
  x0: number;
  x1: number;
  h: number;
  ox: number;
  oy: number;
}

/** Horizontal extent of an object/diagram at its anchor (width capped by the column). */
function objectHorizontal(
  position: string,
  primitive: string,
  el: { size?: string; scale?: number; orientation?: string; lengthPct?: number; thicknessPx?: number; diameterPct?: number; direction?: string },
  base: [number, number],
): { x0: number; x1: number; h: number } {
  const scale = sizeScaleOf(el.size) * (typeof el.scale === "number" ? el.scale : 1);
  let wBase = base[0];
  let hBase = base[1];
  if (primitive === "Circle" && typeof el.diameterPct === "number") {
    wBase = (el.diameterPct / 100) * 1080;
    hBase = wBase;
  }
  if (primitive === "Line") {
    const vertical = el.orientation === "vertical";
    const lenPct = typeof el.lengthPct === "number" ? el.lengthPct : 60;
    const th = typeof el.thicknessPx === "number" ? el.thicknessPx : 3;
    wBase = vertical ? th : (lenPct / 100) * 1080;
    hBase = vertical ? Math.max(160, lenPct * 8) : th;
  }
  if (primitive === "Arrow") {
    const len = (typeof el.lengthPct === "number" ? el.lengthPct : 50) * 5.6;
    const vertical = el.direction === "up" || el.direction === "down";
    wBase = vertical ? 48 : len;
    hBase = vertical ? len : 48;
  }
  const colCap = (parseFloat(maxWidthFor(position)) / 100) * 1080;
  const w = Math.min(colCap, wBase * scale);
  const h = hBase * scale;
  const mx = (composition.safeArea.marginXPercent / 100) * 1080;
  let x0: number;
  if (position === "left" || position === "topLeft" || position === "bottomLeft") x0 = mx;
  else if (position === "right" || position === "topRight" || position === "bottomRight") x0 = 1080 - mx - w;
  else x0 = 540 - w / 2;
  return { x0, x1: x0 + w, h };
}

/**
 * Deterministic layout model mirroring the renderer's GROUP-FLOW (Phase 3 export):
 * items sharing an anchor are flex-stacked (gap 44px); offsets applied; boxes returned
 * for collision checks (textCollisions, subtitle band) and semantic scoring.
 */
export function sceneLayoutBoxes(scene: SceneSpec): { id: string; pos: string; box: TextBox; isText: boolean }[] {
  const groups = new Map<string, FlowItem[]>();
  const addItem = (pos: string, item: FlowItem): void => {
    const list = groups.get(pos);
    if (list) list.push(item);
    else groups.set(pos, [item]);
  };

  if (scene.headline) {
    const pos = scene.headline.position ?? headlinePositionFor(scene.composition);
    const t = horizontalTextBoxFor(
      scene.headline.text,
      pos,
      typography.scale.headline.default,
      (scene.headline.align as "left" | "center" | "right") ?? "center",
      typography.scale.headline.lineHeight,
    );
    addItem(pos, {
      id: `scene.headline("${scene.headline.text.replace(/\s+/g, " ").slice(0, 18)}...")`,
      isText: true,
      ox: 0,
      oy: 0,
      ...t,
    });
  }
  scene.elements.forEach((el, i) => {
    const textBase = TEXT_FONT_SIZE[el.primitive];
    const objBase = OBJECT_BOX[el.primitive];
    const pos = (el.position as string) ?? "center";
    if (textBase !== undefined) {
      const text = typeof el.text === "string" ? el.text : "";
      if (!text.trim()) return;
      const alignRaw = typeof el.align === "string" ? el.align : "center";
      const align = alignRaw === "left" || alignRaw === "right" ? alignRaw : "center";
      const scale = sizeScaleOf(el.size) * (typeof el.scale === "number" ? el.scale : 1);
      const t = horizontalTextBoxFor(text, pos, textBase * scale, align, 1.2);
      const oxT = typeof el.offsetX === "number" ? el.offsetX : 0;
      const oyT = typeof el.offsetY === "number" ? el.offsetY : 0;
      addItem(pos, { id: `${el.primitive}[${i}]("${text.replace(/\s+/g, " ").slice(0, 18)}...")`, isText: true, ox: oxT, oy: oyT, ...t });
      return;
    }
    if (objBase === undefined) return; // atmospheric glow behind content is by design
    const o = objectHorizontal(pos, el.primitive, el as { size?: string; scale?: number; orientation?: string; lengthPct?: number; thicknessPx?: number; diameterPct?: number; direction?: string }, objBase);
    const oxO = typeof el.offsetX === "number" ? el.offsetX : 0;
    const oyO = typeof el.offsetY === "number" ? el.offsetY : 0;
    addItem(pos, { id: `${el.primitive}[${i}]`, isText: false, ox: oxO, oy: oyO, ...o });
  });

  // group flow: flex column, gap 44, justify start(top)/center/end(bottom) - mirrors renderer
  const GAP = 44;
  const mt = (composition.safeArea.marginTopPercent / 100) * 1920;
  const mb = ((100 - composition.safeArea.marginBottomPercent) / 100) * 1920;
  const boxes: { id: string; pos: string; box: TextBox; isText: boolean }[] = [];
  for (const [pos, items] of groups) {
    const H = items.reduce((a, it) => a + it.h, 0) + GAP * Math.max(0, items.length - 1);
    let y =
      pos === "top" || pos === "topLeft" || pos === "topRight"
        ? mt
        : pos === "bottom" || pos === "bottomLeft" || pos === "bottomRight"
          ? mb - H
          : 960 - H / 2;
    for (const it of items) {
      // offsets are % of canvas: x -> % of 1080, y -> % of 1920 (mirrors ElementInner transform)
      const dx = it.ox * 10.8;
      const dy = it.oy * 19.2;
      boxes.push({
        id: it.id,
        pos,
        isText: it.isText,
        box: { x0: it.x0 + dx, y0: y + dy, x1: it.x1 + dx, y1: y + dy + it.h },
      });
      y += it.h + GAP;
    }
  }
  return boxes;
}

/**
 * Cross-anchor collision detection (text-involving pairs; same-anchor skipped because the
 * renderer stacks them; thin items need higher ratio). Catches "ring cuts through headline".
 */
export function textCollisions(scene: SceneSpec): { a: string; b: string; ratio: number }[] {
  const boxes = sceneLayoutBoxes(scene);
  const out: { a: string; b: string; ratio: number }[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxes[i].pos === boxes[j].pos) continue; // same anchor: flex-stacked, no overlap by construction
      if (!boxes[i].isText && !boxes[j].isText) continue; // object-object overlap is allowed
      const area = (b: TextBox): number => Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
      const ov = overlapArea(boxes[i].box, boxes[j].box);
      const ratio = ov / Math.min(area(boxes[i].box), area(boxes[j].box));
      // Thin elements (hairlines, 3-12px rules) cross inter-line whitespace without
      // hurting readability (verified against rendered frames) - demand a higher ratio.
      const thin =
        boxes[i].box.y1 - boxes[i].box.y0 <= 14 || boxes[j].box.y1 - boxes[j].box.y0 <= 14;
      const threshold = thin ? 0.6 : COLLISION_RATIO;
      if (ratio > threshold) out.push({ a: boxes[i].id, b: boxes[j].id, ratio: Number(ratio.toFixed(2)) });
    }
  }
  return out;
}

/** Subtitle band box (renderer: left/right 8%, bottom 14.5%, ~2 lines of 34px text). */
export function subtitleBoxFor(scene: SceneSpec): TextBox | null {
  const sub = scene.subtitle;
  if (!sub?.enabled || sub.phrases.length === 0) return null;
  const y1 = 1920 * (1 - 0.145);
  const y0 = y1 - 110; // up to 2 lines @34px lh1.3 + padding
  return { x0: 1080 * 0.07, x1: 1080 * 0.93, y0, y1 };
}

/** Subtitles must not fight any content in the lower band (separate layer, own timing). */
export function subtitleCollisions(scene: SceneSpec): { a: string; b: string; ratio: number }[] {
  const band = subtitleBoxFor(scene);
  if (!band) return [];
  const out: { a: string; b: string; ratio: number }[] = [];
  for (const item of sceneLayoutBoxes(scene)) {
    const area = (b: TextBox): number => Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
    const ov = overlapArea(band, item.box);
    // ratio vs the SMALLER box (calibrated against rendered frames: Clock@bottom 0.40 flags,
    // thin lines deep in the margin stay below threshold)
    const ratio = ov / Math.min(area(item.box), area(band));
    if (ratio > 0.35) out.push({ a: "subtitle.band", b: item.id, ratio: Number(ratio.toFixed(2)) });
  }
  return out;
}

/** Layout-aware rendered-line estimate (mirrors renderer anchors + headline size). */
function estimateLines(text: string, position: string, fontSize: number): number {
  const avail = availableWidthPx(position) - 40;
  const charW = fontSize * 0.70; // Archivo 900 uppercase average advance incl. tracking
  return text
    .split("\n")
    .reduce((n, seg) => n + Math.max(1, Math.ceil((seg.length * charW) / Math.max(80, avail))), 0);
}

export function conformanceScores(scene: SceneSpec): SceneConformance {
  const evidence: string[] = [];
  const elements = scene.elements;
  const totalRenderable = elements.length + (scene.headline ? 1 : 0);

  /* typography */
  let typographyScore = 10;
  const hl = scene.headline;
  if (hl) {
    if (hl.text.length > typography.rules.maxHeadlineChars) {
      const over = hl.text.length - typography.rules.maxHeadlineChars;
      typographyScore -= Math.min(4, Math.ceil(over / 20));
      evidence.push(`headline ${hl.text.length} chars > ${typography.rules.maxHeadlineChars}`);
    }
    const accentCount = hl.accentWords?.length ?? 0;
    if (accentCount > colors.rules.maxAccentWordsPerHeadline) {
      typographyScore -= 2 * (accentCount - colors.rules.maxAccentWordsPerHeadline);
      evidence.push(`${accentCount} accent words > ${colors.rules.maxAccentWordsPerHeadline}`);
    }
    const pos = headlinePositionFor(scene.composition);
    const lines = estimateLines(hl.text, pos, typography.scale.headline.default);
    if (lines > typography.rules.maxHeadlineLines) {
      typographyScore -= Math.min(6, (lines - typography.rules.maxHeadlineLines) * 1.5);
      evidence.push(`headline estimates ${lines} rendered lines in its ${pos} anchor > ${typography.rules.maxHeadlineLines}`);
    }
    if (hl.align === "right") {
      typographyScore -= 1;
      evidence.push("right-aligned headline is outside reference language");
    }
  } else {
    const textEls = elements.filter((e) => ["Headline", "WordReveal", "CharacterReveal", "Quote"].includes(e.primitive));
    for (const e of textEls) {
      const t = typeof e.text === "string" ? e.text : "";
      const elPos = (e.position as string) ?? "center";
      const size = typography.scale.headline.default * sizeScaleOf(e.size);
      const lines = estimateLines(t, elPos, size);
      if (lines > typography.rules.maxHeadlineLines) {
        typographyScore -= Math.min(4, (lines - typography.rules.maxHeadlineLines));
        evidence.push(`${e.primitive} "${t.slice(0, 24)}..." estimates ${lines} lines in ${elPos} anchor`);
      }
      if (t.length > typography.rules.maxHeadlineChars) typographyScore -= 2;
      const aw = Array.isArray(e.accentWords) ? e.accentWords.length : 0;
      if (aw > colors.rules.maxAccentWordsPerHeadline) typographyScore -= 2;
    }
  }

  /* color */
  let colorScore = 10;
  const accents = new Set(
    elements.map((e) => e.accent).filter((a): a is string => typeof a === "string" && a !== "none"),
  );
  if (accents.size > 1) {
    colorScore -= 3 * (accents.size - 1);
    evidence.push(`distinct accents: ${[...accents].join(", ")} (one dominant accent rule)`);
  }
  const glows = elements.filter((e) => GLOW_PRIMITIVES.has(e.primitive)).length;
  if (glows > colors.rules.maxGlowsPerScene) {
    colorScore -= 3 * (glows - colors.rules.maxGlowsPerScene);
    evidence.push(`${glows} glow primitives > ${colors.rules.maxGlowsPerScene}`);
  }
  const atmos = elements.filter((e) => ATMOSPHERIC_PRIMITIVES.has(e.primitive)).length;
  if (atmos > 2) {
    colorScore -= 2 * (atmos - 2);
    evidence.push(`${atmos} atmospheric elements (reference is restrained)`);
  }

  /* composition */
  let compositionScore = 8;
  const share = referenceShare(scene.composition);
  if (share >= 0.2) compositionScore = 10;
  else if (share >= 0.1) compositionScore = 9;
  else if (share > 0) compositionScore = 8;
  else {
    compositionScore = 6.5;
    evidence.push(`grammar "${scene.composition}" absent from reference shares (allowed by spec, off-language)`);
  }
  for (const c of textCollisions(scene)) {
    compositionScore -= 4;
    evidence.push(
      `COLLISION: ${c.a} overlaps ${c.b} (est. ${Math.round(c.ratio * 100)}% of the smaller text box) - cross-anchor text overlap is unreadable; move one to another band or the same anchor`,
    );
  }

  /* motion */
  let motionScore = 10;
  const pref = (motion as unknown as { preferred?: Record<string, string[]> }).preferred ?? {};
  const checks: [string, string[] | undefined][] = [
    [scene.motion.entrance, pref.entrances],
    [scene.motion.exit, pref.exits],
    [scene.motion.emphasis, pref.emphasis],
  ];
  for (const [token, list] of checks) {
    if (list && !list.includes(token)) {
      motionScore -= 1;
      evidence.push(`motion "${token}" outside reference-preferred set`);
    }
  }
  const longDelays = elements.filter((e) => typeof e.delay === "number" && e.delay > 1.4).length;
  if (longDelays > 0) {
    motionScore -= longDelays;
    evidence.push(`${longDelays} element delay > 1.4s (reference staggers quickly)`);
  }

  /* density — dynamic semantic budget (Phase 3 §11): 3-8 meaningful elements = full marks */
  let densityScore = 10;
  if (totalRenderable < 3) {
    densityScore = 6;
    evidence.push(`SPARSE: only ${totalRenderable} renderable element(s) - narrative likely under-visualized`);
  } else if (totalRenderable > 8) {
    densityScore = 7;
    evidence.push(`${totalRenderable} elements exceeds guideline 8 (readability pressure; hard max ${composition.maxElementsPerScene})`);
  }
  if (totalRenderable > composition.maxElementsPerScene) {
    densityScore = 3;
    evidence.push(`${totalRenderable} elements > hard max ${composition.maxElementsPerScene}`);
  }
  const rolelessGeneric = elements.filter(
    (e) => GENERIC_SHAPES.has(e.primitive) && (!e.role || e.role === "decorative"),
  );
  if (rolelessGeneric.length > 0) {
    densityScore -= Math.min(3, rolelessGeneric.length);
    evidence.push(
      `GENERIC: ${rolelessGeneric.map((e) => `${e.primitive}[${e.purpose ? "has purpose" : "no role/purpose"}]`).join(", ")} - shapes must document their semantic role`,
    );
  }

  /* negative space — restraint remains, complex relational beats may fill more */
  let negScore = 10;
  if (totalRenderable >= 9) negScore = 7;
  else if (totalRenderable >= 7) negScore = 8.5;
  if (hl && hl.text.replace(/\s/g, "").length > typography.rules.maxHeadlineChars) negScore -= 1;

  /* visual style: flat, restrained atmosphere + anti text-only penalty */
  let styleScore = 10;
  if (atmos >= 3) {
    styleScore -= 2;
    evidence.push("atmosphere count high vs flat reference style");
  }
  const hasVisualElement = elements.some(
    (e) => !TEXT_PRIMITIVES.has(e.primitive) && !ATMOSPHERIC_PRIMITIVES.has(e.primitive),
  );
  if (!hasVisualElement && !["typographyDominant", "fullFrameSymbolic"].includes(scene.composition)) {
    styleScore -= 5;
    evidence.push(
      "TEXT_ONLY: no visual object - the scene could be replaced by plain text without losing meaning (typography must be the intentional mechanism to exempt)",
    );
  }

  /* subtitle band vs bottom-anchored content */
  for (const c of subtitleCollisions(scene)) {
    compositionScore -= 4;
    evidence.push(`SUBTITLE_COLLISION: subtitle band overlaps ${c.b} (${Math.round(c.ratio * 100)}%) - move content out of the bottom band when subtitles are enabled`);
  }

  const scores: DimensionScores = {
    visualStyle: clamp(styleScore),
    typography: clamp(typographyScore),
    color: clamp(colorScore),
    composition: clamp(compositionScore),
    motion: clamp(motionScore),
    density: clamp(densityScore),
    negativeSpace: clamp(negScore),
  };
  const overall = round1(Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length);
  if (evidence.length === 0) evidence.push("structure conforms to reference-derived language");
  return { sceneId: scene.sceneId, scores, overall, evidence };
}

/**
 * Deterministic visual-richness / semantic-density score (Phase 3 §24).
 * Measures MEANING, not object count: roles, relationships, narrative events,
 * motion beats, supporting text, subtitle presence, mechanism documentation.
 */
export function semanticRichness(scene: SceneSpec): { score: number; breakdown: string[] } {
  const breakdown: string[] = [];
  let raw = 0;
  const sb = scene.storyboard;
  const semObjs = elements0(scene).filter((e) => e.role === "semantic");
  const supObjs = elements0(scene).filter((e) => e.role === "supporting");
  if (semObjs.length > 0) {
    raw += Math.min(3, semObjs.length * 1.2);
    breakdown.push(`${semObjs.length} semantic-role element(s)`);
  }
  if (supObjs.length > 0) {
    raw += Math.min(1.5, supObjs.length * 0.6);
    breakdown.push(`${supObjs.length} supporting element(s)`);
  }
  if (sb) {
    const rel = sb.relationships.length;
    if (rel > 0) {
      raw += Math.min(3, rel * 1.2);
      breakdown.push(`${rel} documented relationship(s)`);
    }
    if (sb.visualNarrative.length >= 2) {
      raw += Math.min(2, sb.visualNarrative.length * 0.5);
      breakdown.push(`${sb.visualNarrative.length} narrative steps`);
    }
    if (sb.motionBeats.length >= 2) {
      raw += Math.min(1.5, sb.motionBeats.length * 0.4);
      breakdown.push(`${sb.motionBeats.length} purposeful motion beats`);
    }
    if (sb.visualMechanism) {
      raw += 1;
      breakdown.push(`mechanism:${sb.visualMechanism}`);
    }
    if (sb.typographyPlan.supportingText.length > 0) raw += 0.5;
  }
  if (scene.subtitle?.enabled && scene.subtitle.phrases.length > 0) {
    raw += 1;
    breakdown.push("VO subtitle band active");
  }
  const score = Math.min(10, Math.round(raw * 10) / 10);
  return { score, breakdown };
}

function elements0(scene: SceneSpec): { role?: unknown; purpose?: unknown; primitive: string }[] {
  return scene.elements.map((e) => ({ role: e.role, purpose: e.purpose, primitive: e.primitive }));
}

/* ------------------------ rendered-frame statistics ------------------------ */

export interface FrameStats {
  meanLuma: number;
  textPixelShare: number;
  accentPixelShare: number;
  background: string;
}

/** Deterministic color stats of a rendered frame (via ffmpeg downscale - no image deps). */
export async function frameStats(file: string): Promise<FrameStats | null> {
  const tmp = `${file}.stat.rgb`;
  try {
    await execFileAsync("ffmpeg", ["-hide_banner", "-y", "-i", file, "-frames:v", "1", "-vf", "scale=48:27", "-pix_fmt", "rgb24", "-f", "rawvideo", tmp]);
    const raw = fs.readFileSync(tmp);
    let sumL = 0;
    let text = 0;
    let accent = 0;
    const bgBucket = new Map<number, { n: number; r: number; g: number; b: number }>();
    const px = 48 * 27;
    for (let i = 0; i < px; i++) {
      const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sumL += L;
      if (L > 100) text++; // calibrated: at 48x27 downscale, text cells peak 125-176 (see tests/golden)
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      if (sat > 0.3 && L > 50 && L < 220) accent++;
      if (L < 90) {
        const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
        const c = bgBucket.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        c.n++; c.r += r; c.g += g; c.b += b;
        bgBucket.set(key, c);
      }
    }
    const bg = [...bgBucket.values()].sort((a, b) => b.n - a.n)[0];
    const background = bg
      ? `#${[bg.r / bg.n, bg.g / bg.n, bg.b / bg.n].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`
      : "#000000";
    return {
      meanLuma: Number((sumL / px).toFixed(1)),
      textPixelShare: Number((text / px).toFixed(4)),
      accentPixelShare: Number((accent / px).toFixed(4)),
      background,
    };
  } catch {
    return null;
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

/** Fold rendered-frame stats into scene scores (dark bg + visible text + restrained accents). */
export function applyFrameStats(conformance: SceneConformance, stats: FrameStats): SceneConformance {
  const scores = { ...conformance.scores };
  const evidence = [...conformance.evidence];
  if (stats.meanLuma >= 60) {
    const penalty = Math.min(6, (stats.meanLuma - 60) / 12);
    scores.visualStyle = clamp(scores.visualStyle - penalty);
    evidence.push(`frame meanLuma ${stats.meanLuma} >= 60 (reference is near-black)`);
  }
  if (stats.textPixelShare < 0.005) {
    scores.typography = clamp(scores.typography - 3);
    evidence.push("almost no bright text pixels in frame");
  } else if (stats.textPixelShare > 0.35) {
    scores.negativeSpace = clamp(scores.negativeSpace - 3);
    evidence.push(`text/bright share ${(stats.textPixelShare * 100).toFixed(1)}% (reference keeps 60-70% empty)`);
  }
  if (stats.accentPixelShare > 0.3) {
    scores.color = clamp(scores.color - 3);
    evidence.push(`accent share ${(stats.accentPixelShare * 100).toFixed(1)}% too high (accents are restrained)`);
  }
  const overall = Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / 7 * 10) / 10;
  return { sceneId: conformance.sceneId, scores, overall, evidence };
}

/** Runs the full conformance pass for a project and persists qa/conformance.json. */
export async function runConformance(
  projectId: string,
  scenes: SceneSpec[],
  frameFiles: Map<string, string>,
): Promise<ConformanceReport> {
  markStage(projectId, "conformance", "running");
  const results: SceneConformance[] = [];
  for (const scene of scenes) {
    let conf = conformanceScores(scene);
    const frame = frameFiles.get(scene.sceneId);
    if (frame && fs.existsSync(frame)) {
      const stats = await frameStats(frame);
      if (stats) conf = applyFrameStats(conf, stats);
    }
    results.push(conf);
  }
  const overall = round1(results.reduce((a, r) => a + r.overall, 0) / Math.max(1, results.length));
  const report: ConformanceReport = {
    scenes: results,
    overall,
    method: "structural checks against reference-derived design tokens + rendered-frame luma/text/accent stats (no pixel similarity)",
  };
  writeJson(projectId, "qa/conformance.json", report);
  markStage(projectId, "conformance", overall >= 6 ? "done" : "failed");
  return report;
}
