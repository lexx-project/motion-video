import { sceneRenderedGeometry, type SceneGeometry } from "../scenes/rendererGeometry";
import { overlapArea } from "../scenes/layout";
import { rectArea, type Rect } from "../scenes/bounds";
import type { SceneSpec } from "./schema";

/**
 * Intentional vs unintentional overlap (Batch C / §8).
 *
 * Motion graphics legitimately overlap: a badge on a card, an icon inside a panel, a person
 * behind an object, a label over a rule. "Everything that overlaps is wrong" would be a bad
 * policy, so overlap is classified instead of blanket-failed:
 *
 *   INTENTIONAL   - declared on the element (`collisionIntent: "intentional"`), or an
 *                   object-object overlap (layering a shape on a shape is a design device,
 *                   it never harms readability of text)
 *   UNINTENTIONAL - text involved in a cross-anchor overlap, or text involved in a same-anchor
 *                   overlap (the renderer stacks same-anchor items, so paint overlap there only
 *                   happens when a transform spills into the neighbour)
 *
 * Only UNINTENTIONAL collisions may become hard failures; INTENTIONAL ones are never gates.
 * Detection uses the Batch B renderer-aware geometry (one model, no second approximation).
 */

export type CollisionKind = "intentional" | "unintentional";

export interface CollisionFinding {
  a: string;
  b: string;
  posA: string;
  posB: string;
  ratio: number;
  kind: CollisionKind;
  reason: string;
  sameAnchor: boolean;
}

export interface CollisionReport {
  intentional: CollisionFinding[];
  unintended: CollisionFinding[];
  /** ratio above which an unintended text overlap is treated as a hard pre-render failure */
  hardRatio: number;
}

/** Same 0.2 threshold conformance uses for cross-anchor text collisions (thin items need more). */
export const COLLISION_RATIO = 0.2;
export const THIN_COLLISION_RATIO = 0.6;
/** Unintended text overlap at/above this ratio is an obvious hard failure (Batch C pre-render). */
export const HARD_COLLISION_RATIO = 0.5;

const THIN_MIN_HEIGHT = 14;

const isThin = (b: Rect): boolean => b.y1 - b.y0 <= THIN_MIN_HEIGHT;

function classify(
  a: { id: string; pos: string; isText: boolean; collisionIntent?: string },
  b: { id: string; pos: string; isText: boolean; collisionIntent?: string },
): { kind: CollisionKind; reason: string } {
  if (a.collisionIntent === "intentional" || b.collisionIntent === "intentional") {
    return { kind: "intentional", reason: "declared collisionIntent=intentional" };
  }
  if (!a.isText && !b.isText) {
    return { kind: "intentional", reason: "object-object layering (no text readability impact)" };
  }
  const sameAnchor = a.pos === b.pos;
  if (sameAnchor) {
    return {
      kind: "unintentional",
      reason: "same-anchor items are stacked by the renderer; paint overlap means a transform spilled into its neighbour",
    };
  }
  return { kind: "unintentional", reason: "text overlaps content across anchors" };
}

/** Classify every detected overlap from an already-computed geometry (sync, pure). */
export function collisionSemanticsFrom(geo: SceneGeometry): CollisionReport {
  const intentional: CollisionFinding[] = [];
  const unintended: CollisionFinding[] = [];

  for (let i = 0; i < geo.items.length; i++) {
    for (let j = i + 1; j < geo.items.length; j++) {
      const a = geo.items[i];
      const b = geo.items[j];
      const ov = overlapArea(a.rendered, b.rendered);
      if (ov <= 0) continue;
      const threshold = isThin(a.rendered) || isThin(b.rendered) ? THIN_COLLISION_RATIO : COLLISION_RATIO;
      const ratio = ov / Math.min(Math.max(1, rectArea(a.rendered)), Math.max(1, rectArea(b.rendered)));
      if (ratio < threshold) continue;
      const cls = classify(a, b);
      const finding: CollisionFinding = {
        a: a.id,
        b: b.id,
        posA: a.pos,
        posB: b.pos,
        ratio: Number(ratio.toFixed(3)),
        kind: cls.kind,
        reason: cls.reason,
        sameAnchor: a.pos === b.pos,
      };
      (cls.kind === "intentional" ? intentional : unintended).push(finding);
    }
  }
  return { intentional, unintended, hardRatio: HARD_COLLISION_RATIO };
}

/** Classify every detected overlap in a scene (computes geometry when not supplied). */
export function collisionSemantics(scene: SceneSpec): CollisionReport {
  return collisionSemanticsFrom(sceneRenderedGeometry(scene));
}

/** Compact one-liner for prompts / diagnostics. */
export const describeCollision = (c: CollisionFinding): string =>
  `${c.a} x ${c.b} ratio=${Math.round(c.ratio * 100)}% sameAnchor=${c.sameAnchor} (${c.reason})`;
