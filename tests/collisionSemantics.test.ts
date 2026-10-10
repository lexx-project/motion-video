import { describe, it, expect, afterEach } from "vitest";
import { collisionSemantics, HARD_COLLISION_RATIO, describeCollision } from "../src/validation/collisionSemantics";
import { resetTextMetricsCache, setTextMetrics, metricKey } from "../src/render/measureText";
import { typography } from "../src/core/designSystem";
import type { SceneSpec } from "../src/validation/schema";

/**
 * Batch C / §8: intentional vs unintended overlap.
 * Motion graphics legitimately overlap - only UNINTENTIONAL overlap may become a failure.
 */

const labelStyle = () => {
  const t = typography.scale.label;
  return { family: "Inter", sizePx: t.default, weight: t.weight, letterSpacingEm: t.letterSpacingEm, lineHeight: t.lineHeight, uppercase: t.uppercase };
};

const scene = (over: Partial<SceneSpec>): SceneSpec =>
  ({
    sceneId: "collision_fixture",
    duration: 3,
    purpose: "p",
    visualConcept: "c",
    composition: "centered",
    elements: [],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    ...over,
  }) as unknown as SceneSpec;

/** Cross-anchor TEXT overlap: two labels in different bands that share pixels. */
const textOverlap = (collisionIntent?: string): SceneSpec =>
  scene({
    elements: [
      { primitive: "Label", text: "OVERLAPPING LABEL ONE", position: "left", role: "semantic", purpose: "left caption" },
      {
        primitive: "Label",
        text: "OVERLAPPING LABEL TWO",
        position: "center",
        role: "semantic",
        purpose: "center caption",
        ...(collisionIntent ? { collisionIntent } : {}),
      },
    ],
  });

/** Two objects in different anchors that share pixels - layering, never a readability issue. */
const objectOverlap = scene({
  elements: [
    { primitive: "Circle", position: "left", diameterPct: 40, role: "semantic", purpose: "left ring" },
    { primitive: "Circle", position: "center", diameterPct: 40, role: "semantic", purpose: "center ring" },
  ],
});

const clean = scene({
  headline: { text: "CLEAN", accentWords: [], align: "left" },
  elements: [{ primitive: "Circle", position: "bottom", diameterPct: 30, role: "semantic", purpose: "ring" }],
});

afterEach(() => resetTextMetricsCache());

describe("collision semantics", () => {
  it("classifies a cross-anchor text overlap as UNINTENTIONAL", () => {
    const r = collisionSemantics(textOverlap());
    expect(r.unintended.length).toBeGreaterThan(0);
    expect(r.intentional.length).toBe(0);
    const c = r.unintended[0];
    expect(c.ratio).toBeGreaterThanOrEqual(0.2);
    expect(c.kind).toBe("unintentional");
    expect(c.sameAnchor).toBe(false);
    expect(describeCollision(c)).toMatch(/ratio=\d+%/);
  });

  it("accepts the same overlap when the scene declares collisionIntent=intentional", () => {
    const r = collisionSemantics(textOverlap("intentional"));
    expect(r.intentional.length).toBeGreaterThan(0);
    expect(r.unintended.length).toBe(0);
    expect(r.intentional[0].reason).toMatch(/declared collisionIntent/);
  });

  it("treats object-on-object layering as intentional", () => {
    const r = collisionSemantics(objectOverlap);
    expect(r.intentional.length + r.unintended.length).toBeGreaterThan(0);
    expect(r.unintended.length).toBe(0);
    expect(r.intentional[0].reason).toMatch(/object-object layering/);
  });

  it("reports nothing for a clean scene", () => {
    const r = collisionSemantics(clean);
    expect(r.intentional).toEqual([]);
    expect(r.unintended).toEqual([]);
  });

  it("exposes the hard ratio used by the pre-render gate", () => {
    expect(HARD_COLLISION_RATIO).toBeGreaterThanOrEqual(0.5);
    expect(HARD_COLLISION_RATIO).toBeLessThanOrEqual(0.9);
  });

  it("is deterministic", () => {
    const a = collisionSemantics(textOverlap());
    const b = collisionSemantics(textOverlap());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
