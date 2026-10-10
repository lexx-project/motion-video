import { sceneLayoutBoxes } from "../reference/conformance";
import type { SceneSpec } from "./schema";
import {
  FRAME,
  frameOverflow,
  safeAreaOverflow,
  rectUnion,
  roundRect,
  subtitleBandRect,
  normalizeRect,
  safeAreaRect,
  frameRect,
  type Rect,
} from "../scenes/bounds";

/**
 * Deterministic bounds / safe-area EVIDENCE for one scene (Batch A / A3).
 *
 * Answers, without rendering and without an LLM:
 *   - what boxes does the layout model place, and where?
 *   - does any box cross the frame edge (unrenderable / clipped)?
 *   - does any box cross the safe area?
 *   - what is the approximate content bounding box?
 *   - what geometry should later QA consume (frame, safe area, caption band)?
 *
 * Scope note: this REPORTS. It deliberately introduces no new validation failure - the hard
 * layout gate (Batch B / P0-2) will consume this same evidence. Thresholds are not changed here.
 */

export interface BoxEvidence {
  id: string;
  pos: string;
  isText: boolean;
  box: Rect;
  /** rounded, compact copy for reports */
  rounded: Rect;
  frame: ReturnType<typeof frameOverflow>;
  safeArea: ReturnType<typeof safeAreaOverflow>;
}

export interface BoundsEvidence {
  canvas: { width: number; height: number };
  frame: Rect;
  safeArea: Rect;
  subtitleBand: Rect;
  boxes: BoxEvidence[];
  /** union of all model boxes (null when the scene places nothing) */
  contentBox: Rect | null;
  contentBoxNorm: Rect | null;
  /** boxes that extend past the frame edge, with px per side */
  frameViolations: { id: string; left: number; top: number; right: number; bottom: number }[];
  /** boxes that extend past the safe area, with px per side */
  safeAreaViolations: { id: string; left: number; top: number; right: number; bottom: number }[];
  /** true when the content union itself crosses the frame edge */
  contentOutsideFrame: boolean;
  hasSubtitleBand: boolean;
}

const zeroOverflow = { left: 0, top: 0, right: 0, bottom: 0, outside: false };

/** Model-side bounds evidence for a scene (uses the same group-flow model as conformance). */
export function layoutBoundsEvidence(scene: SceneSpec): BoundsEvidence {
  const canvas = FRAME;
  const raw = sceneLayoutBoxes(scene);
  const boxes: BoxEvidence[] = raw.map((b) => {
    const frame = frameOverflow(b.box, canvas);
    const safe = safeAreaOverflow(b.box, canvas);
    return {
      id: b.id,
      pos: b.pos,
      isText: b.isText,
      box: b.box,
      rounded: roundRect(b.box),
      frame,
      safeArea: safe,
    };
  });

  const contentBox = rectUnion(boxes.map((b) => b.box));
  const frameViolations = boxes
    .filter((b) => b.frame.outside)
    .map((b) => ({ id: b.id, left: b.frame.left, top: b.frame.top, right: b.frame.right, bottom: b.frame.bottom }));
  const safeAreaViolations = boxes
    .filter((b) => b.safeArea.outside)
    .map((b) => ({
      id: b.id,
      left: b.safeArea.left,
      top: b.safeArea.top,
      right: b.safeArea.right,
      bottom: b.safeArea.bottom,
    }));

  return {
    canvas: { width: canvas.width, height: canvas.height },
    frame: frameRect(canvas),
    safeArea: safeAreaRect(canvas),
    subtitleBand: subtitleBandRect("validate", canvas),
    boxes,
    contentBox,
    contentBoxNorm: contentBox ? normalizeRect(contentBox, canvas) : null,
    frameViolations,
    safeAreaViolations,
    contentOutsideFrame: contentBox ? frameOverflow(contentBox, canvas).outside : false,
    hasSubtitleBand: Boolean(scene.subtitle?.enabled && scene.subtitle.phrases.length > 0),
  };
}

/** Compact one-line summary for logs / diagnostic reports (no prose bloat). */
export function summarizeBounds(e: BoundsEvidence): string {
  const clip = e.frameViolations.length;
  const safe = e.safeAreaViolations.length;
  const content = e.contentBox ? `content=${Math.round(e.contentBox.x0)},${Math.round(e.contentBox.y0)}..${Math.round(e.contentBox.x1)},${Math.round(e.contentBox.y1)}` : "content=none";
  return `${e.boxes.length} boxes; ${clip} frame-edge violation(s); ${safe} safe-area violation(s); ${content}`;
}

/** Defaults kept for callers that only want the violation lists. */
export const emptyOverflow = zeroOverflow;
