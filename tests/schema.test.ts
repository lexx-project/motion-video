import { describe, it, expect } from "vitest";
import { validateScene, validateProjectTimeline, totalDurationSec } from "../src/validation/validate";
import { sceneSchema } from "../src/validation/schema";

const validScene = () => ({
  sceneId: "scene_01",
  duration: 4,
  purpose: "show repetitive behavior",
  visualConcept: "repeating_daily_cards",
  composition: "asymmetric",
  headline: { text: "JANGAN ULANGI POLA YANG SAMA", accentWords: ["ULANGI"], align: "center" },
  elements: [
    { primitive: "GenericCard", variant: "daily", position: "left", label: "HARI 1" },
    { primitive: "ProgressBar", position: "right", value: 0.5 },
  ],
  motion: { entrance: "reveal", emphasis: "subtleScale", exit: "fade" },
  timing: { entranceAt: 0, emphasisAt: 2 },
});

describe("scene schema", () => {
  it("accepts a valid scene (Master Spec section 8 example shape)", () => {
    const r = validateScene(validScene());
    expect(r.success, r.errors.join("\n")).toBe(true);
  });

  it("rejects an unknown primitive with an actionable error", () => {
    const s = validScene();
    (s.elements[0] as { primitive: string }).primitive = "Hologram3D";
    const r = validateScene(s);
    expect(r.success).toBe(false);
    expect(r.errors.join(" ")).toMatch(/Unknown primitive "Hologram3D"/);
  });

  it("rejects zero and negative durations", () => {
    const a = { ...validScene(), duration: 0 };
    const b = { ...validScene(), duration: -3 };
    expect(validateScene(a).success).toBe(false);
    expect(validateScene(b).success).toBe(false);
    expect(validateScene(a).errors.join(" ")).toMatch(/duration/i);
  });

  it("rejects an invalid position", () => {
    const s = validScene();
    (s.elements[0] as { position: string }).position = "everywhere";
    const r = validateScene(s);
    expect(r.success).toBe(false);
  });

  it("rejects motion outside the allowed vocabulary", () => {
    const s = validScene();
    (s.motion as { entrance: string }).entrance = "shake";
    const r = validateScene(s);
    expect(r.success).toBe(false);
    expect(r.errors.join(" ")).toMatch(/entrance/);
  });

  it("rejects malformed timing (emphasisAt beyond duration)", () => {
    const s = { ...validScene(), duration: 2, timing: { entranceAt: 0, emphasisAt: 9 } };
    const r = validateScene(s);
    expect(r.success).toBe(false);
    expect(r.errors.join(" ")).toMatch(/emphasisAt/);
  });

  it("rejects a missing required field", () => {
    const s = validScene() as Record<string, unknown>;
    delete s.purpose;
    expect(validateScene(s).success).toBe(false);
  });

  it("rejects an over-long headline in a narrow left/right anchor", () => {
    const s = { ...validScene(), composition: "leftTextRightObject" };
    s.headline = { text: "THIS HEADLINE IS DEFINITELY WAY TOO LONG FOR A NARROW COLUMN", accentWords: [], align: "left" };
    const r = validateScene(s);
    expect(r.success).toBe(false);
    expect(r.errors.join(" ")).toMatch(/narrow|anchor/i);
  });

  it("allows a short headline in a narrow anchor", () => {
    const s = { ...validScene(), composition: "leftTextRightObject" };
    s.headline = { text: "START SMALL", accentWords: [], align: "left" };
    expect(validateScene(s).success).toBe(true);
  });

  it("rejects an outward offset that pushes content past the safe margin", () => {
    const s = validScene();
    (s.elements[0] as { offsetX?: number }).offsetX = -14; // left anchor + negative offset = clipped
    (s.elements[0] as { position?: string }).position = "left";
    const r = validateScene(s);
    expect(r.success).toBe(false);
    expect(r.errors.join(" ")).toMatch(/safe margin|clipped/);
  });

  it("allows an inward offset from an edge anchor", () => {
    const s = validScene();
    (s.elements[0] as { offsetX?: number }).offsetX = 4;
    (s.elements[0] as { position?: string }).position = "left";
    expect(validateScene(s).success).toBe(true);
  });

  it("rejects an invalid parameter type", () => {
    const s = validScene();
    (s.elements[1] as { value: unknown }).value = "half";
    const r = validateScene(s);
    expect(r.success).toBe(false);
    expect(r.errors.join(" ")).toMatch(/value/);
  });

  it("rejects unknown element params (strict)", () => {
    const s = validScene();
    (s.elements[0] as Record<string, unknown>).positon = "left";
    expect(validateScene(s).success).toBe(false);
  });

  it("rejects more than max elements (negative space rule)", () => {
    const s = validScene();
    s.elements = Array.from({ length: 6 }, (_, i) => ({
      primitive: "Circle",
      position: "center",
      key: i,
    })) as unknown as typeof s.elements;
    const r = validateScene(s);
    expect(r.success).toBe(false);
    expect(r.errors.join(" ")).toMatch(/elements/);
  });

  it("rejects more than 2 accent words", () => {
    const s = validScene();
    (s.headline as { accentWords: string[] }).accentWords = ["A", "B", "C"];
    expect(validateScene(s).success).toBe(false);
  });

  it("rejects an invalid sceneId", () => {
    const s = { ...validScene(), sceneId: "scene one!" };
    expect(validateScene(s).success).toBe(false);
  });

  it("zod schema parse surfaces path-level messages", () => {
    const r = sceneSchema.safeParse({ ...validScene(), composition: "diagonal" });
    expect(r.success).toBe(false);
  });
});

describe("project timeline validation", () => {
  it("flags duplicate scene ids", () => {
    const a = validScene();
    const b = { ...validScene() };
    const r = validateScene(a);
    const errors = validateProjectTimeline([r.scene!, r.scene!]);
    expect(errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("sums total duration", () => {
    const s = validateScene(validScene()).scene!;
    expect(totalDurationSec([s, s])).toBe(8);
  });
});
