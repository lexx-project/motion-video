import { describe, it, expect } from "vitest";
import {
  evaluateSemanticEnactment,
  ENACTMENT,
  type SemanticEnactmentReport,
} from "../src/validation/semanticEnactment";
import { validateScene } from "../src/validation/validate";
import { compileExecutionPlan, TRANSITION_DEFAULT_SEC } from "../src/validation/executionPlan";
import { sceneStateAt, stateForSemanticId } from "../src/scenes/state";
import { elementExecutionAt } from "../src/scenes/execution";
import {
  passScene,
  missingObjectScene,
  missingEventScene,
  notExecutedScene,
  timingMismatchScene,
  relationshipFailureScene,
  unsupportedEventScene,
  legacyStoryboardScene,
  allBrokenFixtures,
  PASS_DURATION,
} from "./fixtures/batchD";
import type { SceneSpec } from "../src/validation/schema";
import type { Storyboard } from "../src/validation/storyboardSchema";

/** Minimal scene with one semantic object + one promised event (detection unit tests). */
function miniScene(opts: {
  duration?: number;
  element: Record<string, unknown>;
  beat: Record<string, unknown>;
  extraElements?: Record<string, unknown>[];
  relationship?: Record<string, unknown>;
  expectedId?: string;
}): SceneSpec {
  const duration = opts.duration ?? 4;
  const id = String((opts.element as { semanticId?: string }).semanticId ?? "obj_01");
  const storyboard = {
    beatId: "b1",
    spokenMeaning: "meaning for the mini scene fixture",
    viewerTakeaway: "takeaway",
    visualMechanism: "mini",
    visualNarrative: [
      { order: 1, action: "step", meaning: "meaning", visualEvidence: "evidence" },
    ],
    semanticObjects: [
      { id, objectType: "object", semanticRole: "role", relationship: "rel", importance: 3 },
      ...(opts.expectedId
        ? [{ id: opts.expectedId, objectType: "other", semanticRole: "role", relationship: "rel", importance: 3 }]
        : []),
    ],
    relationships: opts.relationship ? [opts.relationship] : [],
    typographyPlan: { headline: "MINI", emphasisWords: [], supportingText: [] },
    subtitlePlan: { enabled: false, text: "", timing: "", role: "" },
    motionBeats: [opts.beat],
    compositionIntent: "centered single object",
    visualEvidence: ["state changes"],
    forbiddenInterpretations: [],
    noveltyIntent: "mini fixture",
    elementBudget: { min: 1, max: 3 },
  };
  const raw = {
    sceneId: "scene_01",
    duration,
    purpose: "detection unit fixture",
    visualConcept: "mini detection",
    composition: "centered",
    elements: [opts.element, ...(opts.extraElements ?? [])],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    storyboard,
  } as unknown as SceneSpec;
  (raw as Record<string, unknown>).executionPlan = compileExecutionPlan(raw);
  const parsed = validateScene(raw, "scene_01");
  if (!parsed.success || !parsed.scene) throw new Error(`mini fixture invalid: ${parsed.errors.join("; ")}`);
  return parsed.scene;
}

const statusOf = (report: SemanticEnactmentReport, eventId: string): string =>
  report.scenes[0].events.find((e) => e.eventId === eventId)?.status ?? "absent";

describe("semantic enactment gate - PASS contract (Batch D / §18)", () => {
  it("passes the full contract: objects, events, timing and relationships", () => {
    const report = evaluateSemanticEnactment([passScene()]);
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.toleranceSec).toBe(ENACTMENT.timingToleranceSec);
    const s = report.scenes[0];
    expect(s.contractActive).toBe(true);
    expect(s.objects.missing).toEqual([]);
    expect(s.events.map((e) => e.status)).toEqual(["pass", "pass", "pass"]);
    expect(s.relationships[0].status).toBe("pass");
    expect(s.summary).toBe("objects=2/2 events=3/3 relationships=1/1");
    expect(report.compact[0]).toBe(`scene_01: ${s.summary}`);
  });

  it("records before/at/after state snapshots and detection evidence for every event", () => {
    const report = evaluateSemanticEnactment([passScene()]);
    for (const ev of report.scenes[0].events) {
      expect(ev.before).not.toBeNull();
      expect(ev.at).not.toBeNull();
      expect(ev.after).not.toBeNull();
      expect(ev.detected).toBe(true);
      expect(ev.confidence).toBe(1);
      expect(ev.detectedAt).not.toBeNull();
      expect(Math.abs(ev.timingDeltaSec ?? 99)).toBeLessThanOrEqual(ENACTMENT.timingToleranceSec);
      expect(ev.evidence.length).toBeGreaterThan(20);
      expect(ev.planAt).not.toBeNull();
    }
  });

  it("proves the plan actually changes rendered state (execution drives rendering)", () => {
    const scene = passScene();
    const personAt0 = stateForSemanticId(scene, "person_01", 0)!;
    const personAfterEnter = stateForSemanticId(scene, "person_01", 1.2)!;
    expect(personAt0.visible).toBe(false);
    expect(personAfterEnter.visible).toBe(true);
    const personAfterMove = stateForSemanticId(scene, "person_01", 3.0)!;
    expect(Math.hypot(personAfterMove.x - personAfterEnter.x, personAfterMove.y - personAfterEnter.y)).toBeGreaterThanOrEqual(
      ENACTMENT.moveExecPx,
    );
    const gateBefore = stateForSemanticId(scene, "gate_01", 2.0)!;
    const gateAfter = stateForSemanticId(scene, "gate_01", 4.0)!;
    expect(gateAfter.scale / gateBefore.scale).toBeCloseTo(1.35, 1);
  });

  it("is deterministic: identical scenes produce identical reports", () => {
    const a = evaluateSemanticEnactment([passScene()]);
    const b = evaluateSemanticEnactment([passScene()]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("legacy storyboards (no ids / no event types) form no contract", () => {
    const report = evaluateSemanticEnactment([legacyStoryboardScene()]);
    expect(report.ok).toBe(true);
    expect(report.scenes[0].contractActive).toBe(false);
    expect(report.scenes[0].summary).toBe("no semantic contract");
  });
});

describe("event detection (Batch D / §20)", () => {
  it("detects ENTER as an opacity transition", () => {
    const report = evaluateSemanticEnactment([passScene()]);
    const ev = report.scenes[0].events.find((e) => e.eventId === "event_01")!;
    expect(ev.status).toBe("pass");
    expect(ev.before!.opacity).toBeLessThan(0.3); // pre sample sits inside the entry ramp
    expect(ev.at!.opacity).toBeGreaterThan(0.85);
  });

  it("detects MOVE as a position delta toward the destination", () => {
    const report = evaluateSemanticEnactment([passScene()]);
    const ev = report.scenes[0].events.find((e) => e.eventId === "event_02")!;
    expect(ev.status).toBe("pass");
    const dx = ev.after!.x - ev.before!.x;
    expect(Math.abs(dx)).toBeGreaterThanOrEqual(ENACTMENT.moveExecPx);
    const gate = stateForSemanticId(passScene(), "gate_01", 0)!;
    const beforeDist = Math.hypot(ev.before!.x - gate.x, ev.before!.y - gate.y);
    const afterDist = Math.hypot(ev.after!.x - gate.x, ev.after!.y - gate.y);
    expect(beforeDist - afterDist).toBeGreaterThanOrEqual(ENACTMENT.approachPx);
  });

  it("detects SCALE as a scale delta and checks the final multiplier", () => {
    const scene = passScene();
    const report = evaluateSemanticEnactment([scene]);
    const ev = report.scenes[0].events.find((e) => e.eventId === "event_03")!;
    expect(ev.status).toBe("pass");
    const gateAt0 = stateForSemanticId(scene, "gate_01", 0)!.scale;
    expect(ev.after!.scale / gateAt0).toBeCloseTo(1.35, 1);
    expect(ev.expected).toContain("1.35");
  });

  it("detects FADE as an opacity change to the promised value", () => {
    const scene = miniScene({
      element: { primitive: "Circle", position: "center", semanticId: "obj_01", diameterPct: 30, delay: 0, entrance: "fade" },
      beat: { order: 1, action: "dims", purpose: "fade out", id: "event_01", target: "obj_01", eventType: "fade", atSeconds: 2.0, expected: { from: 1, to: 0.2 } },
    });
    const report = evaluateSemanticEnactment([scene]);
    expect(report.ok).toBe(true);
    const ev = report.scenes[0].events[0];
    expect(ev.status).toBe("pass");
    expect(ev.before!.opacity).toBeGreaterThan(0.85);
    expect(ev.after!.opacity).toBeCloseTo(0.2, 1);
  });

  it("detects REPLACE: source hidden while the replacement becomes visible", () => {
    const scene = miniScene({
      duration: 4,
      element: { primitive: "GenericCard", position: "center", semanticId: "card_a", label: "BEFORE", delay: 0, entrance: "fade" },
      extraElements: [{ primitive: "GenericCard", position: "bottom", semanticId: "card_b", label: "AFTER", delay: 0, entrance: "fade" }],
      expectedId: "card_b",
      beat: { order: 1, action: "card swaps", purpose: "replacement", id: "event_01", target: "card_a", eventType: "replace", atSeconds: 2.0, expected: { with: "card_b" } },
    });
    const report = evaluateSemanticEnactment([scene]);
    const ev = report.scenes[0].events[0];
    expect(ev.status).toBe("pass");
    expect(ev.before!.opacity).toBeGreaterThan(0.7); // partially swapped at the pre sample
    expect(ev.after!.opacity).toBeLessThan(0.15);
    // the replacement became visible
    const bAfter = stateForSemanticId(scene, "card_b", 2.25)!;
    expect(bAfter.opacity).toBeGreaterThan(0.85);
    expect(report.ok).toBe(true);
  });

  it("marks unsupported event types as unsupported_event with confidence 0", () => {
    const report = evaluateSemanticEnactment([unsupportedEventScene()]);
    const ev = report.scenes[0].events.find((e) => e.eventId === "event_02")!;
    expect(ev.status).toBe("unsupported_event");
    expect(ev.confidence).toBe(0);
    expect(ev.detected).toBe(false);
    expect(ev.evidence).toContain("morph");
    expect(ev.evidence).toContain("supported");
  });
});

describe("event timing tolerance (Batch D / §19)", () => {
  const withPlanTime = (promiseBuilt: SceneSpec, atSeconds: number): SceneSpec => {
    const raw = JSON.parse(JSON.stringify(promiseBuilt)) as SceneSpec;
    const plan = raw.executionPlan as { events: { id: string; atSeconds: number }[] };
    plan.events.find((e) => e.id === "event_03")!.atSeconds = atSeconds;
    const parsed = validateScene(raw, "scene_01");
    if (!parsed.success || !parsed.scene) throw new Error(parsed.errors.join("; "));
    return parsed.scene;
  };

  it("passes when the detected time is inside the documented tolerance", () => {
    // promise 3.6s, plan lands at 3.8s -> |delta| ~0.2 <= 0.30
    const scene = withPlanTime(passScene(), 3.8);
    const report = evaluateSemanticEnactment([scene]);
    const ev = report.scenes[0].events.find((e) => e.eventId === "event_03")!;
    expect(ev.status).toBe("pass");
    expect(Math.abs(ev.timingDeltaSec!)).toBeLessThanOrEqual(ENACTMENT.timingToleranceSec);
  });

  it("fails when the detected time is outside the tolerance", () => {
    const scene = withPlanTime(passScene(), 4.4);
    const report = evaluateSemanticEnactment([scene]);
    expect(report.ok).toBe(false);
    expect(statusOf(report, "event_03")).toBe("event_timing_mismatch");
    const failure = report.failures.find((f) => f.type === "event_timing_mismatch")!;
    expect(failure.magnitude).toBeGreaterThan(ENACTMENT.timingToleranceSec);
    expect(failure.evidence).toContain("tolerance");
  });

  it("tolerance is explicit, documented and not silently wide", () => {
    expect(ENACTMENT.timingToleranceSec).toBe(0.3);
    expect(ENACTMENT.eventWindowSec).toBe(0.25);
    // the transition window MUST outlast the tolerance or early executions could pass
    expect(TRANSITION_DEFAULT_SEC).toBeGreaterThan(ENACTMENT.timingToleranceSec);
  });
});

describe("semantic failure classification (Batch D / §21)", () => {
  it("PASS fixture has no failures", () => {
    expect(evaluateSemanticEnactment([passScene()]).ok).toBe(true);
  });

  it.each(allBrokenFixtures())("$name -> $expected", ({ scene, expected }) => {
    const report = evaluateSemanticEnactment([scene]);
    expect(report.ok).toBe(false);
    const types = report.failures.map((f) => f.type);
    expect(types).toContain(expected);
    // each broken fixture produces exactly ONE classification (cascades are suppressed)
    expect(types).toEqual([expected]);
  });

  it("missing object names the exact id and never blames a similar object", () => {
    const report = evaluateSemanticEnactment([missingObjectScene()]);
    const f = report.failures[0];
    expect(f.type).toBe("missing_semantic_object");
    expect(f.target).toEqual(["gate_01"]);
    expect(f.evidence).toContain("gate_01");
    expect(f.severity).toBe("hard");
    expect(f.source).toBe("deterministic-semantic");
    expect(report.scenes[0].objects.missing).toEqual(["gate_01"]);
    expect(report.scenes[0].objects.present).toEqual(["person_01"]);
  });

  it("missing event keeps the promise and reports the event id", () => {
    const report = evaluateSemanticEnactment([missingEventScene()]);
    expect(report.failures[0].type).toBe("missing_event");
    expect(report.failures[0].target).toContain("event_02");
    expect(report.failures[0].evidence).toContain("2.60");
  });

  it("relationship failure reports both endpoints", () => {
    const report = evaluateSemanticEnactment([relationshipFailureScene()]);
    expect(report.failures[0].type).toBe("relationship_failed");
    expect(report.failures[0].target).toEqual(["person_01", "ghost_01"]);
    expect(report.failures[0].evidence).toContain("ghost_01");
  });

  it("state transition failure fires when the final state misses the promise", () => {
    // promise says scale to 1.5 but the plan only reaches 1.25
    const raw = JSON.parse(JSON.stringify(passScene())) as SceneSpec;
    const beat = (raw.storyboard as Storyboard).motionBeats[2];
    beat.expected = { from: 1, to: 1.5 };
    const plan = raw.executionPlan as { events: { id: string; to?: number }[] };
    plan.events.find((e) => e.id === "event_03")!.to = 1.25;
    const scene = validateScene(raw, "scene_01").scene!;
    const report = evaluateSemanticEnactment([scene]);
    expect(report.failures.map((f) => f.type)).toEqual(["state_transition_failed"]);
    expect(report.failures[0].evidence).toContain("1.5");
  });
});

describe("relationship contract (Batch D / §14-§15)", () => {
  it("attachedTo holds through the parent transform (child follows parent)", () => {
    const scene = passScene();
    // declare attachment: badge (person) attached to the gate is NOT the fixture - build a direct case
    const raw = JSON.parse(JSON.stringify(scene)) as SceneSpec;
    (raw.elements[0] as { attachTo?: string }).attachTo = "gate_01";
    const child0 = stateForSemanticId(raw, "person_01", 0)!;
    const child1 = stateForSemanticId(raw, "person_01", 4.0)!;
    expect(child0.attachedTo).toBe("gate_01");
    // parent has no move of its own, but the child keeps its local state and the relation
    expect(child1.attachedTo).toBe("gate_01");
  });

  it("a child inherits its parent's execution offset (minimal attachTo semantics)", () => {
    const raw = JSON.parse(JSON.stringify(passScene())) as SceneSpec;
    const els = raw.elements as Record<string, unknown>[];
    // append a badge attached to the person (the gate stays a promised object)
    els.push({
      primitive: "Badge",
      text: "TAG",
      position: "left",
      offsetY: 12,
      role: "supporting",
      purpose: "rides along",
      semanticId: "badge_01",
      attachTo: "person_01",
    });
    const sb = raw.storyboard as Storyboard;
    sb.semanticObjects.push({
      id: "badge_01",
      objectType: "badge",
      semanticRole: "follows the person",
      relationship: "attached to the person",
      importance: 2,
    });
    sb.relationships = [
      { from: "badge_01", to: "person_01", relationship: "rides along", type: "attachedTo" },
      ...sb.relationships,
    ];
    const parsed = validateScene(raw, "scene_01");
    expect(parsed.success, parsed.errors.join("; ")).toBe(true);
    const scene = parsed.scene!;
    const p0 = stateForSemanticId(scene, "person_01", 0)!;
    const p1 = stateForSemanticId(scene, "person_01", 4.0)!;
    const b0 = stateForSemanticId(scene, "badge_01", 0)!;
    const b1 = stateForSemanticId(scene, "badge_01", 4.0)!;
    // the badge moved exactly as far as its parent (same execution delta)
    expect((b1.x - b0.x) - (p1.x - p0.x)).toBeCloseTo(0, 1);
    expect(b1.x - b0.x).toBeGreaterThanOrEqual(ENACTMENT.moveExecPx);
    const report = evaluateSemanticEnactment([scene]);
    const rel = report.scenes[0].relationships.find((r) => r.type === "attachedTo")!;
    expect(rel.status).toBe("pass");
    expect(rel.suppressed).toBe(false);
  });

  it("movesToward fails when the distance never closes", () => {
    // promise the relationship but give the plan no destination (nothing moves)
    const report = evaluateSemanticEnactment([notExecutedScene()]);
    const rel = report.scenes[0].relationships[0];
    // suppressed because the mover's own event already failed (root cause reported)
    expect(rel.suppressed).toBe(true);
    expect(report.failures.map((f) => f.type)).toEqual(["event_not_executed"]);
  });

  it("near relationship checks the final anchor distance", () => {
    const raw = JSON.parse(JSON.stringify(passScene())) as SceneSpec;
    const sb = raw.storyboard as Storyboard;
    sb.relationships = [{ from: "person_01", to: "gate_01", relationship: "stands close", type: "near" }];
    const parsed = validateScene(raw, "scene_01");
    const report = evaluateSemanticEnactment([parsed.scene!]);
    const rel = report.scenes[0].relationships[0];
    expect(rel.status).toBe("pass");
    expect(rel.distanceAfterPx).not.toBeNull();
    expect(rel.distanceAfterPx!).toBeLessThanOrEqual(ENACTMENT.nearPx);
  });
});

describe("state extraction (Batch D / §11)", () => {
  it("returns deterministic per-element state without rendering", () => {
    const scene = passScene();
    const t0 = sceneStateAt(scene, 0);
    const t1 = sceneStateAt(scene, 0);
    expect(JSON.stringify(t0)).toBe(JSON.stringify(t1));
    expect(t0).toHaveLength(2);
    expect(t0[0].semanticId).toBe("person_01");
    expect(t0[0].primitive).toBe("Person");
    expect(typeof t0[0].x).toBe("number");
    expect(typeof t0[0].opacity).toBe("number");
    expect(t0[0].visible).toBe(false); // enter has not happened yet
    expect(sceneStateAt(scene, 3.0)[0].visible).toBe(true);
    // the scene-level exit fade hides everything at the very end (renderer behaviour)
    expect(sceneStateAt(scene, PASS_DURATION)[0].visible).toBe(false);
  });

  it("neutral execution leaves plan-less scenes untouched", () => {
    const scene = legacyStoryboardScene();
    const exec = elementExecutionAt(scene, 0, 1.0);
    expect(exec).toEqual({ dx: 0, dy: 0, scaleMul: 1, rotation: 0, opacity: 1, reveal: 1, progress: null, attached: null });
  });
});
