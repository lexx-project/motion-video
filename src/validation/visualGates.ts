import { sceneRenderedGeometry } from "../scenes/rendererGeometry";
import { FRAME, frameRect, rectIntersection, rectUnion, type Rect } from "../scenes/bounds";
import type { SceneSpec } from "./schema";
import type { FrameEvidenceReport, FrameMetrics } from "../render/frameEvidence";
import { isStaleEvidence } from "./layoutGate";

/**
 * Readability + empty-scene evidence (Batch B / B3 + B4).
 *
 * Principle: element count is NOT visual richness. These gates compare what the scene JSON
 * says must be visible (non-text semantic objects and where the renderer places them) with
 * what the rendered frames actually contain (occupancy per region, brightness, motion).
 *
 * Occupancy here is EVIDENCE, not aesthetics: a scene is only called empty when the model
 * predicts visible objects in a region and the rendered pixels show (almost) nothing there.
 * Deliberately sparse typography-only scenes are recognised as such and are never punished.
 *
 * Calibration (Phase-3 E2E, 6 scenes x 6 samples, see Batch A/B reports):
 *   band occupancy of every EXPECTED band in a healthy scene >= 0.0128
 *   scene_04's "record" band (3+ Line objects expected) = 0.0005 .. 0.0029  <- the known failure
 *   bright share healthy range 0.029 .. 0.058 (a scene with readable text never lands near 0)
 */

export type Band = "top" | "middle" | "bottom";

/** Region splits - MUST match `regionOccupancy` computed in render/frameEvidence.ts. */
export const BAND_SPLITS = { top: 0.35, middle: 0.75 } as const;

export const VISUAL_GATES = {
  /** band occupancy floor for a band the model says must carry visible objects */
  bandOccupancyFloor: 0.005,
  /** a scene that declares many elements but has almost no ink anywhere */
  overallOccupancyFloor: 0.01,
  /** bright (L>120) share below this: nothing readable on screen */
  brightShareFloor: 0.003,
  /** caption band ink while captions are enabled */
  subtitleOccupancyFloor: 0.001,
  /** no measurable change between sampled frames */
  motionDeltaFloor: 0.0004,
  /** headline painted smaller than this is not readable on a phone */
  headlineMinHeightPx: 40,
  /** any text block painted below the design system's smallest type tier (label.min = 26px) */
  minTextPaintPx: 26,
  /** below this a text block cannot be read at all */
  unreadableTextPx: 20,
  /** minimum painted area for a non-text object to count as "should be visible" */
  minExpectedAreaPx: 300,
  /** expected visible objects in one band before an empty band becomes a hard failure */
  minExpectedBoxesToFail: 2,
} as const;

export type GateStatus = "ok" | "suspicious" | "fail";

export interface BandEvidence {
  band: Band;
  /** non-text, non-decorative objects the renderer places in this band */
  expectedBoxes: number;
  /** highest occupancy measured for this band across the sampled frames */
  occupancy: number;
  expected: boolean;
}

export interface EmptySceneFinding {
  sceneId: string;
  status: GateStatus;
  reason: string;
  occupancy: number | null;
  contentBBox: Rect | null;
  motionDelta: number | null;
  regionOccupancy: { top: number; middle: number; bottom: number; subtitleBand: number } | null;
  bands: BandEvidence[];
}

export interface ReadabilityFinding {
  sceneId: string;
  status: GateStatus;
  reasons: string[];
  brightShare: number | null;
  headlineHeightPx: number | null;
  /** smallest painted text block (px tall) - readability floor input */
  smallestTextHeightPx: number | null;
  subtitleBandOccupancy: number | null;
}

export interface VisualGateReport {
  schema: "visual-gates/1";
  generatedAt: string;
  scenes: { sceneId: string; empty: EmptySceneFinding; readability: ReadabilityFinding }[];
  hard: string[];
  warnings: string[];
  ok: boolean;
}

interface SampleSummary {
  sampleCount: number;
  maxOccupancy: number;
  maxBrightShare: number;
  maxRegion: { top: number; middle: number; bottom: number; subtitleBand: number };
  maxEdgeInk: number;
  contentBox: Rect | null;
  motionDelta: number | null;
}

const worse = (a: number, b: number): number => Math.max(a, b);

/** Worst-case-but-fair summary: the highest value any sampled frame reached for this scene. */
function summarizeSamples(report: FrameEvidenceReport, sceneId: string): SampleSummary | null {
  const samples = report.samples.filter((s) => s.sceneId === sceneId && s.metrics);
  const rollup = report.sceneRollup.find((r) => r.sceneId === sceneId);
  if (samples.length === 0) return null;
  const metrics = samples.map((s) => s.metrics as FrameMetrics);
  const summary: SampleSummary = {
    sampleCount: samples.length,
    maxOccupancy: Math.max(...metrics.map((m) => m.occupancy)),
    maxBrightShare: Math.max(...metrics.map((m) => m.brightShare)),
    maxRegion: {
      top: Math.max(...metrics.map((m) => m.regionOccupancy.top)),
      middle: Math.max(...metrics.map((m) => m.regionOccupancy.middle)),
      bottom: Math.max(...metrics.map((m) => m.regionOccupancy.bottom)),
      subtitleBand: Math.max(...metrics.map((m) => m.regionOccupancy.subtitleBand)),
    },
    maxEdgeInk: Math.max(...metrics.map((m) => Math.max(m.edgeInk.left, m.edgeInk.right, m.edgeInk.top, m.edgeInk.bottom))),
    contentBox: rectUnion(metrics.map((m) => m.contentBox).filter((b): b is Rect => Boolean(b))),
    motionDelta: rollup ? rollup.motionDelta : null,
  };
  return summary;
}

export const bandOf = (centreY: number, canvasHeight = 1920): Band =>
  centreY < canvasHeight * BAND_SPLITS.top
    ? "top"
    : centreY < canvasHeight * BAND_SPLITS.middle
      ? "middle"
      : "bottom";

/** Bands the model says must carry visible non-text content, with counts. */
export function expectedBands(scene: SceneSpec): { band: Band; count: number; ids: string[] }[] {
  const geo = sceneRenderedGeometry(scene);
  const frame = frameRect(FRAME);
  const byBand = new Map<Band, string[]>();
  for (const item of geo.items) {
    if (item.isText) continue;
    if (item.role === "decorative") continue;
    // Batch G (WS-B): an item entirely outside the frame can never be visible in any
    // band - counting it would manufacture a false "expected content" signal.
    if (rectIntersection(item.rendered, frame) === null) continue;
    const area = (item.rendered.x1 - item.rendered.x0) * (item.rendered.y1 - item.rendered.y0);
    if (!Number.isFinite(area) || area < VISUAL_GATES.minExpectedAreaPx) continue;
    const centreY = (item.rendered.y0 + item.rendered.y1) / 2;
    const band = bandOf(centreY, geo.canvas.height);
    const list = byBand.get(band);
    if (list) list.push(item.id);
    else byBand.set(band, [item.id]);
  }
  return [...byBand.entries()].map(([band, ids]) => ({ band, count: ids.length, ids }));
}

/** True when the scene declares visible non-text objects (i.e. emptiness would be accidental). */
export function expectsVisualObjects(scene: SceneSpec): boolean {
  return expectedBands(scene).length > 0;
}

export function emptySceneFinding(scene: SceneSpec, evidence: FrameEvidenceReport | null): EmptySceneFinding {
  const bands = expectedBands(scene).map((b): BandEvidence => ({
    band: b.band,
    expectedBoxes: b.count,
    occupancy: 0,
    expected: true,
  }));
  const summary = evidence ? summarizeSamples(evidence, scene.sceneId) : null;
  const occupancy = summary ? summary.maxOccupancy : null;
  const contentBox = summary ? summary.contentBox : null;
  const motionDelta = summary ? summary.motionDelta : null;
  const region = summary ? summary.maxRegion : null;

  const base = {
    sceneId: scene.sceneId,
    occupancy,
    contentBBox: contentBox,
    motionDelta,
    regionOccupancy: region,
    bands,
  };

  const elementCount = scene.elements?.length ?? 0;

  // No non-text objects at all -> typography-driven scene: sparse is intentional.
  if (bands.length === 0) {
    return {
      ...base,
      status: "ok",
      reason: `intentional sparse: no non-text semantic objects (typography/composition carries the meaning); occupancy=${occupancy ?? "n/a"}`,
    };
  }

  if (!summary) {
    return { ...base, status: "ok", reason: "no frame evidence available - emptiness not evaluated" };
  }

  for (const b of bands) {
    b.occupancy = region ? region[b.band] : 0;
  }

  const failing = bands.filter((b) => b.expectedBoxes >= VISUAL_GATES.minExpectedBoxesToFail && b.occupancy < VISUAL_GATES.bandOccupancyFloor);
  const thin = bands.filter((b) => b.expectedBoxes === 1 && b.occupancy < VISUAL_GATES.bandOccupancyFloor);

  if (failing.length > 0) {
    const b = failing[0];
    return {
      ...base,
      status: "fail",
      reason:
        `accidentally empty: ${b.expectedBoxes} non-text objects are placed in the ${b.band} band but its rendered occupancy is ` +
        `${(b.occupancy * 100).toFixed(3)}% (< ${VISUAL_GATES.bandOccupancyFloor * 100}%) across ${summary.sampleCount} sampled frames`,
    };
  }
  if (thin.length > 0) {
    const b = thin[0];
    return {
      ...base,
      status: "suspicious",
      reason: `thin content: 1 object expected in the ${b.band} band but occupancy is ${(b.occupancy * 100).toFixed(3)}%`,
    };
  }
  if (occupancy !== null && occupancy < VISUAL_GATES.overallOccupancyFloor && elementCount >= 3) {
    return {
      ...base,
      status: "suspicious",
      reason: `content JSON has ${elementCount} elements but whole-frame occupancy is ${(occupancy * 100).toFixed(2)}%`,
    };
  }
  return {
    ...base,
    status: "ok",
    reason: `all expected bands carry visible content (occupancy ${((occupancy ?? 0) * 100).toFixed(2)}%)`,
  };
}

export function readabilityFinding(scene: SceneSpec, evidence: FrameEvidenceReport | null): ReadabilityFinding {
  const summary = evidence ? summarizeSamples(evidence, scene.sceneId) : null;
  const hasText = Boolean(scene.headline) || (scene.elements ?? []).some((e) => typeof e.text === "string" && e.text.trim().length > 0);
  const reasons: string[] = [];

  const geo = sceneRenderedGeometry(scene);
  const headline = geo.items.find((i) => i.primitive === "Headline");
  const headlineHeightPx = headline ? headline.rendered.y1 - headline.rendered.y0 : null;
  const textItems = geo.items.filter((i) => i.isText);
  const smallestTextPx = textItems.length
    ? Math.min(...textItems.map((i) => i.rendered.y1 - i.rendered.y0))
    : null;

  let status: GateStatus = "ok";

  if (summary && hasText) {
    if (summary.maxBrightShare < VISUAL_GATES.brightShareFloor) {
      status = "fail";
      reasons.push(
        `text effectively invisible: brightest sample has only ${(summary.maxBrightShare * 100).toFixed(3)}% bright pixels`,
      );
    }
  }
  for (const item of textItems) {
    const painted = item.rendered.y1 - item.rendered.y0;
    if (painted < VISUAL_GATES.unreadableTextPx) {
      status = "fail";
      reasons.push(`"${item.id}" paints ${Math.round(painted)}px tall - unreadable`);
    } else if (painted < VISUAL_GATES.minTextPaintPx) {
      if (status === "ok") status = "suspicious";
      reasons.push(`"${item.id}" paints only ${Math.round(painted)}px tall (below the ${VISUAL_GATES.minTextPaintPx}px floor)`);
    }
  }
  if (headlineHeightPx !== null && headlineHeightPx < VISUAL_GATES.headlineMinHeightPx) {
    if (status === "ok") status = "suspicious";
    reasons.push(`headline painted only ${Math.round(headlineHeightPx)}px tall`);
  }
  if (scene.subtitle?.enabled && summary && summary.maxRegion.subtitleBand < VISUAL_GATES.subtitleOccupancyFloor) {
    if (status === "ok") status = "suspicious";
    reasons.push(
      `captions enabled but the caption band holds ${(summary.maxRegion.subtitleBand * 100).toFixed(3)}% ink`,
    );
  }
  if (summary && summary.motionDelta !== null && summary.motionDelta < VISUAL_GATES.motionDeltaFloor) {
    if (status === "ok") status = "suspicious";
    reasons.push(`no measurable motion across samples (delta ${summary.motionDelta})`);
  }

  return {
    sceneId: scene.sceneId,
    status,
    reasons,
    brightShare: summary ? summary.maxBrightShare : null,
    headlineHeightPx,
    smallestTextHeightPx: smallestTextPx,
    subtitleBandOccupancy: summary ? summary.maxRegion.subtitleBand : null,
  };
}

export function evaluateVisualGates(
  scenes: SceneSpec[],
  evidence: FrameEvidenceReport | null,
): VisualGateReport {
  const rows: VisualGateReport["scenes"] = [];
  const hard: string[] = [];
  const warnings: string[] = [];
  // Batch G (WS-B): stale evidence is rejected - pixels from a different scene state
  // must never decide a visual verdict.
  const stale = isStaleEvidence(evidence, scenes);
  const usable = stale ? null : evidence;
  if (stale) {
    warnings.push(
      "visual-gates: STALE EVIDENCE REJECTED - frame evidence scenesHash does not match the current scenes; rendered metrics not used",
    );
  }

  for (const scene of scenes) {
    const empty = emptySceneFinding(scene, usable);
    const readability = readabilityFinding(scene, usable);
    rows.push({ sceneId: scene.sceneId, empty, readability });

    if (empty.status === "fail") hard.push(`${scene.sceneId}: ${empty.reason}`);
    else if (empty.status === "suspicious") warnings.push(`${scene.sceneId}: ${empty.reason}`);

    if (readability.status === "fail") hard.push(`${scene.sceneId}: ${readability.reasons.join("; ")}`);
    else if (readability.status === "suspicious") warnings.push(`${scene.sceneId}: ${readability.reasons.join("; ")}`);
  }

  return {
    schema: "visual-gates/1",
    generatedAt: new Date().toISOString(),
    scenes: rows,
    hard,
    warnings,
    ok: hard.length === 0,
  };
}

export const summarizeVisualGates = (r: VisualGateReport): string =>
  `visual-gates ${r.ok ? "ok" : "FAIL"}: ${r.hard.length} hard, ${r.warnings.length} warnings`;
