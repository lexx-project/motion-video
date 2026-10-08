import { describe, it, expect } from "vitest";
import { compareNovelty, similarityScore, entryFromScene, runNoveltyCheck } from "../src/agents/novelty";
import type { SceneSpec } from "../src/validation/schema";
import { validateScene } from "../src/validation/validate";

const scene = (over: Partial<Record<string, unknown>>): SceneSpec => {
  const base = {
    sceneId: "scene_01",
    duration: 3,
    purpose: "break the loop of repetition",
    visualConcept: "looping_calendar",
    composition: "centered",
    elements: [
      { primitive: "Circle", position: "center", accent: "teal" },
      { primitive: "Headline", text: "BREAK THE LOOP", position: "top" },
    ],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    ...over,
  };
  const r = validateScene(base);
  if (!r.success) throw new Error(`fixture invalid: ${r.errors.join("; ")}`);
  return r.scene!;
};

describe("novelty checker (MASTER_SPEC section 10)", () => {
  it("accepts the first scene of a fresh project", () => {
    const results = runNoveltyCheck("test_proj_novelty_1", [scene({})], []);
    expect(results[0].verdict).toBe("accept");
    expect(results[0].similarity).toBe(0);
  });

  it("rejects a near-identical scene (same metaphor+composition+primitives+motion)", () => {
    const a = entryFromScene("p", scene({}));
    const b = entryFromScene("p", scene({ sceneId: "scene_02", visualConcept: "looping_calendar_v2" }));
    const dims = compareNovelty(a, b);
    const score = similarityScore(dims);
    expect(score).toBeGreaterThanOrEqual(70);
    expect(dims.find((d) => d.dimension === "sameComposition")?.matched).toBe(true);
    expect(dims.find((d) => d.dimension === "samePrimitiveCombination")?.matched).toBe(true);
    expect(dims.find((d) => d.dimension === "sameMotionPattern")?.matched).toBe(true);
  });

  it("sharing ONE primitive alone is not repetition", () => {
    const a = entryFromScene(
      "p",
      scene({
        elements: [
          { primitive: "Circle", position: "center", accent: "teal" },
          { primitive: "Headline", text: "BREAK THE LOOP", position: "top" },
        ],
      }),
    );
    const b = entryFromScene(
      "p",
      scene({
        sceneId: "scene_09",
        purpose: "time keeps slipping away",
        visualConcept: "clock_target_split",
        composition: "leftTextRightObject",
        elements: [
          { primitive: "Circle", position: "bottom", accent: "gold" },
          { primitive: "Clock", position: "right" },
          { primitive: "Target", position: "left" },
        ],
        motion: { entrance: "slide", emphasis: "highlight", exit: "dissolve" },
      }),
    );
    const dims = compareNovelty(a, b);
    const score = similarityScore(dims);
    expect(dims.find((d) => d.dimension === "samePrimitiveCombination")?.matched).toBe(false);
    expect(score).toBeLessThan(50);
  });

  it("flags within-project repetition for a duplicate layout", () => {
    const results = runNoveltyCheck("test_proj_novelty_2", [scene({}), scene({ sceneId: "scene_02" })], []);
    expect(results[1].similarity).toBeGreaterThanOrEqual(70);
    expect(results[1].verdict).toBe("reject");
  });

  it("verdict thresholds match the spec (50/70)", () => {
    const a = entryFromScene(
      "p",
      scene({
        purpose: "take the first step today",
        visualConcept: "first_step_stairs",
        composition: "bottomTextTopObject",
        elements: [
          { primitive: "Stack", position: "top", variant: "bars" },
          { primitive: "Label", text: "STEP ONE", position: "bottom" },
        ],
        motion: { entrance: "reveal", emphasis: "counterChange", exit: "slide" },
      }),
    );
    const b = entryFromScene(
      "p",
      scene({
        sceneId: "scene_07",
        purpose: "compound small habits",
        visualConcept: "habit_stack",
        composition: "topTextBottomObject",
        elements: [
          { primitive: "Stack", position: "bottom", variant: "cards" },
          { primitive: "Caption", text: "one day at a time", position: "top" },
        ],
        motion: { entrance: "scale", emphasis: "glow", exit: "dissolve" },
      }),
    );
    const dims = compareNovelty(a, b);
    expect(similarityScore(dims)).toBeLessThan(50);
  });
});
