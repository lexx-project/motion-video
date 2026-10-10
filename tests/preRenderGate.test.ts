import { describe, it, expect, afterEach } from "vitest";
import { evaluatePreRenderGate, preRenderIssues, layoutViolationsFrom } from "../src/validation/preRenderGate";
import { sceneRenderedGeometry } from "../src/scenes/rendererGeometry";
import { resetTextMetricsCache } from "../src/render/measureText";
import type { SceneSpec } from "../src/validation/schema";

/**
 * Batch C / §9: pre-render gate.
 * Model-detectable failures block the render until repaired; pixel-only problems are never
 * predicted before a render exists.
 */

const scene = (over: Partial<SceneSpec>): SceneSpec =>
  ({
    sceneId: "pre_render_fixture",
    duration: 3,
    purpose: "p",
    visualConcept: "c",
    composition: "centered",
    elements: [],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    ...over,
  }) as unknown as SceneSpec;

/** Scene-03 shaped: a large scaled word anchored at the right edge. */
const clipped = scene({
  composition: "leftTextRightObject",
  elements: [{ primitive: "WordReveal", text: "OVERFLOWING", position: "right", scale: 2.2, role: "semantic", purpose: "hero word" }],
});

const valid = scene({
  composition: "topTextBottomObject",
  headline: { text: "CLEAN", accentWords: [], align: "left" },
  elements: [{ primitive: "Circle", position: "bottom", diameterPct: 30, role: "semantic", purpose: "ring" }],
});

/** Scene-04 shaped: many semantic objects in the middle band - emptiness needs PIXELS. */
const weakBands = scene({
  sceneId: "weak_bands",
  composition: "topTextBottomObject",
  headline: { text: "NEVER BEND", accentWords: [], align: "left", position: "topLeft" },
  elements: [
    { primitive: "Line", position: "right", scale: 0.85, role: "semantic", purpose: "answer version" },
    { primitive: "Line", position: "right", scale: 0.85, role: "semantic", purpose: "answer version" },
    { primitive: "Line", position: "right", scale: 0.85, role: "semantic", purpose: "answer version" },
  ],
});

const intentionalOverlap = scene({
  elements: [
    { primitive: "Label", text: "OVERLAPPING LABEL ONE", position: "left", role: "semantic", purpose: "caption" },
    { primitive: "Label", text: "OVERLAPPING LABEL TWO", position: "center", role: "semantic", purpose: "caption", collisionIntent: "intentional" },
  ],
});

afterEach(() => resetTextMetricsCache());

describe("pre-render gate", () => {
  it("blocks an obvious layout clip before any render", async () => {
    const gate = await evaluatePreRenderGate([clipped]);
    expect(gate.proceed).toBe(false);
    const hard = gate.hard.filter((i) => i.sceneId === clipped.sceneId);
    expect(hard.map((i) => i.failureType)).toContain("layout_clip");
    const clips = hard.filter((i) => i.failureType === "layout_clip");
    expect(clips.length).toBeGreaterThanOrEqual(1);
    // the scaled word leaves the RIGHT edge (the Scene 03 failure mode); it may also leave the left
    expect(clips.flatMap((c) => c.region ?? [])).toContain("right");
    expect(clips.every((c) => c.severity === "hard" && (c.magnitude ?? 0) >= 8)).toBe(true);
    expect(clips.every((c) => (c.target ?? []).length > 0)).toBe(true);
    expect(clips.some((c) => /past the right frame edge/.test(c.evidence))).toBe(true);
    // severe safe-area crossing is reported too (same root cause)
    expect(hard.map((i) => i.failureType)).toContain("safe_area_overflow");
  }, 60000);

  it("lets a valid scene proceed", async () => {
    const gate = await evaluatePreRenderGate([valid]);
    expect(gate.proceed).toBe(true);
    expect(gate.hard).toEqual([]);
    expect(gate.schema).toBe("pre-render-gate/1");
  }, 60000);

  it("never predicts pixel-only problems (empty bands) before a render exists", async () => {
    const gate = await evaluatePreRenderGate([weakBands]);
    expect(gate.hard.map((i) => i.failureType)).not.toContain("empty_visual_band");
    expect(gate.scenes[0].issues.every((i) => i.failureType !== "empty_visual_band")).toBe(true);
  }, 60000);

  it("does not report declared intentional overlaps", async () => {
    const gate = await evaluatePreRenderGate([intentionalOverlap]);
    expect(gate.hard.filter((i) => i.failureType === "unintended_collision")).toEqual([]);
  }, 60000);

  it("sync issue extraction agrees with the async gate (no hidden state)", async () => {
    await evaluatePreRenderGate([clipped, valid]);
    const syncClip = preRenderIssues(clipped);
    const syncValid = preRenderIssues(valid);
    expect(syncClip.some((i) => i.severity === "hard" && i.failureType === "layout_clip")).toBe(true);
    expect(syncValid).toEqual([]);
  }, 60000);

  it("reports violations from the renderer-aware geometry, not the raw logical box", () => {
    const geo = sceneRenderedGeometry(clipped);
    const v = layoutViolationsFrom(geo);
    const item = geo.items[0];
    // the logical box fits inside the safe area...
    expect(item.layout.x1).toBeLessThanOrEqual(993.6 + 1);
    // ...but the transformed box does not
    expect(v.frame.some((f) => f.side === "right" && f.px >= 8)).toBe(true);
  });
});
