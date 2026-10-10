import { validateScene } from "../../src/validation/validate";
import { compileExecutionPlan } from "../../src/validation/executionPlan";
import type { SceneSpec } from "../../src/validation/schema";
import type { Storyboard } from "../../src/validation/storyboardSchema";

/**
 * Batch D deterministic fixtures (shared by tests/ and e2e/).
 *
 * Script meaning: "A person waits, then moves toward a gate and the gate opens."
 *
 * PASS contract:
 *   objects    person_01, gate_01
 *   events     event_01 enter person_01 @0.8s
 *              event_02 move  person_01 -> gate_01 @2.6s
 *              event_03 scale gate_01 x1.35 @3.6s
 *   relationship person_01 movesToward gate_01
 *
 * The broken fixtures each violate exactly ONE promise so the gate's classification
 * is unambiguous (missing object / missing event / not executed / timing / relationship).
 */

export const PASS_DURATION = 4.5;

const storyboardBase = (): Storyboard => ({
  beatId: "b1",
  spokenMeaning: "waiting is safe, moving toward the gate is the act",
  viewerTakeaway: "the person moves and the gate opens",
  visualMechanism: "approachAndOpen",
  visualNarrative: [
    { order: 1, action: "person appears at the left edge", meaning: "the actor is waiting", visualEvidence: "person_01 visible" },
    { order: 2, action: "person crosses toward the gate", meaning: "action begins", visualEvidence: "person_01 closes the distance" },
    { order: 3, action: "the gate opens wide", meaning: "the way forward appears", visualEvidence: "gate_01 expands" },
  ],
  semanticObjects: [
    { id: "person_01", objectType: "person", semanticRole: "the actor who waits then moves", relationship: "moves toward the gate", importance: 5 },
    { id: "gate_01", objectType: "gate", semanticRole: "the destination that opens", relationship: "receives the person", importance: 4 },
  ],
  relationships: [
    { from: "person_01", to: "gate_01", relationship: "walks toward", type: "movesToward" },
  ],
  typographyPlan: { headline: "WAIT, THEN GO", emphasisWords: ["GO"], supportingText: ["one step then the gate"] },
  subtitlePlan: { enabled: false, text: "", timing: "", role: "" },
  motionBeats: [
    {
      order: 1,
      action: "person appears",
      purpose: "establish the waiting actor",
      id: "event_01",
      target: "person_01",
      eventType: "enter",
      atSeconds: 0.8,
      expected: { from: 0, to: 1 },
    },
    {
      order: 2,
      action: "person moves to the gate",
      purpose: "perform the approach",
      id: "event_02",
      target: "person_01",
      eventType: "move",
      atSeconds: 2.6,
      expected: { toward: "gate_01" },
    },
    {
      order: 3,
      action: "gate opens",
      purpose: "the destination responds",
      id: "event_03",
      target: "gate_01",
      eventType: "scale",
      atSeconds: 3.6,
      expected: { from: 1, to: 1.35 },
    },
  ],
  compositionIntent: "person left, gate right, headline on top - the crossing reads left to right",
  visualEvidence: ["person closes the distance", "gate expands"],
  forbiddenInterpretations: ["static diagram"],
  noveltyIntent: "approach that ends in a destination response",
  elementBudget: { min: 3, max: 5 },
});

const sceneRaw = (): Record<string, unknown> => ({
  sceneId: "scene_01",
  duration: PASS_DURATION,
  purpose: "show the person waiting, moving to the gate, and the gate opening",
  visualConcept: "approach and open",
  composition: "split",
  headline: { text: "WAIT, THEN GO", accentWords: ["GO"], align: "left" },
  elements: [
    {
      primitive: "Person",
      position: "left",
      accent: "none",
      role: "semantic",
      purpose: "the actor",
      semanticId: "person_01",
      delay: 0,
      entrance: "fade",
    },
    {
      primitive: "Circle",
      position: "right",
      accent: "teal",
      role: "semantic",
      purpose: "the destination",
      semanticId: "gate_01",
      label: "GATE",
      diameterPct: 36,
      delay: 0,
      entrance: "fade",
    },
  ],
  motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
  timing: { entranceAt: 0 },
});

function build(mutate?: (raw: Record<string, unknown>) => void): SceneSpec {
  const raw = sceneRaw();
  const storyboard = storyboardBase();
  raw.storyboard = storyboard;
  const draft = { ...raw, storyboard } as unknown as SceneSpec;
  // deterministic plan embed (same function the scene composer uses)
  raw.executionPlan = compileExecutionPlan(draft);
  mutate?.(raw);
  const parsed = validateScene(raw, "scene_01");
  if (!parsed.success || !parsed.scene) {
    throw new Error(`fixture invalid: ${parsed.errors.join("; ")}`);
  }
  return parsed.scene;
}

/** The passing scene: contract active, all objects/events/relationships hold. */
export const passScene = (): SceneSpec => build();

/** A: gate_01 promised but no element carries it. */
export const missingObjectScene = (): SceneSpec =>
  build((raw) => {
    const els = raw.elements as Record<string, unknown>[];
    raw.elements = els.filter((e) => e.semanticId !== "gate_01");
  });

/** B: plan carries the move event but no destination/offsets -> nothing moves. */
export const notExecutedScene = (): SceneSpec =>
  build((raw) => {
    const plan = raw.executionPlan as { events: Record<string, unknown>[] };
    const move = plan.events.find((e) => e.id === "event_02")!;
    delete move.destination;
    delete move.toOffsetX;
    delete move.toOffsetY;
  });

/** C: the gate opens at 1.5s although the storyboard promises 3.6s. */
export const timingMismatchScene = (): SceneSpec =>
  build((raw) => {
    const plan = raw.executionPlan as { events: Record<string, unknown>[] };
    const open = plan.events.find((e) => e.id === "event_03")!;
    open.atSeconds = 1.5;
  });

/** D: relationship points at an object the storyboard never promised. */
export const relationshipFailureScene = (): SceneSpec =>
  build((raw) => {
    const sb = raw.storyboard as { relationships: Record<string, unknown>[] };
    sb.relationships = [
      { from: "person_01", to: "ghost_01", relationship: "walks toward", type: "movesToward" },
    ];
  });

/** E: storyboard promises an event type the renderer cannot execute. */
export const unsupportedEventScene = (): SceneSpec =>
  build((raw) => {
    const sb = raw.storyboard as { motionBeats: Record<string, unknown>[] };
    sb.motionBeats[1].eventType = "morph";
    // the embed follows the storyboard (exactly what the scene composer would produce)
    const plan = raw.executionPlan as { events: Record<string, unknown>[] };
    const ev = plan.events.find((e) => e.id === "event_02")!;
    ev.type = "morph";
    ev.action = "unsupported";
  });

/** Legacy scene contract (no ids / no event types): the gate must stay inactive. */
export const legacyStoryboardScene = (): SceneSpec =>
  build((raw) => {
    const sb = raw.storyboard as {
      semanticObjects: Record<string, unknown>[];
      motionBeats: Record<string, unknown>[];
      relationships: Record<string, unknown>[];
    };
    for (const o of sb.semanticObjects) delete o.id;
    for (const m of sb.motionBeats) {
      delete m.id;
      delete m.target;
      delete m.eventType;
      delete m.expected;
      delete m.atSeconds;
    }
    for (const r of sb.relationships) delete r.type;
    delete (raw as { executionPlan?: unknown }).executionPlan;
  });

/**
 * Batch F fixture: the storyboard ALSO promises `headline_01` (with a reveal motion beat
 * naming the headline), but the composer put the headline in `scene.headline` without a
 * semanticId binding - the exact live-run defect (`_batche_live` scene_01/scene_04).
 */
export const headlineGapScene = (): SceneSpec =>
  build((raw) => {
    const sb = raw.storyboard as Storyboard;
    sb.semanticObjects.push({
      id: "headline_01",
      objectType: "headline text",
      semanticRole: "names the protagonist idea for the frame",
      relationship: "sits above the person, labeling the whole image",
      importance: 3,
    });
    sb.motionBeats.push({
      order: 4,
      action: "Headline reveals above the scene",
      purpose: "name the idea",
      id: "event_04",
      target: "headline_01",
      eventType: "reveal",
      atSeconds: 1.1,
    });
    // scene.headline exists (from the typography plan) but carries NO semanticId
    delete (raw.headline as Record<string, unknown>).semanticId;
    raw.executionPlan = compileExecutionPlan({ ...raw, storyboard: sb } as unknown as SceneSpec);
  });

export const allBrokenFixtures = (): { name: string; scene: SceneSpec; expected: string }[] => [
  { name: "missing object", scene: missingObjectScene(), expected: "missing_semantic_object" },
  { name: "missing event", scene: missingEventScene(), expected: "missing_event" },
  { name: "event not executed", scene: notExecutedScene(), expected: "event_not_executed" },
  { name: "timing mismatch", scene: timingMismatchScene(), expected: "event_timing_mismatch" },
  { name: "relationship failure", scene: relationshipFailureScene(), expected: "relationship_failed" },
  { name: "unsupported event", scene: unsupportedEventScene(), expected: "unsupported_event" },
];

/** Fixture A variant with the promise intact but the plan event deleted. */
export function missingEventScene(): SceneSpec {
  return build((raw) => {
    const plan = raw.executionPlan as { events: Record<string, unknown>[] };
    plan.events = plan.events.filter((e) => e.id !== "event_02");
  });
}
