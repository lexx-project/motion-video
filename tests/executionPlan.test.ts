import { describe, it, expect } from "vitest";
import {
  compileExecutionPlan,
  resolveExecutionPlan,
  promisedEventSchedule,
  promisedEventId,
  isSupportedEventType,
  executionPlanSchema,
  EVENT_ACTION,
  SUPPORTED_EVENT_LIST_TEXT,
} from "../src/validation/executionPlan";
import { validateScene } from "../src/validation/validate";
import { storyboardSchema } from "../src/validation/storyboardSchema";
import { passScene, missingEventScene, legacyStoryboardScene, PASS_DURATION } from "./fixtures/batchD";
import type { SceneSpec } from "../src/validation/schema";
import type { Storyboard } from "../src/validation/storyboardSchema";

const sbOf = (scene: SceneSpec): Storyboard => scene.storyboard as Storyboard;

const rawPlanScene = (events: unknown[], duration = PASS_DURATION): Record<string, unknown> => ({
  sceneId: "scene_01",
  duration,
  purpose: "test plan validation",
  visualConcept: "plan",
  composition: "centered",
  elements: [{ primitive: "Circle", position: "center", role: "semantic", purpose: "obj", semanticId: "obj_01" }],
  motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
  executionPlan: { schema: "execution-plan/1", events },
});

const moveEvent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "event_01",
  atSeconds: 2.0,
  type: "move",
  action: "moveTo",
  target: "obj_01",
  durationSec: 0.35,
  easing: "easeInOut",
  provenance: "derived",
  ...over,
});

describe("execution plan (Batch D / §5-§8)", () => {
  it("compiles storyboard motion beats into executable events with stable ids", () => {
    const plan = compileExecutionPlan(passScene());
    expect(plan.schema).toBe("execution-plan/1");
    expect(plan.events.map((e) => e.id)).toEqual(["event_01", "event_02", "event_03"]);
    expect(plan.events.map((e) => e.type)).toEqual(["enter", "move", "scale"]);
    expect(plan.events[0].action).toBe(EVENT_ACTION.enter);
    const move = plan.events.find((e) => e.id === "event_02")!;
    expect(move.target).toBe("person_01");
    expect(move.destination).toBe("gate_01");
    expect(move.provenance).toBe("explicit");
    expect(move.atSeconds).toBeCloseTo(2.6, 5);
    const scale = plan.events.find((e) => e.id === "event_03")!;
    expect(scale.to).toBeCloseTo(1.35, 5);
  });

  it("preserves explicit atSeconds and derives missing timing deterministically", () => {
    const scene = passScene();
    const schedule = promisedEventSchedule(scene);
    expect(schedule.map((s) => s.atSeconds)).toEqual([0.8, 2.6, 3.6]);
    expect(schedule.every((s) => s.provenance === "explicit")).toBe(true);

    const raw = JSON.parse(JSON.stringify(scene)) as SceneSpec;
    delete (raw.storyboard as { motionBeats: { atSeconds?: number }[] }).motionBeats[1].atSeconds;
    const derived = compileExecutionPlan(raw).events.find((e) => e.id === "event_02")!;
    expect(derived.provenance).toBe("derived");
    // deterministic spread: duration * (i+1)/(n+1) for i=1 of 3 beats
    expect(derived.atSeconds).toBeCloseTo((PASS_DURATION * 2) / 4, 3);
    // same input -> same output (no randomness)
    expect(compileExecutionPlan(raw).events.find((e) => e.id === "event_02")!.atSeconds).toBe(derived.atSeconds);
  });

  it("treats out-of-window atSeconds as unusable and derives instead", () => {
    const raw = JSON.parse(JSON.stringify(passScene())) as SceneSpec;
    const beats = (raw.storyboard as Storyboard).motionBeats;
    beats[0].atSeconds = 99; // outside the scene
    beats[2].atSeconds = 0.01; // no room for a pre-state
    const plan = compileExecutionPlan(raw);
    expect(plan.events.find((e) => e.id === "event_01")!.provenance).toBe("derived");
    expect(plan.events.find((e) => e.id === "event_03")!.provenance).toBe("derived");
    expect(plan.events.every((e) => e.atSeconds > 0 && e.atSeconds <= PASS_DURATION)).toBe(true);
  });

  it("keeps unsupported event types as promises (never silently executed)", () => {
    const scene = missingEventScene(); // sanity: fixture compiles
    expect(scene.executionPlan).toBeTruthy();
    const raw = JSON.parse(JSON.stringify(passScene())) as SceneSpec;
    (raw.storyboard as Storyboard).motionBeats[1].eventType = "morph";
    const plan = compileExecutionPlan(raw);
    const morph = plan.events.find((e) => e.id === "event_02")!;
    expect(morph.type).toBe("morph");
    expect(morph.action).toBe("unsupported");
    expect(isSupportedEventType("morph")).toBe(false);
    expect(isSupportedEventType("move")).toBe(true);
    expect(SUPPORTED_EVENT_LIST_TEXT).toContain("move");
  });

  it("drops unbound beats (eventType without target) - the gate reports them", () => {
    const raw = JSON.parse(JSON.stringify(passScene())) as SceneSpec;
    delete (raw.storyboard as Storyboard).motionBeats[1].target;
    const plan = compileExecutionPlan(raw);
    expect(plan.events.map((e) => e.id)).toEqual(["event_01", "event_03"]);
    expect(promisedEventSchedule(raw).find((s) => s.id === "event_02")!.target).toBeNull();
  });

  it("resolveExecutionPlan prefers the explicit embed and falls back to the storyboard", () => {
    const scene = passScene();
    expect(resolveExecutionPlan(scene).events.length).toBe(3);
    const stripped = { ...scene } as SceneSpec & { executionPlan?: unknown };
    delete stripped.executionPlan;
    expect(resolveExecutionPlan(stripped).events.length).toBe(3); // derived from storyboard
    const legacy = legacyStoryboardScene();
    expect(resolveExecutionPlan(legacy).events.length).toBe(0);
  });

  it("plan schema rejects malformed events (missing timing / bad id)", () => {
    expect(executionPlanSchema.safeParse({ schema: "execution-plan/1", events: [{ type: "move", target: "a" }] }).success).toBe(false);
    expect(
      executionPlanSchema.safeParse({
        schema: "execution-plan/1",
        events: [{ id: "ev1", atSeconds: 1, type: "move", action: "moveTo", target: "a" }],
      }).success,
    ).toBe(false);
    expect(executionPlanSchema.safeParse({ schema: "execution-plan/1", events: [moveEvent()] }).success).toBe(true);
  });

  it("scene validation rejects out-of-range and duplicate plan events", () => {
    const late = validateScene(rawPlanScene([moveEvent({ atSeconds: 9 })]));
    expect(late.success).toBe(false);
    expect(late.errors.join(" ")).toMatch(/exceeds scene duration/);

    const dup = validateScene(rawPlanScene([moveEvent(), moveEvent({ atSeconds: 3 })]));
    expect(dup.success).toBe(false);
    expect(dup.errors.join(" ")).toMatch(/duplicate execution event id/);

    const ok = validateScene(rawPlanScene([moveEvent()]));
    expect(ok.success).toBe(true);
  });

  it("promisedEventId falls back to the beat index", () => {
    expect(promisedEventId({ order: 1, action: "a", purpose: "b" } as never, 2)).toBe("event_03");
    expect(promisedEventId({ order: 1, action: "a", purpose: "b", id: "event_09" } as never, 2)).toBe("event_09");
  });
});

describe("semantic id contract (Batch D / §12)", () => {
  const withElement = (el: Record<string, unknown>): ReturnType<typeof validateScene> =>
    validateScene({
      sceneId: "scene_01",
      duration: 3,
      purpose: "semantic id validation",
      visualConcept: "ids",
      composition: "centered",
      elements: [el],
      motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    });

  it("accepts stable ids and rejects malformed ones", () => {
    expect(withElement({ primitive: "Circle", position: "center", semanticId: "gate_01" }).success).toBe(true);
    const bad = withElement({ primitive: "Circle", position: "center", semanticId: "1bad id" });
    expect(bad.success).toBe(false);
    expect(bad.errors.join(" ")).toMatch(/stable identifier/);
  });

  it("rejects duplicate semantic ids (ambiguous resolution)", () => {
    const r = validateScene({
      sceneId: "scene_01",
      duration: 3,
      purpose: "duplicate ids",
      visualConcept: "ids",
      composition: "centered",
      elements: [
        { primitive: "Circle", position: "left", semanticId: "obj_01" },
        { primitive: "Circle", position: "right", semanticId: "obj_01" },
      ],
      motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    });
    expect(r.success).toBe(false);
    expect(r.errors.join(" ")).toMatch(/duplicate semanticId/);
  });

  it("rejects self-attachment", () => {
    const r = withElement({ primitive: "Circle", position: "center", semanticId: "obj_01", attachTo: "obj_01" });
    expect(r.success).toBe(false);
    expect(r.errors.join(" ")).toMatch(/cannot attach to itself/);
  });

  it("storyboard contract accepts executable beats and structured relationships", () => {
    expect(() => storyboardSchema.parse(sbOf(passScene()))).not.toThrow();
    const sb = sbOf(passScene());
    expect(sb.semanticObjects.every((o) => o.id)).toBe(true);
    expect(sb.motionBeats.every((m) => m.eventType && m.target && m.id)).toBe(true);
    expect(sb.relationships[0].type).toBe("movesToward");
  });
});
