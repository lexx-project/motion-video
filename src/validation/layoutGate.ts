import { sceneRenderedGeometry, ensureSceneTextMetrics, ensureTextMetricsForScenes, type SceneGeometry } from "../scenes/rendererGeometry";
import { FRAME, frameRect, frameOverflow, safeAreaOverflow, rectIntersection, rectUnion, roundRect, type Rect } from "../scenes/bounds";
import type { SceneSpec } from "./schema";
import type { FrameEvidenceReport, FrameMetrics } from "../render/frameEvidence";
import { scenesFingerprint } from "../core/identity";

/**
 * Deterministic layout gate (Batch B / B2 + B7).
 *
 * Two independent representations are compared for every scene:
 *   - MODEL   : renderer-aware geometry (layout -> transform -> AABB)
 *   - RENDERED: Batch A pixel evidence from the actual rendered stills
 *
 * Agreement states: "both" | "model-only" | "rendered-only" | "neither".
 * A disagreement is itself diagnostic evidence - it never gets silently averaged away, and
 * rendered pixels always win for "did this actually leave the frame".
 *
 * Hard failures are limited to objective problems (B7):
 *   1. rendered content reaching the frame edge (clipping - measured),
 *   2. model-predicted overflow past the frame edge beyond a visible margin (predicted clipping),
 *   3. severe safe-area crossing (>= half of the 86.4px horizontal margin).
 * Everything else (mild safe-area crossings, model/pixel disagreement) is reported as a warning
 * so it can steer repair without failing an otherwise correct render.
 *
 * Calibration (measured on the Phase-3 E2E, see docs/AUTONOMOUS_AUDIT.md and Batch A report):
 *   scene_03: model predicted right overflow 38px, pixels showed 419 edge-ink px + clipped bbox
 *   scene_01: model predicted safe-area overflow 26.4px, pixels measured 28px  (agreement)
 *   scene_04/05/06: both representations report no frame violation
 */

export type Agreement = "both" | "model-only" | "rendered-only" | "neither";

export interface LayoutViolation {
  id: string;
  side: "left" | "right" | "top" | "bottom";
  px: number;
}

export interface ModelEvidence {
  frameViolations: LayoutViolation[];
  safeAreaViolations: LayoutViolation[];
  contentBox: Rect | null;
  contentBoxRounded: Rect | null;
  sources: string[];
}

export interface RenderedEvidence {
  available: boolean;
  edgeInk: { left: number; right: number; top: number; bottom: number };
  contentOutsideFrame: boolean;
  safeAreaOverflowPx: { left: number; top: number; right: number; bottom: number };
  contentBox: Rect | null;
}

export interface LayoutFinding {
  sceneId: string;
  model: ModelEvidence;
  rendered: RenderedEvidence | null;
  agreement: { frame: Agreement; safeArea: Agreement };
  /** Batch G (WS-B): model-predicted elements with ZERO frame intersection (never visible). */
  invisible?: string[];
  hard: string[];
  warnings: string[];
  /** one line per scene for logs/diagnostics */
  summary: string;
}

export interface LayoutGateReport {
  schema: "layout-gate/1";
  generatedAt: string;
  findings: LayoutFinding[];
  hard: string[];
  warnings: string[];
  ok: boolean;
  /** model vs rendered: how many scenes disagreed */
  disagreements: number;
}

/** Objective thresholds - calibrated against rendered evidence, never tuned per scene. */
export const LAYOUT_GATES = {
  /** predicted overflow beyond the frame edge that is certainly visible */
  modelFrameClipPx: 8,
  /** ink counted in the 12px edge band (analysis scale) before we call it clipping */
  renderedFrameClipInk: 10,
  /** safe-area crossing severe enough to be an objective failure (half the 86.4px margin) */
  safeAreaSeverePx: 48,
} as const;

const SIDES = ["left", "right", "top", "bottom"] as const;
type Side = (typeof SIDES)[number];

const maxPx = (v: Record<Side, number>): number => Math.max(v.left, v.right, v.top, v.bottom);
const sideOf = (v: Record<Side, number>): Side =>
  SIDES.reduce((best, s) => (v[s] > v[best] ? s : best), "left");

function modelViolations(box: Rect, kind: "frame" | "safeArea"): { side: Side; px: number }[] {
  const o = kind === "frame" ? frameOverflow(box, FRAME) : safeAreaOverflow(box, FRAME);
  if (!o.outside) return [];
  return SIDES.filter((s) => o[s] > 0.5).map((s) => ({ side: s, px: Math.round(o[s]) }));
}

function agreement(modelHit: boolean, renderedHit: boolean): Agreement {
  if (modelHit && renderedHit) return "both";
  if (modelHit) return "model-only";
  if (renderedHit) return "rendered-only";
  return "neither";
}

/** Sync core: geometry (already measured) + optional rendered metrics -> finding. */
export function layoutFinding(scene: SceneSpec, geometry: SceneGeometry, rendered?: FrameMetrics | null): LayoutFinding {
  const frameViolations: LayoutViolation[] = [];
  const safeAreaViolations: LayoutViolation[] = [];
  /** Batch G (WS-B): items whose rendered box has ZERO frame intersection. */
  const invisible: string[] = [];
  for (const item of geometry.items) {
    if (rectIntersection(item.rendered, frameRect()) === null) {
      // entirely outside the frame: pixels can never confirm edge ink, so this is
      // not a model/pixel disagreement - it is a predicted INVISIBLE element.
      invisible.push(item.id);
      continue;
    }
    for (const v of modelViolations(item.rendered, "frame")) {
      frameViolations.push({ id: item.id, side: v.side, px: v.px });
    }
    for (const v of modelViolations(item.rendered, "safeArea")) {
      safeAreaViolations.push({ id: item.id, side: v.side, px: v.px });
    }
  }

  const model: ModelEvidence = {
    frameViolations,
    safeAreaViolations,
    contentBox: geometry.contentBox,
    contentBoxRounded: geometry.contentBox ? roundRect(geometry.contentBox) : null,
    sources: geometry.sources,
  };

  const renderedEvidence: RenderedEvidence | null = rendered
    ? {
        available: true,
        edgeInk: rendered.edgeInk,
        contentOutsideFrame: rendered.contentOutsideFrame,
        safeAreaOverflowPx: {
          left: rendered.safeAreaOverflow.left,
          top: rendered.safeAreaOverflow.top,
          right: rendered.safeAreaOverflow.right,
          bottom: rendered.safeAreaOverflow.bottom,
        },
        contentBox: rendered.contentBox,
      }
    : null;

  const modelFrameHit = frameViolations.length > 0;
  const modelFrameSevere = frameViolations.some((v) => v.px >= LAYOUT_GATES.modelFrameClipPx);
  const renderedFrameHit = Boolean(
    rendered && rendered.contentOutsideFrame && maxPx(rendered.edgeInk) >= LAYOUT_GATES.renderedFrameClipInk,
  );
  const renderedSafeSevere = Boolean(rendered && maxPx(rendered.safeAreaOverflow) >= LAYOUT_GATES.safeAreaSeverePx);
  const modelSafeSevere = safeAreaViolations.some((v) => v.px >= LAYOUT_GATES.safeAreaSeverePx);

  const hard: string[] = [];
  const warnings: string[] = [];

  if (invisible.length > 0) {
    hard.push(
      `${scene.sceneId}: MODEL invisible - ${invisible.map((id) => `"${id}"`).join(", ")} render${invisible.length === 1 ? "s" : ""} entirely outside the frame (never visible on screen)`,
    );
  }
  if (renderedFrameHit) {
    const side = sideOf(rendered!.edgeInk);
    hard.push(
      `${scene.sceneId}: RENDERED clipping - ${rendered!.edgeInk[side]} edge-ink px on the ${side} edge (content box reaches the frame)`,
    );
  }
  if (modelFrameSevere) {
    const worst = frameViolations.reduce((a, b) => (b.px > a.px ? b : a));
    hard.push(
      `${scene.sceneId}: MODEL clipping - "${worst.id}" overflows the ${worst.side} frame edge by ${worst.px}px after transform`,
    );
  }
  if (renderedSafeSevere) {
    const worstSide = sideOf(rendered!.safeAreaOverflow);
    hard.push(
      `${scene.sceneId}: RENDERED severe safe-area violation - ${rendered!.safeAreaOverflow[worstSide]}px past the ${worstSide} safe margin`,
    );
  }
  if (modelSafeSevere && !hard.some((h) => h.includes("MODEL clipping"))) {
    const worst = safeAreaViolations.reduce((a, b) => (b.px > a.px ? b : a));
    hard.push(
      `${scene.sceneId}: MODEL severe safe-area violation - "${worst.id}" crosses the ${worst.side} safe margin by ${worst.px}px`,
    );
  }

  // warnings: mild crossings + partial-overflow disagreement (evidence for repair, not a failure).
  // Invisible elements are EXCLUDED from the disagreement count: pixels showing no edge ink
  // CONFIRMS invisibility, it does not contradict the model.
  if (rendered && rendered.contentOutsideFrame && !modelFrameHit && invisible.length === 0) {
    warnings.push(
      `${scene.sceneId}: MODEL MISS - the rendered frame clips at the frame edge (${maxPx(rendered.edgeInk)} ink px) but the model predicts none - verify measurement`,
    );
  }
  if (!renderedFrameHit && modelFrameHit && !modelFrameSevere) {
    warnings.push(
      `${scene.sceneId}: model predicts a small frame overflow (${frameViolations.map((v) => `${v.id} ${v.side} ${v.px}px`).join("; ")}) that pixels do not confirm - verify measurement`,
    );
  }
  for (const v of safeAreaViolations) {
    if (v.px < LAYOUT_GATES.safeAreaSeverePx) {
      warnings.push(`${scene.sceneId}: model safe-area crossing ${v.px}px on ${v.side} ("${v.id}")`);
    }
  }
  if (rendered) {
    const renderedSafeMax = maxPx(rendered.safeAreaOverflow);
    if (renderedSafeMax > 0 && renderedSafeMax < LAYOUT_GATES.safeAreaSeverePx) {
      warnings.push(
        `${scene.sceneId}: rendered safe-area crossing ${renderedSafeMax}px on ${sideOf(rendered.safeAreaOverflow)}`,
      );
    }
    if (rendered.contentOutsideFrame && !renderedFrameHit) {
      warnings.push(`${scene.sceneId}: content box touches the frame edge but edge ink is below the clipping threshold`);
    }
    if (!modelFrameHit && !renderedFrameHit && renderedSafeMax > 0 && maxPx(toRecord(safeAreaViolations)) === 0) {
      warnings.push(
        `${scene.sceneId}: RENDERED-ONLY safe-area crossing (${renderedSafeMax}px) - the model did not predict it`,
      );
    }
  }

  const frameAgreement = agreement(modelFrameHit, rendered ? rendered.contentOutsideFrame : false);
  const safeAgreement = agreement(
    safeAreaViolations.length > 0,
    Boolean(rendered && maxPx(rendered.safeAreaOverflow) > 0),
  );

  const summaryParts = [
    `modelFrame=${frameViolations.length}`,
    `modelSafe=${safeAreaViolations.length}`,
    invisible.length > 0 ? `invisible=${invisible.length}` : "",
    rendered ? `renderedEdgeInk=${maxPx(rendered.edgeInk)}` : "rendered=n/a",
    rendered ? `renderedSafe=${maxPx(rendered.safeAreaOverflow)}` : "",
    `frameAgree=${frameAgreement}`,
    `safeAgree=${safeAgreement}`,
    `hard=${hard.length}`,
  ].filter(Boolean);

  return {
    sceneId: scene.sceneId,
    model,
    rendered: renderedEvidence,
    agreement: { frame: frameAgreement, safeArea: safeAgreement },
    invisible,
    hard,
    warnings,
    summary: summaryParts.join(" "),
  };
}

const toRecord = (list: LayoutViolation[]): Record<Side, number> => {
  const out: Record<Side, number> = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const v of list) out[v.side] = Math.max(out[v.side], v.px);
  return out;
};

/** Worst metrics across every sampled frame of a scene (conservative - clipping is per-frame). */
export function worstMetricsForScene(report: FrameEvidenceReport, sceneId: string): FrameMetrics | null {
  const samples = report.samples.filter((s) => s.sceneId === sceneId && s.metrics);
  if (samples.length === 0) return null;
  const metrics = samples.map((s) => s.metrics as FrameMetrics);
  const pick = metrics.reduce((a, b) =>
    Math.max(a.edgeInk.left, a.edgeInk.right, a.edgeInk.top, a.edgeInk.bottom) >=
    Math.max(b.edgeInk.left, b.edgeInk.right, b.edgeInk.top, b.edgeInk.bottom)
      ? a
      : b,
  );
  // merge conservative signals: worst edge ink, worst safe overflow, any frame contact
  const merged: FrameMetrics = { ...pick };
  merged.edgeInk = {
    left: Math.max(...metrics.map((m) => m.edgeInk.left)),
    right: Math.max(...metrics.map((m) => m.edgeInk.right)),
    top: Math.max(...metrics.map((m) => m.edgeInk.top)),
    bottom: Math.max(...metrics.map((m) => m.edgeInk.bottom)),
  };
  merged.safeAreaOverflow = {
    left: Math.max(...metrics.map((m) => m.safeAreaOverflow.left)),
    top: Math.max(...metrics.map((m) => m.safeAreaOverflow.top)),
    right: Math.max(...metrics.map((m) => m.safeAreaOverflow.right)),
    bottom: Math.max(...metrics.map((m) => m.safeAreaOverflow.bottom)),
    outside: metrics.some((m) => m.safeAreaOverflow.outside),
  };
  merged.contentOutsideFrame = metrics.some((m) => m.contentOutsideFrame);
  merged.contentBox = rectUnion(metrics.map((m) => m.contentBox).filter((b): b is Rect => Boolean(b))) ?? pick.contentBox;
  return merged;
}

/**
 * Batch G (WS-B): reject stale or mismatched frame evidence. Frame evidence carries the
 * `scenesHash` of the scenes it was captured from; if the scenes have since changed the
 * pixels no longer describe them and must not be used for a verdict.
 */
export function isStaleEvidence(
  evidence: FrameEvidenceReport | null | undefined,
  scenes: SceneSpec[],
): boolean {
  if (!evidence || !evidence.scenesHash) return false;
  return evidence.scenesHash !== scenesFingerprint(scenes).scenesHash;
}

/** Async entry: measure text first, then evaluate. Never throws. */
export async function evaluateLayoutGate(
  scene: SceneSpec,
  evidence?: FrameEvidenceReport | null,
): Promise<LayoutFinding> {
  try {
    await ensureSceneTextMetrics(scene);
  } catch {
    // measurement is best-effort; the gate still runs on cached/estimated metrics
  }
  const geometry = sceneRenderedGeometry(scene);
  const stale = isStaleEvidence(evidence, [scene]);
  const rendered = evidence && !stale ? worstMetricsForScene(evidence, scene.sceneId) : null;
  const finding = layoutFinding(scene, geometry, rendered);
  if (stale) {
    finding.warnings.push(
      `${scene.sceneId}: STALE EVIDENCE REJECTED - frame evidence scenesHash does not match the current scene; rendered metrics not used`,
    );
  }
  return finding;
}

export async function evaluateProjectLayoutGate(
  scenes: SceneSpec[],
  evidence?: FrameEvidenceReport | null,
): Promise<LayoutGateReport> {
  // one browser batch for the whole project, then synchronous evaluation per scene
  try {
    await ensureTextMetricsForScenes(scenes);
  } catch {
    // measurement is best-effort; the gate still runs on cached/estimated metrics
  }
  const stale = isStaleEvidence(evidence, scenes);
  const usableEvidence = stale ? null : evidence;
  const findings: LayoutFinding[] = [];
  for (const scene of scenes) {
    const geometry = sceneRenderedGeometry(scene);
    const rendered = usableEvidence ? worstMetricsForScene(usableEvidence, scene.sceneId) : null;
    findings.push(layoutFinding(scene, geometry, rendered));
  }
  const hard = findings.flatMap((f) => f.hard);
  const warnings = findings.flatMap((f) => f.warnings);
  if (stale) {
    warnings.push(
      `layout-gate: STALE EVIDENCE REJECTED - frame evidence scenesHash does not match the current scenes; rendered metrics not used for any scene`,
    );
  }
  const disagreements = findings.filter(
    (f) => f.agreement.frame === "model-only" || f.agreement.frame === "rendered-only",
  ).length;
  return {
    schema: "layout-gate/1",
    generatedAt: new Date().toISOString(),
    findings,
    hard,
    warnings,
    ok: hard.length === 0,
    disagreements,
  };
}

export const summarizeLayoutGate = (r: LayoutGateReport): string =>
  `layout-gate ${r.ok ? "ok" : "FAIL"}: ${r.hard.length} hard, ${r.warnings.length} warnings, ${r.disagreements} model/pixel disagreements`;
