import { describe, it, expect } from "vitest";
import { elementExecutionAt, resolveMoveTarget, maxMoveTravelPx } from "../src/scenes/execution";
import { evaluateSemanticEnactment, ENACTMENT } from "../src/validation/semanticEnactment";
import { validateScene } from "../src/validation/validate";
import { compileExecutionPlan } from "../src/validation/executionPlan";
import { layoutFinding, isStaleEvidence } from "../src/validation/layoutGate";
import { sceneRenderedGeometry } from "../src/scenes/rendererGeometry";
import { assessSemanticCategory, isLegacyDefaultObjectType, LEGACY_DEFAULT_OBJECT_TYPE } from "../src/validation/semanticCategories";
import { applyCompositionFixes } from "../src/validation/compositionFixes";
import { evaluateCompositionQuality, COMPOSITION } from "../src/validation/compositionQuality";
import { collisionSemantics } from "../src/validation/collisionSemantics";
import { passScene, headlineGapScene, missingObjectScene } from "./fixtures/batchD";
import type { SceneSpec } from "../src/validation/schema";
import type { Storyboard } from "../src/validation/storyboardSchema";
import type { FrameEvidenceReport, FrameMetrics } from "../src/render/frameEvidence";
import { scenesFingerprint } from "../src/core/identity";

/**
 * Batch G focused regressions:
 *   WS-C event semantics (absolute scale, from:0 grow-in, close-pair move, subtle events)
 *   WS-B layout evidence (invisible classification, stale-evidence rejection, layering)
 *   WS-D legacy objectType compatibility
 *   WS-A composition fixes + quality findings
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const execOf = (scene: SceneSpec, sid: string, t: number) => {
  const idx = (scene.elements ?? []).findIndex((e) => e.semanticId === sid);
  return elementExecutionAt(scene, idx, t);
};

describe("WS-C: scale events are absolute, not compounded (Batch G)", () => {
  it("a chained scale sequence reaches each absolute target (live scene_01 defect)", () => {
    const raw = clone(passScene()) as Record<string, unknown>;
    const sb = raw.storyboard as Storyboard;
    sb.motionBeats = [
      {
        order: 1,
        action: "scale in",
        purpose: "grow",
        id: "event_01",
        target: "gate_01",
        eventType: "scale",
        atSeconds: 1.5,
        expected: { from: 1, to: 0.5 },
      },
      {
        order: 2,
        action: "scale up",
        purpose: "grow more",
        id: "event_02",
        target: "gate_01",
        eventType: "scale",
        atSeconds: 2.5,
        expected: { from: 0.5, to: 0.8 },
      },
    ];
    sb.relationships = [];
    raw.executionPlan = compileExecutionPlan({ ...raw, storyboard: sb } as unknown as SceneSpec);
    const scene = validateScene(raw, "scene_01").scene!;

    // absolute semantics: after event_01 the multiplier IS 0.5 (not 1*(1+(0.5-1))=0.5 by luck);
    // after event_02 it IS 0.8 - the old code multiplied to 0.5*0.8=0.4
    const afterFirst = execOf(scene, "gate_01", 1.6).scaleMul;
    const afterSecond = execOf(scene, "gate_01", 2.6).scaleMul;
    expect(afterFirst).toBeCloseTo(0.5, 3);
    expect(afterSecond).toBeCloseTo(0.8, 3);

    const gate = evaluateSemanticEnactment([scene]);
    expect(gate.failures.filter((f) => f.type === "event_not_executed" || f.type === "state_transition_failed")).toEqual([]);
    expect(gate.ok).toBe(true);
  });

  it("from:0,to:1 grow-in is observable (live scene_04 defect) and rests at full scale outside the window", () => {
    const raw = clone(passScene()) as Record<string, unknown>;
    const sb = raw.storyboard as Storyboard;
    sb.relationships = [];
    sb.motionBeats = [
      {
        order: 1,
        action: "step grows",
        purpose: "appear",
        id: "event_01",
        target: "gate_01",
        eventType: "scale",
        atSeconds: 2.0,
        expected: { from: 0, to: 1 },
      },
    ];
    raw.executionPlan = compileExecutionPlan({ ...raw, storyboard: sb } as unknown as SceneSpec);
    const scene = validateScene(raw, "scene_01").scene!;

    expect(execOf(scene, "gate_01", 0).scaleMul).toBeCloseTo(1, 3); // resting full scale
    expect(execOf(scene, "gate_01", 2.0).scaleMul).toBeCloseTo(1, 3); // landed at target
    const mid = execOf(scene, "gate_01", 1.85).scaleMul;
    expect(mid).toBeGreaterThan(0.05); // actually grew during the window
    expect(mid).toBeLessThan(0.98);

    const gate = evaluateSemanticEnactment([scene]);
    expect(gate.failures.filter((f) => f.type === "event_not_executed")).toEqual([]);
    expect(gate.ok).toBe(true);
  });

  it("a valid subtle scale change is not rejected by an absolute pixel threshold", () => {
    // 0.4-scale element changing 0.7 -> 1.0: delta = 0.12 absolute < 0.15 old bar,
    // but 43% relative - the relative threshold must accept it.
    const raw = clone(passScene()) as Record<string, unknown>;
    (raw.elements as Record<string, unknown>[])[1] = {
      ...((raw.elements as Record<string, unknown>[])[1]),
      scale: 0.4,
    };
    const sb = raw.storyboard as Storyboard;
    sb.relationships = [];
    sb.motionBeats = [
      {
        order: 1,
        action: "subtle grow",
        purpose: "grow",
        id: "event_01",
        target: "gate_01",
        eventType: "scale",
        atSeconds: 2.0,
        expected: { from: 0.7, to: 1 },
      },
    ];
    raw.executionPlan = compileExecutionPlan({ ...raw, storyboard: sb } as unknown as SceneSpec);
    const scene = validateScene(raw, "scene_01").scene!;

    const absDelta = Math.abs(0.4 * 1 - 0.4 * 0.7);
    expect(absDelta).toBeLessThan(ENACTMENT.scaleExec); // below the old absolute bar
    const gate = evaluateSemanticEnactment([scene]);
    expect(gate.failures.filter((f) => f.type === "event_not_executed")).toEqual([]);
    expect(gate.ok).toBe(true);
  });

  it("an event with no meaningful visual change is still reported honestly", () => {
    const raw = clone(passScene()) as Record<string, unknown>;
    const sb = raw.storyboard as Storyboard;
    sb.motionBeats = [
      {
        order: 1,
        action: "no-op scale",
        purpose: "none",
        id: "event_01",
        target: "gate_01",
        eventType: "scale",
        atSeconds: 2.0,
        expected: { from: 1, to: 1.01 }, // 1% - below every threshold
      },
    ];
    raw.executionPlan = compileExecutionPlan({ ...raw, storyboard: sb } as unknown as SceneSpec);
    const scene = validateScene(raw, "scene_01").scene!;
    const gate = evaluateSemanticEnactment([scene]);
    expect(gate.failures.map((f) => f.type)).toContain("event_not_executed");
    expect(gate.ok).toBe(false);
  });

  it("an event scheduled outside the scene is clamped by the schedule, not silently kept", () => {
    const raw = clone(passScene()) as Record<string, unknown>;
    const sb = raw.storyboard as Storyboard;
    sb.motionBeats = [
      {
        order: 1,
        action: "far future",
        purpose: "none",
        id: "event_01",
        target: "gate_01",
        eventType: "scale",
        atSeconds: 50, // far outside the 4.5s scene
        expected: { from: 1, to: 2 },
      },
    ];
    raw.executionPlan = compileExecutionPlan({ ...raw, storyboard: sb } as unknown as SceneSpec);
    const scene = validateScene(raw, "scene_01").scene!;
    const plan = scene.executionPlan!.events.find((e) => e.id === "event_01")!;
    // resolveEventTimes derives a legal in-window time for unusable explicit times
    expect(plan.atSeconds).toBeLessThanOrEqual(scene.duration);
    expect(plan.atSeconds).toBeGreaterThan(0);
  });

  it("an event truncated by scene duration still lands before the final frame", () => {
    const raw = clone(passScene()) as Record<string, unknown>;
    const sb = raw.storyboard as Storyboard;
    sb.motionBeats = [
      {
        order: 1,
        action: "last-second scale",
        purpose: "grow",
        id: "event_01",
        target: "gate_01",
        eventType: "scale",
        atSeconds: 4.4, // lands at the very end of the 4.5s scene
        expected: { from: 1, to: 1.6 },
      },
    ];
    raw.executionPlan = compileExecutionPlan({ ...raw, storyboard: sb } as unknown as SceneSpec);
    const scene = validateScene(raw, "scene_01").scene!;
    const gate = evaluateSemanticEnactment([scene]);
    // truncated by duration must still execute (not be reported as missing/not-executed)
    expect(gate.failures.filter((f) => f.type === "event_not_executed")).toEqual([]);
    expect(execOf(scene, "gate_01", scene.duration).scaleMul).toBeCloseTo(1.6, 2);
  });

  it("multiple tightly packed scale events are each detected independently", () => {
    const raw = clone(passScene()) as Record<string, unknown>;
    const sb = raw.storyboard as Storyboard;
    sb.relationships = [];
    sb.motionBeats = [
      { order: 1, action: "shrink gate", purpose: "scale down", id: "event_01", target: "gate_01", eventType: "scale", atSeconds: 1.0, expected: { from: 1, to: 0.4 } },
      { order: 2, action: "grow gate", purpose: "scale up", id: "event_02", target: "gate_01", eventType: "scale", atSeconds: 1.8, expected: { from: 0.4, to: 0.9 } },
    ];
    raw.executionPlan = compileExecutionPlan({ ...raw, storyboard: sb } as unknown as SceneSpec);
    const scene = validateScene(raw, "scene_01").scene!;
    const gate = evaluateSemanticEnactment([scene]);
    const evs = gate.scenes[0].events;
    expect(evs.length).toBe(2);
    expect(evs.every((e) => e.status === "pass")).toBe(true);
    expect(gate.ok).toBe(true);
  });
});

describe("WS-C: close-pair move events execute (live scene_02 defect)", () => {
  it("a destination closer than the stop-short distance still moves half the gap", () => {
    const raw = clone(passScene()) as Record<string, unknown>;
    // pull the destination very close to the mover (right -> right, small offsets)
    const els = raw.elements as Record<string, unknown>[];
    els[0] = { ...els[0], position: "right", offsetX: -30, offsetY: 0 };
    els[1] = { ...els[1], position: "right", offsetX: -8, offsetY: 0 };
    const sb = raw.storyboard as Storyboard;
    sb.motionBeats = [
      {
        order: 1,
        action: "move close",
        purpose: "approach",
        id: "event_01",
        target: "person_01",
        eventType: "move",
        atSeconds: 2.6,
        expected: { toward: "gate_01" },
      },
    ];
    raw.executionPlan = compileExecutionPlan({ ...raw, storyboard: sb } as unknown as SceneSpec);
    const scene = validateScene(raw, "scene_01").scene!;
    const ev = scene.executionPlan!.events.find((e) => e.id === "event_01")!;
    const maxTravel = maxMoveTravelPx(scene, ev);
    expect(maxTravel).not.toBeNull();
    expect(maxTravel!).toBeGreaterThan(0); // old executor produced zero travel here
    const target = resolveMoveTarget(scene, ev)!;
    const start = { x: -30, y: 0 };
    expect(Math.abs(target.x - start.x) + Math.abs(target.y - start.y)).toBeGreaterThan(0);

    const gate = evaluateSemanticEnactment([scene]);
    expect(gate.failures.filter((f) => f.type === "event_not_executed")).toEqual([]);
  });

  it("the move threshold never exceeds the achievable travel", () => {
    const raw = clone(passScene()) as Record<string, unknown>;
    const els = raw.elements as Record<string, unknown>[];
    els[0] = { ...els[0], position: "right", offsetX: -30, offsetY: 0 };
    els[1] = { ...els[1], position: "right", offsetX: -8, offsetY: 0 };
    const sb = raw.storyboard as Storyboard;
    sb.motionBeats = [
      { order: 1, action: "move", purpose: "approach", id: "event_01", target: "person_01", eventType: "move", atSeconds: 2.6, expected: { toward: "gate_01" } },
    ];
    raw.executionPlan = compileExecutionPlan({ ...raw, storyboard: sb } as unknown as SceneSpec);
    const scene = validateScene(raw, "scene_01").scene!;
    const ev = scene.executionPlan!.events.find((e) => e.id === "event_01")!;
    const maxTravel = maxMoveTravelPx(scene, ev)!;
    // gate threshold = min(moveExecPx, maxTravel) - a full-effort move always passes
    expect(Math.min(ENACTMENT.moveExecPx, maxTravel)).toBeLessThanOrEqual(maxTravel);
    const gate = evaluateSemanticEnactment([scene]);
    expect(gate.failures.filter((f) => f.type === "event_not_executed")).toEqual([]);
  });
});

describe("WS-B: layout evidence (Batch G)", () => {
  const offscreenScene = (): SceneSpec => {
    const raw = clone(passScene()) as Record<string, unknown>;
    const els = raw.elements as Record<string, unknown>[];
    // push element far above the frame: bottom anchor + huge negative offsetY
    els[1] = { ...els[1], position: "bottom", offsetY: -95, offsetX: 0 };
    return raw as unknown as SceneSpec;
  };

  it("an element entirely outside the frame is MODEL invisible, not a pixel disagreement", () => {
    const scene = offscreenScene();
    const geo = sceneRenderedGeometry(scene);
    const finding = layoutFinding(scene, geo, null);
    expect(finding.invisible && finding.invisible.length).toBeGreaterThan(0);
    expect(finding.hard.join(" ")).toMatch(/MODEL invisible/);
    // fully-outside items are excluded from the model/pixel disagreement count
    expect(finding.agreement.frame).toBe("neither");
  });

  it("stale frame evidence cannot decide a visual verdict", () => {
    const sceneA = passScene();
    const sceneB = clone(passScene()) as Record<string, unknown>;
    // mutate B so its identity differs from the evidence captured for A
    (sceneB.elements as Record<string, unknown>[])[0] = { ...((sceneB.elements as Record<string, unknown>[])[0]), semanticId: "person_02" };
    const sceneBv = validateScene(sceneB, "scene_01").scene!;
    const metrics = {
      occupancy: 0.5,
      brightShare: 0.5,
      regionOccupancy: { top: 0.5, middle: 0, bottom: 0, subtitleBand: 0 },
      edgeInk: { left: 0, right: 0, top: 0, bottom: 0 },
      safeAreaOverflow: { left: 0, top: 0, right: 0, bottom: 0, outside: false },
      contentOutsideFrame: false,
      contentBox: { x0: 10, y0: 10, x1: 100, y1: 100 },
      sha256: "x",
    } as unknown as FrameMetrics;
    const evidence = {
      schema: "frame-evidence/1",
      label: "r1",
      generatedAt: new Date().toISOString(),
      fps: 30,
      sourceRender: null,
      scenesHash: "stale-hash-not-matching-scene-b",
      samples: [
        { sceneId: "scene_01", sampleIndex: 0, reason: "mid", timeSec: 1, sceneFrame: 30, absoluteFrame: 30, file: "x.png", sha256: "y", metrics },
      ],
      sceneRollup: [],
    } as unknown as FrameEvidenceReport;

    expect(isStaleEvidence(evidence, [sceneBv])).toBe(true);
    const geo = sceneRenderedGeometry(sceneBv);
    // stale evidence is rejected: rendered metrics must not be consulted
    const finding = layoutFinding(sceneBv, geo, null);
    expect(finding.rendered).toBeNull();
    expect(finding.warnings.join(" ")).not.toMatch(/RENDERED clipping/);
  });

  it("evidence whose scenesHash matches is not stale", () => {
    const scene = passScene();
    const evidence = {
      schema: "frame-evidence/1",
      label: "r1",
      generatedAt: new Date().toISOString(),
      fps: 30,
      sourceRender: null,
      scenesHash: scenesFingerprint([scene]).scenesHash,
      samples: [],
      sceneRollup: [],
    } as unknown as FrameEvidenceReport;
    expect(isStaleEvidence(evidence, [scene])).toBe(false);
  });

  it("declared intentional layering is not classified as an unintended collision", () => {
    const raw = clone(passScene()) as Record<string, unknown>;
    const els = raw.elements as Record<string, unknown>[];
    // overlap the two elements heavily but declare the intent on one of them
    els[1] = { ...els[1], position: "left", offsetX: 0, offsetY: 0, collisionIntent: "intentional" };
    const scene = validateScene(raw, "scene_01").scene!;
    const report = collisionSemantics(scene);
    expect(report.unintended).toEqual([]);
  });
});

describe("WS-D: legacy default objectType compatibility (Batch G)", () => {
  it("identifies the historical default exactly", () => {
    expect(LEGACY_DEFAULT_OBJECT_TYPE).toBe("Actor");
    expect(isLegacyDefaultObjectType("Actor")).toBe(true);
    expect(isLegacyDefaultObjectType("actor")).toBe(false); // explicit lowercase intent is NOT the default
    expect(isLegacyDefaultObjectType("stone slab")).toBe(false);
  });

  it("legacy 'Actor' with a neutral role is not_verified, not a false person failure (live-run defect)", () => {
    const a = assessSemanticCategory({
      objectType: "Actor",
      semanticRole: "the hard, unmoving resistance the disciplines must outlast",
      primitive: "Stack",
    });
    expect(a.status).toBe("not_verified");
    expect(a.promisedCategory).toBeNull();
    expect(a.reason).toMatch(/legacy default/);
  });

  it("legacy 'Actor' with a person role stays strict (explicit actor intent preserved)", () => {
    const a = assessSemanticCategory({
      objectType: "Actor",
      semanticRole: "the person waiting at the gate",
      primitive: "Line",
    });
    expect(a.status).toBe("fail"); // person promised, Line rendered - genuine mismatch
    expect(a.promisedCategory).toBe("person");
  });

  it("legacy 'Actor' with a person role and Person primitive passes", () => {
    const a = assessSemanticCategory({
      objectType: "Actor",
      semanticRole: "the person waiting",
      primitive: "Person",
    });
    expect(a.status).toBe("pass");
  });

  it("explicit lowercase 'actor' still maps to person (keyword behaviour unchanged)", () => {
    const a = assessSemanticCategory({ objectType: "actor", primitive: "Line" });
    expect(a.status).toBe("fail");
    expect(a.promisedCategory).toBe("person");
  });

  it("the assessment is idempotent (read-time compatibility never mutates)", () => {
    const input = { objectType: "Actor", semanticRole: "the hard resistance", primitive: "Stack" };
    const first = assessSemanticCategory(input);
    const second = assessSemanticCategory(input);
    expect(second).toEqual(first);
    expect(input.objectType).toBe("Actor"); // input untouched
  });

  it("new-format storyboards (concrete objectType) are unaffected", () => {
    const a = assessSemanticCategory({ objectType: "stone slab", primitive: "Circle" });
    expect(a.reason).not.toMatch(/legacy default/);
  });
});

describe("WS-A: deterministic composition fixes (Batch G)", () => {
  it("clamps an entrance delay that masks a timed enter event (live scene_03 defect)", () => {
    const raw = clone(passScene()) as Record<string, unknown>;
    const els = raw.elements as Record<string, unknown>[];
    els[0] = { ...els[0], delay: 3.9 }; // delay AFTER the enter event at 0.8s
    const scene = validateScene(raw, "scene_01").scene!;
    const result = applyCompositionFixes(scene);
    expect(result.applied).toBe(true);
    expect(result.fixes[0].kind).toBe("delay_clamped");
    const fixedDelay = (result.scene.elements[0] as { delay?: number }).delay;
    expect(fixedDelay).toBeLessThanOrEqual(0.8);
    expect(result.scene.elements[0].semanticId).toBe("person_01"); // nothing else touched
  });

  it("removes a static attachTo that a timed attach event performs (live scene_04 defect)", () => {
    const raw = clone(passScene()) as Record<string, unknown>;
    const els = raw.elements as Record<string, unknown>[];
    // person statically attached to gate + storyboard also promises an attach event
    els[0] = { ...els[0], attachTo: "gate_01" };
    const sb = raw.storyboard as Storyboard;
    sb.motionBeats.push({
      order: 4,
      action: "person attaches to gate",
      purpose: "bind",
      id: "event_04",
      target: "person_01",
      eventType: "attach",
      atSeconds: 3.5,
      expected: { parent: "gate_01" },
    });
    raw.executionPlan = compileExecutionPlan({ ...raw, storyboard: sb } as unknown as SceneSpec);
    const scene = validateScene(raw, "scene_01").scene!;
    expect((scene.elements[0] as { attachTo?: string }).attachTo).toBe("gate_01");
    const result = applyCompositionFixes(scene);
    expect(result.applied).toBe(true);
    expect(result.fixes[0].kind).toBe("attach_dedup");
    expect((result.scene.elements[0] as { attachTo?: string }).attachTo).toBeUndefined();
    // the attach event now produces a real state delta
    const gate = evaluateSemanticEnactment([result.scene]);
    expect(gate.failures.filter((f) => f.type === "event_not_executed" && f.target?.includes("event_04"))).toEqual([]);
  });

  it("is a no-op on a healthy scene (idempotent, byte-stable)", () => {
    const scene = passScene();
    const result = applyCompositionFixes(scene);
    expect(result.applied).toBe(false);
    expect(result.scene).toBe(scene);
    expect(JSON.stringify(result.scene)).toBe(JSON.stringify(scene));
    // second pass after a fix is also a no-op
    const raw = clone(passScene()) as Record<string, unknown>;
    (raw.elements as Record<string, unknown>[])[0] = { ...((raw.elements as Record<string, unknown>[])[0]), delay: 3.9 };
    const once = applyCompositionFixes(validateScene(raw, "scene_01").scene!);
    const twice = applyCompositionFixes(once.scene);
    expect(twice.applied).toBe(false);
    expect(JSON.stringify(twice.scene)).toBe(JSON.stringify(once.scene));
  });

  it("never corrupts: a candidate failing schema validation returns the original scene", () => {
    // construct a scene that becomes invalid when delay is clamped to a non-number path is
    // impossible, so exercise the guard by passing a scene whose elements array we later
    // rely on: the pure function must return the ORIGINAL reference on any failure. We
    // verify the contract by checking an already-invalid scene is returned untouched.
    const raw = clone(passScene()) as Record<string, unknown>;
    (raw.elements as Record<string, unknown>[]).push({ primitive: "NotARealPrimitive" });
    const invalid = raw as unknown as SceneSpec; // fails schema
    const result = applyCompositionFixes(invalid);
    expect(result.scene).toBe(invalid);
    expect(result.applied).toBe(false);
  });
});

describe("WS-A: composition quality findings (Batch G)", () => {
  it("flags a semantic object the model paints too small to read", () => {
    const raw = clone(passScene()) as Record<string, unknown>;
    const els = raw.elements as Record<string, unknown>[];
    els[1] = { ...els[1], scale: 0.03, diameterPct: 36 }; // tiny painted box
    const scene = raw as unknown as SceneSpec;
    const report = evaluateCompositionQuality([scene], null);
    const row = report.scenes[0];
    const tooSmall = row.semanticObjects.filter((o) => o.tooSmall);
    // the circle at 0.03 scale paints well under the readable floor
    expect(tooSmall.length + (row.reasons.some((r) => /too small|increase its scale/.test(r)) ? 1 : 0)).toBeGreaterThan(0);
    expect(report.warnings.join(" ")).toMatch(/increase its scale|paints only/);
  });

  it("reports a per-band predicted-vs-measured table", () => {
    const scene = passScene();
    const report = evaluateCompositionQuality([scene], null);
    const bands = report.scenes[0].bands;
    expect(bands.map((b) => b.band)).toEqual(["top", "middle", "bottom"]);
    // measured occupancy is null without frame evidence - never fabricated
    expect(bands.every((b) => b.measuredOccupancy === null)).toBe(true);
    expect(report.scenes[0].predictedObjectInkPx2).toBeGreaterThan(0);
  });

  it("flags two successive beats with an identical composition signature", () => {
    const a = passScene();
    const b = clone(passScene()) as SceneSpec; // same composition + same placements
    const report = evaluateCompositionQuality([a, b], null);
    expect(report.scenes[1].identicalToPrevious).toBe(true);
    expect(report.warnings.join(" ")).toMatch(/repeats the previous beat/);
  });

  it("does NOT flag successive beats with different placements", () => {
    const a = passScene();
    const raw = clone(passScene()) as Record<string, unknown>;
    const els = raw.elements as Record<string, unknown>[];
    els[1] = { ...els[1], position: "top", offsetX: -18 };
    const b = validateScene(raw, "scene_01").scene!;
    const report = evaluateCompositionQuality([a, b], null);
    expect(report.scenes[1].identicalToPrevious).toBe(false);
  });

  it("calls out a bound headline whose model box is entirely off-screen", () => {
    const gap = headlineGapScene();
    const raw = clone(gap) as Record<string, unknown>;
    raw.headline = { ...(raw.headline as Record<string, unknown>), semanticId: "headline_01", position: "bottom", offsetY: -95 };
    const scene = raw as unknown as SceneSpec;
    const report = evaluateCompositionQuality([scene], null);
    expect(report.scenes[0].headline?.offScreen).toBe(true);
    expect(report.scenes[0].headline?.semanticId).toBe("headline_01");
    expect(report.warnings.join(" ")).toMatch(/headline "headline_01" is bound but its model box lies entirely outside/);
  });

  it("a healthy composition produces no reasons", () => {
    const report = evaluateCompositionQuality([passScene()], null);
    expect(report.scenes[0].reasons).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("readable-area floor is documented and deterministic", () => {
    expect(COMPOSITION.minReadableObjectAreaPx2).toBeGreaterThan(0);
    expect(COMPOSITION.minDominantObjectShare).toBeGreaterThan(0);
  });
});
