import { describe, it, expect } from "vitest";
import {
  FRAME,
  frameRect,
  safeAreaRect,
  subtitleBandRect,
  frameOverflow,
  safeAreaOverflow,
  rectUnion,
  rectsOverlap,
  normalizeRect,
} from "../src/scenes/bounds";
import { subtitleBoxFor } from "../src/reference/conformance";
import { layoutBoundsEvidence, summarizeBounds } from "../src/validation/layoutEvidence";
import type { SceneSpec } from "../src/validation/schema";

const withSubtitle = {
  sceneId: "bounds_a",
  duration: 3,
  purpose: "p",
  visualConcept: "c",
  composition: "typographyDominant",
  headline: { text: "WORDS ARE THE WEAPON", accentWords: [], align: "left" },
  elements: [{ primitive: "Label", text: "CHOOSE THEM WISELY", position: "bottom", accent: "none" }],
  motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
  subtitle: { enabled: true, role: "vo caption", phrases: [{ text: "spoken", start: 0, end: 2 }] },
} as unknown as SceneSpec;

const noSubtitle = { ...withSubtitle, subtitle: undefined } as unknown as SceneSpec;

/** Long unbroken word: the model's own column maths must place it past the frame edge. */
const overflowing = {
  sceneId: "bounds_overflow",
  duration: 3,
  purpose: "p",
  visualConcept: "c",
  composition: "typographyDominant",
  headline: { text: "SUPERCALIFRAGILISTICEXPIALIDOCIOUS MATTERS", accentWords: [], align: "left", position: "center" },
  elements: [],
  motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
} as unknown as SceneSpec;

describe("frame / safe-area geometry (A3)", () => {
  it("frame and safe area come from design tokens", () => {
    expect(frameRect()).toEqual({ x0: 0, y0: 0, x1: 1080, y1: 1920 });
    expect(safeAreaRect()).toEqual({ x0: 86.4, y0: 192, x1: 993.6, y1: 1651.2 });
    expect(FRAME).toEqual({ width: 1080, height: 1920 });
  });

  it("caption band has one source of truth: render band matches the renderer, validate band stays wider", () => {
    const render = subtitleBandRect("render");
    const validate = subtitleBandRect("validate");
    // SceneRenderer SubtitleBand: left/right 8%, bottom 14.5%, 110px tall
    expect(render.x0).toBeCloseTo(86.4, 5);
    expect(render.x1).toBeCloseTo(993.6, 5);
    expect(render.y1).toBeCloseTo(1641.6, 5);
    expect(render.y1 - render.y0).toBe(110);
    // validation band must stay at least as wide as the render band (never a lower threshold)
    expect(validate.x0).toBeLessThanOrEqual(render.x0);
    expect(validate.x1).toBeGreaterThanOrEqual(render.x1);
    expect(validate.y1).toBeCloseTo(render.y1, 5);
    expect(validate.y1 - validate.y0).toBe(110);
  });

  it("conformance subtitleBoxFor delegates to the shared geometry (unchanged numbers)", () => {
    const box = subtitleBoxFor(withSubtitle);
    expect(box).not.toBeNull();
    expect(box!.x0).toBeCloseTo(75.6, 6);
    expect(box!.x1).toBeCloseTo(1004.4, 6);
    expect(box!.y0).toBeCloseTo(1531.6, 6);
    expect(box!.y1).toBeCloseTo(1641.6, 6);
    expect(subtitleBoxFor(noSubtitle)).toBeNull();
  });

  it("measures overflow per side, in px", () => {
    const clipped = frameOverflow({ x0: -20, y0: 10, x1: 100, y1: 100 });
    expect(clipped).toMatchObject({ left: 20, top: 0, right: 0, bottom: 0, outside: true });

    const inside = frameOverflow({ x0: 100, y0: 100, x1: 200, y1: 200 });
    expect(inside.outside).toBe(false);

    const safe = safeAreaOverflow({ x0: 10, y0: 10, x1: 1000, y1: 1800 });
    expect(safe.left).toBeCloseTo(76.4, 5);
    expect(safe.right).toBeCloseTo(6.4, 5);
    expect(safe.outside).toBe(true);
  });

  it("union / overlap / normalization helpers behave", () => {
    expect(rectUnion([{ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 5, y0: 8, x1: 20, y1: 30 }])).toEqual({
      x0: 0, y0: 0, x1: 20, y1: 30,
    });
    expect(rectUnion([])).toBeNull();
    expect(rectsOverlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 5, y0: 5, x1: 20, y1: 20 })).toBe(true);
    expect(rectsOverlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 11, y0: 0, x1: 20, y1: 10 })).toBe(false);
    expect(normalizeRect({ x0: 540, y0: 960, x1: 1080, y1: 1920 })).toEqual({ x0: 0.5, y0: 0.5, x1: 1, y1: 1 });
  });
});

describe("layout bounds evidence (A3)", () => {
  it("reports boxes, content bounds and caption geometry for a normal scene", () => {
    const e = layoutBoundsEvidence(withSubtitle);
    expect(e.boxes.length).toBeGreaterThanOrEqual(2);
    expect(e.contentBox).not.toBeNull();
    expect(e.contentBoxNorm).not.toBeNull();
    expect(e.frameViolations).toEqual([]);
    expect(e.contentOutsideFrame).toBe(false);
    expect(e.hasSubtitleBand).toBe(true);
    expect(e.subtitleBand.y1).toBeCloseTo(1641.6, 5);
    expect(summarizeBounds(e)).toMatch(/frame-edge violation\(s\)/);
  });

  it("flags content that the layout model places outside the frame", () => {
    const e = layoutBoundsEvidence(overflowing);
    expect(e.frameViolations.length).toBeGreaterThan(0);
    expect(e.contentOutsideFrame).toBe(true);
    const headline = e.frameViolations.find((v) => v.id.startsWith("scene.headline"));
    expect(headline).toBeDefined();
    expect(headline!.right).toBeGreaterThan(0);
    expect(e.safeAreaViolations.length).toBeGreaterThan(0);
  });

  it("is deterministic (same scene, same evidence)", () => {
    expect(layoutBoundsEvidence(withSubtitle)).toEqual(layoutBoundsEvidence(withSubtitle));
  });
});
