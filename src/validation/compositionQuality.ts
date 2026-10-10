import { sceneRenderedGeometry } from "../scenes/rendererGeometry";
import { FRAME, frameRect, rectIntersection } from "../scenes/bounds";
import { expectedBands, bandOf, VISUAL_GATES } from "./visualGates";
import type { SceneSpec } from "./schema";
import type { FrameEvidenceReport } from "../render/frameEvidence";

/**
 * COMPOSITION QUALITY (Batch G / WS-A).
 *
 * Deterministic, evidence-driven findings about what the composition actually puts on
 * screen - NOT a score and NOT a new hard gate. Hard gates stay in layoutGate /
 * visualGates / semanticEnactment; this module produces targeted, actionable REASONS
 * that repair and the judges can use:
 *
 *   1. per-band table: model-predicted semantic objects vs measured occupancy (from the
 *      rendered frames) - separates "object missing/invisible" from "intentional space";
 *   2. meaningful size: a semantic object the model paints but whose predicted area is
 *      too small to read on a phone is flagged BEFORE the render;
 *   3. text vs object split (model-predicted areas) + measured total - the architecture
 *      measures total ink only, so the split is honestly labelled as model-predicted;
 *   4. progression: consecutive scenes with an identical composition signature (grammar
 *      + primitive@position multiset) are flagged - beats must not repeat a still;
 *   5. headline presence: a bound headline semantic object that the model paints fully
 *      outside the frame (the scene_01 defect) is called out by name.
 *
 * Deterministic rules only, no LLM. `ok` is always true: these findings steer repair,
 * they never block a render on their own.
 */

/** Semantic objects the model paints smaller than this cannot be read (px^2). */
export const COMPOSITION = {
  /** predicted painted area below which a semantic object is "too small to read" */
  minReadableObjectAreaPx2: 2200,
  /** share of frame the LARGEST semantic object must cover to carry the scene */
  minDominantObjectShare: 0.002,
} as const;

export interface BandCompositionRow {
  band: "top" | "middle" | "bottom";
  /** model-predicted non-text semantic objects in this band */
  predictedObjects: number;
  ids: string[];
  /** measured occupancy of this band across sampled frames (null = no evidence) */
  measuredOccupancy: number | null;
}

export interface ObjectCompositionRow {
  id: string;
  primitive: string;
  /** predicted painted area (px^2) and share of frame */
  areaPx2: number;
  share: number;
  band: "top" | "middle" | "bottom";
  /** true when the predicted box has zero frame intersection */
  offScreen: boolean;
  tooSmall: boolean;
}

export interface SceneCompositionQuality {
  sceneId: string;
  composition: string;
  /** stable signature: grammar + sorted primitive@position multiset */
  signature: string;
  identicalToPrevious: boolean;
  headline: { present: boolean; semanticId: string | null; offScreen: boolean } | null;
  semanticObjects: ObjectCompositionRow[];
  bands: BandCompositionRow[];
  /** model-predicted ink split (px^2) - NOT a measured split */
  predictedTextInkPx2: number;
  predictedObjectInkPx2: number;
  /** measured total occupancy across frames (null = no evidence) */
  measuredOccupancy: number | null;
  /** actionable, targeted reasons for repair / judges */
  reasons: string[];
}

export interface CompositionQualityReport {
  schema: "composition-quality/1";
  generatedAt: string;
  scenes: SceneCompositionQuality[];
  warnings: string[];
}

const signatureOf = (scene: SceneSpec): string => {
  const parts = (scene.elements ?? []).map((e) => `${e.primitive}@${e.position ?? "center"}`);
  return `${scene.composition}|${parts.sort().join(",")}`;
};

const area = (r: { x0: number; y0: number; x1: number; y1: number }): number =>
  Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);

const frameArea = FRAME.width * FRAME.height;

export function compositionQualityFinding(
  scene: SceneSpec,
  previous: { composition: string; signature: string } | null,
  evidence: FrameEvidenceReport | null,
): SceneCompositionQuality {
  const geo = sceneRenderedGeometry(scene);
  const frame = frameRect();
  const reasons: string[] = [];

  const semanticObjects: ObjectCompositionRow[] = [];
  let predictedTextInkPx2 = 0;
  let predictedObjectInkPx2 = 0;
  for (const item of geo.items) {
    const a = area(item.rendered);
    if (item.isText) {
      predictedTextInkPx2 += a;
      continue;
    }
    predictedObjectInkPx2 += a;
    if (item.role === "decorative") continue;
    const offScreen = rectIntersection(item.rendered, frame) === null;
    const tooSmall = !offScreen && a < COMPOSITION.minReadableObjectAreaPx2;
    semanticObjects.push({
      id: item.id,
      primitive: item.primitive,
      areaPx2: Math.round(a),
      share: a / frameArea,
      band: bandOf((item.rendered.y0 + item.rendered.y1) / 2),
      offScreen,
      tooSmall,
    });
    if (tooSmall) {
      reasons.push(
        `semantic object "${item.id}" (${item.primitive}) paints only ${Math.round(a)}px² (< ${COMPOSITION.minReadableObjectAreaPx2}px²) - increase its scale/size so it can be read`,
      );
    }
  }

  // band table: model prediction vs measured occupancy
  const rollup = evidence?.sceneRollup.find((r) => r.sceneId === scene.sceneId) ?? null;
  const predicted = expectedBands(scene);
  const bands: BandCompositionRow[] = (["top", "middle", "bottom"] as const).map((band) => {
    const row = predicted.find((p) => p.band === band);
    return {
      band,
      predictedObjects: row?.count ?? 0,
      ids: row?.ids ?? [],
      measuredOccupancy: rollup ? rollupRegion(rollup, band) : null,
    };
  });

  // headline: bound id + off-screen detection (the scene_01 live defect)
  let headline: SceneCompositionQuality["headline"] = null;
  if (scene.headline) {
    const boundId = scene.headline.semanticId ?? null;
    const headlineItem = geo.items.find((i) => i.primitive === "Headline");
    const offScreen = headlineItem ? rectIntersection(headlineItem.rendered, frame) === null : false;
    headline = { present: true, semanticId: boundId, offScreen };
    if (boundId && offScreen) {
      reasons.push(
        `headline "${boundId}" is bound but its model box lies entirely outside the frame - it will never be seen; pull offsetY back toward 0 or move the headline to a wide anchor`,
      );
    }
  }

  // dominant semantic object too small to carry the scene
  const visibleObjects = semanticObjects.filter((o) => !o.offScreen);
  if (visibleObjects.length > 0) {
    const dominant = visibleObjects.reduce((a, b) => (b.share > a.share ? b : a));
    if (dominant.share < COMPOSITION.minDominantObjectShare) {
      reasons.push(
        `largest semantic object "${dominant.id}" covers only ${(dominant.share * 100).toFixed(2)}% of the frame - the composition has no dominant visual; enlarge the main object`,
      );
    }
  }

  // progression: identical stills across beats
  const signature = signatureOf(scene);
  const identicalToPrevious =
    previous !== null &&
    previous.composition === scene.composition &&
    previous.signature === signature;
  if (identicalToPrevious) {
    reasons.push(
      `this beat repeats the previous beat's composition identically (${scene.composition} + same object placement) - vary the composition grammar or object positions so successive beats progress`,
    );
  }

  const measuredOccupancy = rollupOccupancy(rollup);
  return {
    sceneId: scene.sceneId,
    composition: scene.composition,
    signature,
    identicalToPrevious,
    headline,
    semanticObjects,
    bands,
    predictedTextInkPx2: Math.round(predictedTextInkPx2),
    predictedObjectInkPx2: Math.round(predictedObjectInkPx2),
    measuredOccupancy,
    reasons,
  };
}

function rollupRegion(
  rollup: FrameEvidenceReport["sceneRollup"][number],
  band: "top" | "middle" | "bottom",
): number | null {
  const r = (rollup as { regionOccupancy?: { top: number; middle: number; bottom: number } }).regionOccupancy;
  return r ? r[band] : null;
}

function rollupOccupancy(rollup: FrameEvidenceReport["sceneRollup"][number] | null): number | null {
  if (!rollup) return null;
  const r = rollup as { maxOccupancy?: number; minOccupancy?: number };
  return typeof r.maxOccupancy === "number" ? r.maxOccupancy : (r.minOccupancy ?? null);
}

export function evaluateCompositionQuality(
  scenes: SceneSpec[],
  evidence: FrameEvidenceReport | null,
): CompositionQualityReport {
  const rows: SceneCompositionQuality[] = [];
  let previous: { composition: string; signature: string } | null = null;
  for (const scene of scenes) {
    const row = compositionQualityFinding(scene, previous, evidence);
    rows.push(row);
    previous = { composition: row.composition, signature: row.signature };
  }
  return {
    schema: "composition-quality/1",
    generatedAt: new Date().toISOString(),
    scenes: rows,
    warnings: rows.flatMap((r) => r.reasons.map((reason) => `${r.sceneId}: ${reason}`)),
  };
}

export const summarizeCompositionQuality = (r: CompositionQualityReport): string =>
  `composition-quality: ${r.warnings.length} warning(s) across ${r.scenes.length} scene(s)`;
