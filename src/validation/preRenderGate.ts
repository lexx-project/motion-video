import { frameOverflow, safeAreaOverflow } from "../scenes/bounds";
import { sceneRenderedGeometry, ensureTextMetricsForScenes, type SceneGeometry } from "../scenes/rendererGeometry";
import { subtitleCollisions } from "../reference/conformance";
import { LAYOUT_GATES } from "./layoutGate";
import {
  collisionSemantics,
  collisionSemanticsFrom,
  HARD_COLLISION_RATIO,
  describeCollision,
  type CollisionReport,
} from "./collisionSemantics";
import type { FailureType, FailureSeverity } from "../agents/repairContext";
import type { SceneSpec } from "./schema";

/**
 * Pre-render gate (Batch C / §9).
 *
 * Runs AFTER generation and BEFORE the expensive render, using only the renderer-aware model
 * (no pixels - they do not exist yet). It answers one question: "is it obvious that this scene
 * will fail, so that we should repair it before paying for a render?".
 *
 * MODEL-DETECTABLE  -> reported here, repaired before render:
 *   - frame clipping beyond LAYOUT_GATES.modelFrameClipPx
 *   - severe safe-area crossing (>= LAYOUT_GATES.safeAreaSeverePx)
 *   - caption-band collisions (existing calibrated 0.35 threshold)
 *   - high-ratio UNINTENTIONAL overlap (>= HARD_COLLISION_RATIO)
 *
 * PIXEL-DETECTABLE  -> deliberately NOT predicted here:
 *   - empty/weak visual bands, unreadable text and motion absence need rendered evidence
 *     (visualGates), so they never block a render.
 *
 * Intentional overlaps (declared `collisionIntent`, object-on-object layering) are never
 * reported. Pure + deterministic: no browser is opened here; callers warm the text-metrics
 * cache first with `ensureTextMetricsForScenes`.
 */

export interface PreRenderIssue {
  sceneId: string;
  failureType: FailureType;
  severity: FailureSeverity;
  evidence: string;
  target?: string[];
  region?: string[];
  magnitude?: number;
}

export interface ScenePreRenderReport {
  sceneId: string;
  issues: PreRenderIssue[];
  collisions: CollisionReport;
}

export interface PreRenderGateReport {
  schema: "pre-render-gate/1";
  generatedAt: string;
  scenes: ScenePreRenderReport[];
  hard: PreRenderIssue[];
  warnings: PreRenderIssue[];
  /** true when nothing model-detectable is obviously wrong (safe to render) */
  proceed: boolean;
}

const SIDES = ["left", "right", "top", "bottom"] as const;

/** Model-side frame/safe-area violations for an already-computed geometry. */
export function layoutViolationsFrom(geo: SceneGeometry): {
  frame: { id: string; side: (typeof SIDES)[number]; px: number }[];
  safeArea: { id: string; side: (typeof SIDES)[number]; px: number }[];
} {
  const frame: { id: string; side: (typeof SIDES)[number]; px: number }[] = [];
  const safeArea: { id: string; side: (typeof SIDES)[number]; px: number }[] = [];
  for (const item of geo.items) {
    const f = frameOverflow(item.rendered);
    if (f.outside) {
      for (const side of SIDES) if (f[side] > 0.5) frame.push({ id: item.id, side, px: Math.round(f[side]) });
    }
    const s = safeAreaOverflow(item.rendered);
    if (s.outside) {
      for (const side of SIDES) if (s[side] > 0.5) safeArea.push({ id: item.id, side, px: Math.round(s[side]) });
    }
  }
  return { frame, safeArea };
}

/** Model-only issues for ONE scene (sync, deterministic, no browser). */
export function preRenderIssues(scene: SceneSpec, geo?: SceneGeometry): PreRenderIssue[] {
  const geometry = geo ?? sceneRenderedGeometry(scene);
  const issues: PreRenderIssue[] = [];

  // 1. frame clipping (model-predicted)
  for (const v of layoutViolationsFrom(geometry).frame) {
    if (v.px < LAYOUT_GATES.modelFrameClipPx) continue;
    issues.push({
      sceneId: scene.sceneId,
      failureType: "layout_clip",
      severity: "hard",
      evidence: `model overflow ${v.px}px past the ${v.side} frame edge after transform`,
      target: [v.id],
      region: [v.side],
      magnitude: v.px,
    });
  }

  // 2. safe-area: severe is hard, mild is a warning (Batch B thresholds preserved)
  for (const v of layoutViolationsFrom(geometry).safeArea) {
    const severe = v.px >= LAYOUT_GATES.safeAreaSeverePx;
    issues.push({
      sceneId: scene.sceneId,
      failureType: "safe_area_overflow",
      severity: severe ? "hard" : "warning",
      evidence: severe
        ? `model overflow ${v.px}px past the ${v.side} safe margin (severe threshold ${LAYOUT_GATES.safeAreaSeverePx}px)`
        : `model crossing ${v.px}px past the ${v.side} safe margin`,
      target: [v.id],
      region: [v.side],
      magnitude: v.px,
    });
  }

  // 3. caption band (objective readability - calibrated 0.35 threshold, unchanged)
  for (const c of subtitleCollisions(scene)) {
    issues.push({
      sceneId: scene.sceneId,
      failureType: "unintended_collision",
      severity: "hard",
      evidence: `subtitle band overlaps ${c.b} (${Math.round(c.ratio * 100)}%) - caption readability is objective`,
      target: [c.b],
      region: ["subtitle"],
      magnitude: c.ratio,
    });
  }

  // 4. high-ratio UNINTENTIONAL overlap (intentional overlaps excluded by collisionSemantics)
  for (const c of collisionSemanticsFrom(geometry).unintended) {
    if (c.ratio < HARD_COLLISION_RATIO) continue;
    issues.push({
      sceneId: scene.sceneId,
      failureType: "unintended_collision",
      severity: "hard",
      evidence: describeCollision(c),
      target: [c.a, c.b],
      region: [c.posA, c.posB],
      magnitude: c.ratio,
    });
  }

  return issues;
}

/**
 * Full pre-render gate for a project: warms real text metrics once (single browser batch),
 * then evaluates every scene synchronously.
 */
export async function evaluatePreRenderGate(scenes: SceneSpec[]): Promise<PreRenderGateReport> {
  try {
    await ensureTextMetricsForScenes(scenes);
  } catch {
    // measurement is best-effort: the gate still runs on cached/estimated metrics
  }

  const perScene: ScenePreRenderReport[] = [];
  for (const scene of scenes) {
    const geometry = sceneRenderedGeometry(scene);
    perScene.push({
      sceneId: scene.sceneId,
      issues: preRenderIssues(scene, geometry),
      collisions: collisionSemanticsFrom(geometry),
    });
  }

  const hard = perScene.flatMap((s) => s.issues.filter((i) => i.severity === "hard"));
  const warnings = perScene.flatMap((s) => s.issues.filter((i) => i.severity === "warning"));
  return {
    schema: "pre-render-gate/1",
    generatedAt: new Date().toISOString(),
    scenes: perScene,
    hard,
    warnings,
    proceed: hard.length === 0,
  };
}

export const summarizePreRenderGate = (r: PreRenderGateReport): string =>
  `pre-render-gate ${r.proceed ? "ok" : "BLOCK"}: ${r.hard.length} hard, ${r.warnings.length} warnings`;
