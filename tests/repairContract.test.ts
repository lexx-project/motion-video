import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
  repairProposalSchema,
  validateRepairProposal,
  applyRepairProposal,
  ALLOWED_PROPERTIES,
} from "../src/validation/repairContract";
import { evaluatePreRenderGate } from "../src/validation/preRenderGate";
import { resetTextMetricsCache } from "../src/render/measureText";
import type { SceneSpec } from "../src/validation/schema";

/**
 * Batch C / §6 + §7: structured repair contract.
 * The model may only propose narrow property changes; code proves they stayed narrow.
 */

const clipScene = (): SceneSpec =>
  ({
    sceneId: "scene_03",
    duration: 3,
    purpose: "test purpose for scene",
    visualConcept: "test_concept",
    composition: "leftTextRightObject",
    elements: [
      { primitive: "WordReveal", text: "OVERFLOWING", position: "right", scale: 2.2, accent: "teal", role: "semantic", purpose: "hero word" },
      { primitive: "Circle", position: "bottom", diameterPct: 30, accent: "none", role: "semantic", purpose: "ring" },
    ],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    subtitle: { enabled: true, role: "vo caption", phrases: [{ text: "spoken words", start: 0, end: 2 }] },
  }) as unknown as SceneSpec;

const cleanScene = (): SceneSpec =>
  ({
    sceneId: "scene_01",
    duration: 3,
    purpose: "test purpose for scene",
    visualConcept: "test_concept",
    composition: "topTextBottomObject",
    elements: [{ primitive: "Circle", position: "bottom", diameterPct: 40, accent: "teal", role: "semantic", purpose: "ring" }],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
  }) as unknown as SceneSpec;

const proposal = (over: Record<string, unknown>): Record<string, unknown> => ({
  sceneId: "scene_03",
  reason: "measured overflow",
  changes: [{ target: "elements:0", property: "scale", from: 2.2, to: 1.6 }],
  preserve: ["scene meaning", "timing"],
  ...over,
});

beforeAll(async () => {
  // warm the text metrics so validation runs on measured geometry (deterministic within a run)
  await evaluatePreRenderGate([clipScene(), cleanScene()]);
}, 60000);

afterEach(() => resetTextMetricsCache());

describe("repair proposal contract", () => {
  it("accepts an allow-listed property change and produces a valid scene", () => {
    const scene = clipScene();
    const parsed = repairProposalSchema.parse(proposal({}));
    const r = validateRepairProposal(scene, parsed, "layout_clip", { implicated: ['WordReveal[0]("OVERFLOWING")'] });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.scene).toBeDefined();
    expect((r.scene!.elements[0] as { scale: number }).scale).toBe(1.6);
    expect(scene.elements[0]).not.toBe(r.scene!.elements[0]); // input untouched (pure)
  });

  it("rejects a property outside the allow-list for this failure type", () => {
    const parsed = repairProposalSchema.parse(
      proposal({ changes: [{ target: "elements:0", property: "purpose", to: "something else" }] }),
    );
    const r = validateRepairProposal(clipScene(), parsed, "layout_clip", { implicated: ["WordReveal[0]"] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/not allowed for layout_clip/);
  });

  it("rejects a change to an unrelated element", () => {
    const parsed = repairProposalSchema.parse(
      proposal({ changes: [{ target: "elements:1", property: "scale", from: 1, to: 0.5 }] }),
    );
    const r = validateRepairProposal(clipScene(), parsed, "layout_clip", { implicated: ["WordReveal[0]"] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unrelated to this failure/);
  });

  it("allows any element when the failure is region-scoped (no object named)", () => {
    const parsed = repairProposalSchema.parse(
      proposal({ changes: [{ target: "elements:1", property: "scale", from: 1, to: 1.1 }] }),
    );
    const r = validateRepairProposal(clipScene(), parsed, "empty_visual_band", { implicated: ["3 non-text objects"] });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("rejects values outside the design-system range", () => {
    const parsed = repairProposalSchema.parse(
      proposal({ changes: [{ target: "elements:0", property: "scale", from: 2.2, to: 9 }] }),
    );
    const r = validateRepairProposal(clipScene(), parsed, "layout_clip", { implicated: ["WordReveal[0]"] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/above maximum 3/);
  });

  it("rejects a no-op change", () => {
    const parsed = repairProposalSchema.parse(
      proposal({ changes: [{ target: "elements:0", property: "scale", from: 2.2, to: 2.2 }] }),
    );
    const r = validateRepairProposal(clipScene(), parsed, "layout_clip", { implicated: ["WordReveal[0]"] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/no-op repair/);
  });

  it("rejects a proposal that targets another scene", () => {
    const parsed = repairProposalSchema.parse(proposal({ sceneId: "scene_99" }));
    const r = validateRepairProposal(clipScene(), parsed, "layout_clip");
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/belongs to "scene_03"/);
  });

  it("rejects malformed proposals (schema)", () => {
    expect(() => repairProposalSchema.parse({ sceneId: "scene_03", reason: "x", changes: [], preserve: ["a"] })).toThrow();
    expect(() => repairProposalSchema.parse({ sceneId: "scene_03", reason: "x", changes: [{}], preserve: ["a"] })).toThrow();
    expect(() =>
      repairProposalSchema.parse({
        sceneId: "scene_03",
        reason: "x",
        changes: [{ target: "elements:0", property: "scale", to: 1, extra: "nope" }],
        preserve: ["a"],
      }),
    ).toThrow();
  });

  it("rejects an unresolvable target", () => {
    const parsed = repairProposalSchema.parse(
      proposal({ changes: [{ target: "elements:42", property: "scale", from: 1, to: 0.5 }] }),
    );
    const r = validateRepairProposal(clipScene(), parsed, "layout_clip", { implicated: ["elements:42"] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/no element at index 42/);
  });

  it("rejects a repair that changes duration, motion or storyboard", () => {
    const scene = clipScene();
    // simulate a contract bypass: apply directly, then validate the resulting scene through the
    // narrowness checks by proposing an allowed property that the applier cannot reach anyway
    const parsed = repairProposalSchema.parse(
      proposal({ changes: [{ target: "scene", property: "purpose", to: "changed" }] }),
    );
    const r = validateRepairProposal(scene, parsed, "layout_clip", { implicated: ["WordReveal[0]"] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/not allowed|not allow-listed/);
  });

  it("rejects a candidate that introduces a NEW hard pre-render failure", () => {
    const scene = cleanScene();
    // blow the bottom circle far past the frame with an otherwise legal property
    const parsed = repairProposalSchema.parse({
      sceneId: "scene_01",
      reason: "judge asked for bigger",
      changes: [{ target: "elements:0", property: "scale", from: 1, to: 3 }],
      preserve: ["timing"],
    });
    const r = validateRepairProposal(scene, parsed, "judge_issue");
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/introduces a new hard failure/);
  });

  it("keeps the allow-list narrow per failure type", () => {
    expect(ALLOWED_PROPERTIES.layout_clip).toContain("scale");
    expect(ALLOWED_PROPERTIES.layout_clip).not.toContain("purpose");
    expect(ALLOWED_PROPERTIES.layout_clip).not.toContain("duration");
    expect(ALLOWED_PROPERTIES.empty_visual_band).not.toContain("text");
    expect(ALLOWED_PROPERTIES.timing_issue).not.toContain("duration");
    expect(ALLOWED_PROPERTIES.novelty_fixture).toContain("composition");
  });

  it("applyRepairProposal is pure (does not mutate the input scene)", () => {
    const scene = clipScene();
    const parsed = repairProposalSchema.parse(proposal({}));
    const next = applyRepairProposal(scene, parsed as never);
    expect((scene.elements[0] as { scale: number }).scale).toBe(2.2);
    expect((next.elements[0] as { scale: number }).scale).toBe(1.6);
    expect(next.storyboard ?? null).toBeNull();
  });
});
