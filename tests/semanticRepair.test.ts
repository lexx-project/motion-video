import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { evaluateSemanticEnactment } from "../src/validation/semanticEnactment";
import { validateScene } from "../src/validation/validate";
import type { Storyboard } from "../src/validation/storyboardSchema";
import {
  classifyFailures,
  buildRepairContext,
  FAILURE_PRIORITY,
  isSemanticFailure,
  SEMANTIC_FAILURE_TYPES,
} from "../src/agents/repairContext";
import {
  ALLOWED_PROPERTIES,
  validateRepairProposal,
  applyRepairProposal,
  resolveTarget,
  type RepairProposal,
} from "../src/validation/repairContract";
import { runTargetedRepair, readRepairLedger } from "../src/agents/repairLoop";
import { scriptedRepairProvider } from "../src/agents/repairProviders";
import { buildRepairPrompt } from "../src/agents/repairProviders";
import { buildMetricVector, compareRepair } from "../src/agents/repairCompare";
import { currentSceneFingerprint } from "../src/core/snapshot";
import { writeJsonAt } from "../src/core/projectStore";
import type { MetricSources } from "../src/agents/repairCompare";
import type { RepairFailure } from "../src/agents/repairContext";
import type { SceneSpec } from "../src/validation/schema";
import {
  passScene,
  missingObjectScene,
  missingEventScene,
  timingMismatchScene,
  relationshipFailureScene,
  unsupportedEventScene,
} from "./fixtures/batchD";

const failuresFor = (scene: SceneSpec): RepairFailure[] =>
  classifyFailures({ scenes: [scene], semantic: evaluateSemanticEnactment([scene]) });

const onlyFailure = (scene: SceneSpec): RepairFailure => {
  const list = failuresFor(scene);
  expect(list.length).toBeGreaterThan(0);
  return list[0];
};

const proposal = (over: Partial<RepairProposal> & { changes: RepairProposal["changes"] }): RepairProposal => ({
  sceneId: "scene_01",
  reason: "deterministic semantic evidence says so",
  preserve: ["storyboard promises", "duration"],
  ...over,
});

const gateElement = {
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
};

describe("semantic failure classification + priority (Batch D / §21)", () => {
  it("classifies every semantic failure with source deterministic-semantic", () => {
    const scenes = [missingObjectScene(), missingEventScene(), timingMismatchScene(), relationshipFailureScene(), unsupportedEventScene()];
    const failures = classifyFailures({ scenes, semantic: evaluateSemanticEnactment(scenes) });
    const types = new Set(failures.map((f) => f.type));
    expect([...types].sort()).toEqual(
      [
        "event_timing_mismatch",
        "missing_event",
        "missing_semantic_object",
        "relationship_failed",
        "unsupported_event",
      ].sort(),
    );
    for (const f of failures) {
      expect(f.source).toBe("deterministic-semantic");
      expect(f.severity).toBe("hard");
      expect(f.sceneId).toMatch(/^scene_/);
      expect(f.evidence.length).toBeGreaterThan(10);
    }
  });

  it("orders priority: layout > semantic > judge", () => {
    const idx = (t: string): number => FAILURE_PRIORITY.indexOf(t as never);
    expect(idx("layout_clip")).toBeLessThan(idx("missing_semantic_object"));
    expect(idx("missing_semantic_object")).toBeLessThan(idx("missing_event"));
    expect(idx("missing_event")).toBeLessThan(idx("event_not_executed"));
    expect(idx("event_not_executed")).toBeLessThan(idx("event_timing_mismatch"));
    expect(idx("event_timing_mismatch")).toBeLessThan(idx("state_transition_failed"));
    expect(idx("state_transition_failed")).toBeLessThan(idx("relationship_failed"));
    expect(idx("relationship_failed")).toBeLessThan(idx("unsupported_event"));
    expect(idx("unsupported_event")).toBeLessThan(idx("novelty_fixture"));
    expect(idx("novelty_fixture")).toBeLessThan(idx("judge_issue"));
    expect(idx("judge_issue")).toBeLessThan(idx("unknown"));
  });

  it("sorted output puts layout before semantic before judge", () => {
    const scenes = [missingObjectScene()];
    const failures = classifyFailures({
      scenes,
      semantic: evaluateSemanticEnactment(scenes),
      judgeIssues: [{ sceneId: "scene_01", evidence: "judge thinks so" }],
    });
    const types = failures.map((f) => f.type);
    expect(types.indexOf("missing_semantic_object")).toBeLessThan(types.indexOf("judge_issue"));
  });

  it("every semantic type has a narrow repair action and an allow-list", () => {
    for (const t of SEMANTIC_FAILURE_TYPES) {
      expect(isSemanticFailure(t)).toBe(true);
      expect(ALLOWED_PROPERTIES[t].length).toBeGreaterThan(0);
      const f: RepairFailure = { type: t, severity: "hard", source: "deterministic-semantic", sceneId: "scene_01", evidence: "e" };
      const ctx = buildRepairContext({ round: 1, attempt: 1, maxAttempts: 2, failure: f, allowedProperties: ALLOWED_PROPERTIES[t] });
      expect(ctx.suggestedAction.length).toBeGreaterThan(30);
      expect(ctx.suggestedAction).not.toMatch(/make it better/i);
    }
  });

  it("semantic prompts are compact (model economy)", () => {
    const scene = missingObjectScene();
    const failure = onlyFailure(scene);
    const ctx = buildRepairContext({ round: 1, attempt: 1, maxAttempts: 2, failure, allowedProperties: ALLOWED_PROPERTIES[failure.type] });
    const prompt = buildRepairPrompt(ctx, scene);
    expect(prompt.length).toBeLessThan(3500);
    expect(prompt).toContain("addElement");
    expect(prompt).toContain("gate_01");
    expect(prompt).toContain("storyboard promises"); // preservation constraint visible
  });
});

describe("semantic repair contract (Batch D / §23-§25)", () => {
  it("ACCEPTS adding the missing object as exactly one element", () => {
    const scene = missingObjectScene();
    const failure = onlyFailure(scene);
    expect(failure.type).toBe("missing_semantic_object");
    const p = proposal({
      changes: [{ target: "scene", property: "addElement", to: gateElement as unknown as string }],
    });
    const v = validateRepairProposal(scene, p, failure.type, { implicated: failure.target });
    expect(v.ok, v.errors.join("; ")).toBe(true);
    expect(v.scene!.elements).toHaveLength(2); // person (kept) + gate (added)
    expect(v.scene!.elements.some((e) => e.semanticId === "gate_01")).toBe(true);
    // contract untouched
    expect(JSON.stringify(v.scene!.storyboard)).toBe(JSON.stringify(scene.storyboard));
    expect(evaluateSemanticEnactment([v.scene!]).ok).toBe(true);
  });

  it("REJECTS an addElement that does not carry the missing semanticId", () => {
    const scene = missingObjectScene();
    const failure = onlyFailure(scene);
    const p = proposal({
      changes: [{ target: "scene", property: "addElement", to: { ...gateElement, semanticId: "other_01" } as unknown as string }],
    });
    const v = validateRepairProposal(scene, p, failure.type, { implicated: failure.target });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/not the missing object/);
  });

  it("REJECTS a structurally invalid added element", () => {
    const scene = missingObjectScene();
    const failure = onlyFailure(scene);
    const p = proposal({
      changes: [{ target: "scene", property: "addElement", to: { primitive: "NoSuchPrimitive", semanticId: "gate_01" } as unknown as string }],
    });
    const v = validateRepairProposal(scene, p, failure.type, { implicated: failure.target });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/invalid element|Unknown primitive/i);
  });

  it("ACCEPTS restoring the missing execution event", () => {
    const scene = missingEventScene();
    const failure = onlyFailure(scene);
    expect(failure.type).toBe("missing_event");
    const p = proposal({
      changes: [
        {
          target: "scene",
          property: "addEvent",
          to: {
            id: "event_02",
            atSeconds: 2.6,
            type: "move",
            action: "moveTo",
            target: "person_01",
            destination: "gate_01",
            durationSec: 0.35,
            easing: "easeInOut",
            provenance: "explicit",
          } as unknown as string,
        },
      ],
    });
    const v = validateRepairProposal(scene, p, failure.type, { implicated: failure.target });
    expect(v.ok, v.errors.join("; ")).toBe(true);
    expect(evaluateSemanticEnactment([v.scene!]).ok).toBe(true);
  });

  it("REJECTS adding an event with an unrelated id or outside the scene window", () => {
    const scene = missingEventScene();
    const failure = onlyFailure(scene);
    const base = {
      id: "event_02",
      atSeconds: 2.6,
      type: "move",
      action: "moveTo",
      target: "person_01",
      destination: "gate_01",
    };
    const wrongId = proposal({
      changes: [{ target: "scene", property: "addEvent", to: { ...base, id: "event_09" } as unknown as string }],
    });
    expect(validateRepairProposal(scene, wrongId, failure.type, { implicated: failure.target }).errors.join(" ")).toMatch(
      /not the missing event/,
    );
    const tooLate = proposal({
      changes: [{ target: "scene", property: "addEvent", to: { ...base, atSeconds: 99 } as unknown as string }],
    });
    const v = validateRepairProposal(scene, tooLate, failure.type, { implicated: failure.target });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/atSeconds|failed validation|exceeds/);
  });

  it("ACCEPTS retiming an event inside the window and REJECTS no-op / out-of-range", () => {
    const scene = timingMismatchScene();
    const failure = onlyFailure(scene);
    expect(failure.type).toBe("event_timing_mismatch");
    const good = proposal({ changes: [{ target: "events:event_03", property: "event.atSeconds", from: 1.5, to: 3.6 }] });
    const v = validateRepairProposal(scene, good, failure.type, { implicated: failure.target });
    expect(v.ok, v.errors.join("; ")).toBe(true);
    expect(evaluateSemanticEnactment([v.scene!]).ok).toBe(true);

    const noop = proposal({ changes: [{ target: "events:event_03", property: "event.atSeconds", to: 1.5 }] });
    expect(validateRepairProposal(scene, noop, failure.type, { implicated: failure.target }).errors.join(" ")).toMatch(/no-op/);

    const tooLate = proposal({ changes: [{ target: "events:event_03", property: "event.atSeconds", to: 9 }] });
    expect(validateRepairProposal(scene, tooLate, failure.type, { implicated: failure.target }).errors.join(" ")).toMatch(
      /above scene duration/,
    );

    const tooEarly = proposal({ changes: [{ target: "events:event_03", property: "event.atSeconds", to: 0.01 }] });
    expect(validateRepairProposal(scene, tooEarly, failure.type, { implicated: failure.target }).errors.join(" ")).toMatch(
      /below minimum/,
    );
  });

  it("ACCEPTS changing an unsupported event type to a supported one (narrow storyboard exception)", () => {
    const scene = unsupportedEventScene();
    const failure = onlyFailure(scene);
    expect(failure.type).toBe("unsupported_event");
    const p = proposal({ changes: [{ target: "events:event_02", property: "event.type", to: "move" }] });
    const v = validateRepairProposal(scene, p, failure.type, { implicated: failure.target });
    expect(v.ok, v.errors.join("; ")).toBe(true);
    const sb = v.scene!.storyboard!;
    // only the targeted beat's eventType changed; everything else is byte-identical
    expect(sb.motionBeats[1].eventType).toBe("move");
    expect(sb.motionBeats[0].eventType).toBe("enter");
    expect(sb.motionBeats[2].eventType).toBe("scale");
    expect((v.scene!.executionPlan as { events: { id: string; type: string }[] }).events.find((e) => e.id === "event_02")!.type).toBe("move");
    expect(evaluateSemanticEnactment([v.scene!]).ok).toBe(true);
  });

  it("REJECTS moving to another unsupported type", () => {
    const scene = unsupportedEventScene();
    const failure = onlyFailure(scene);
    const p = proposal({ changes: [{ target: "events:event_02", property: "event.type", to: "morphX" }] });
    const v = validateRepairProposal(scene, p, failure.type, { implicated: failure.target });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/unsupported event type/);
  });

  it("REJECTS touching an event the failure did not name", () => {
    const scene = unsupportedEventScene();
    const failure = onlyFailure(scene);
    const p = proposal({ changes: [{ target: "events:event_01", property: "event.type", to: "exit" }] });
    const v = validateRepairProposal(scene, p, failure.type, { implicated: failure.target });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/unrelated to this failure/);
  });

  it("REJECTS changes to objects the failure did not name (scoping)", () => {
    const scene = relationshipFailureScene();
    const failure = onlyFailure(scene);
    expect(failure.type).toBe("relationship_failed");
    // implicated = [person_01, ghost_01]; the gate element is unrelated
    const p = proposal({ changes: [{ target: "gate_01", property: "offsetX", from: 0, to: 10 }] });
    const v = validateRepairProposal(scene, p, failure.type, { implicated: failure.target });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/unrelated to this failure/);
  });

  it("REJECTS mutating the storyboard through scene-level properties", () => {
    const scene = missingObjectScene();
    const failure = onlyFailure(scene);
    for (const prop of ["storyboard", "elements", "executionPlan", "duration"]) {
      const p = proposal({ changes: [{ target: "scene", property: prop, to: "hacked" }] });
      const v = validateRepairProposal(scene, p, failure.type, { implicated: failure.target });
      expect(v.ok, prop).toBe(false);
      expect(v.errors.join(" "), prop).toMatch(/not allowed|not allow-listed/);
    }
  });

  it("REJECTS deleting a requirement (semantic id / event) to pass validation", () => {
    const scene = missingObjectScene();
    const failure = onlyFailure(scene);
    // cannot rename/drop an existing semantic id - not allow-listed for this failure
    const rename = proposal({ changes: [{ target: "person_01", property: "semanticId", to: "person_x" }] });
    expect(validateRepairProposal(scene, rename, failure.type, { implicated: failure.target }).ok).toBe(false);
    // cannot duplicate an existing event to fake coverage
    const scene2 = missingEventScene();
    const failure2 = onlyFailure(scene2);
    const dup = proposal({
      changes: [
        {
          target: "scene",
          property: "addEvent",
          to: { id: "event_01", atSeconds: 0.8, type: "enter", action: "appear", target: "person_01" } as unknown as string,
        },
      ],
    });
    expect(validateRepairProposal(scene2, dup, failure2.type, { implicated: failure2.target }).errors.join(" ")).toMatch(
      /already exists/,
    );
    // structural changes are never allowed outside missing_semantic_object
    const struct = proposal({ changes: [{ target: "scene", property: "addElement", to: gateElement as unknown as string }] });
    expect(validateRepairProposal(scene2, struct, failure2.type, { implicated: failure2.target }).ok).toBe(false);
  });

  it("REJECTS unrelated mutations for non-semantic failures too (Batch C guard intact)", () => {
    const scene = passScene();
    const p = proposal({ changes: [{ target: "elements:0", property: "offsetX", from: 0, to: 40 }] });
    const v = validateRepairProposal(scene, p, "layout_clip", { implicated: ["elements:1"] });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/unrelated/);
  });

  it("resolveTarget understands events:<id> and semantic ids", () => {
    const scene = passScene();
    const ev = resolveTarget(scene, "events:event_03");
    expect("kind" in ev && ev.kind).toBe("event");
    const el = resolveTarget(scene, "person_01");
    expect("kind" in el && el.kind === "element");
    const bad = resolveTarget(scene, "events:event_99");
    expect("error" in bad).toBe(true);
  });

  it("applyRepairProposal is pure (input scene never mutated)", () => {
    const scene = missingObjectScene();
    const before = JSON.stringify(scene);
    const p = proposal({ changes: [{ target: "scene", property: "addElement", to: gateElement as unknown as string }] });
    applyRepairProposal(scene, p);
    expect(JSON.stringify(scene)).toBe(before);
  });
});

/* -------------------------------- keep / rollback ------------------------------- */

interface Fixture {
  dir: string;
  scenes: SceneSpec[];
}

function makeProject(scene: SceneSpec): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-repair-"));
  writeJsonAt(dir, `scenes/${scene.sceneId}.json`, scene);
  return { dir, scenes: [scene] };
}

const modelMeasure = async (scenes: SceneSpec[]): Promise<MetricSources> => ({
  scenes,
  semantic: evaluateSemanticEnactment(scenes),
  artifactConsistent: true,
});

describe("semantic repair keep/rollback (Batch D via Batch C infrastructure)", () => {
  it("KEEPS a repair that satisfies the missing-object promise", async () => {
    const scene = missingObjectScene();
    const { dir, scenes } = makeProject(scene);
    const baseline = await modelMeasure(scenes);
    const failures = failuresFor(scene);
    expect(failures.some((f) => f.type === "missing_semantic_object")).toBe(true);
    const before = currentSceneFingerprint(dir).sceneHashes.scene_01;

    const result = await runTargetedRepair({
      dir,
      scenes,
      round: 1,
      failures,
      provider: scriptedRepairProvider([
        {
          proposal: {
            sceneId: "scene_01",
            reason: "storyboard promises gate_01",
            changes: [{ target: "scene", property: "addElement", to: gateElement as unknown as string }],
            preserve: ["storyboard promises", "duration"],
          },
        },
      ]),
      baseline,
      maxScenes: 1,
    });

    expect(result.kept).toContain("scene_01");
    expect(result.rolledBack).toEqual([]);
    const after = currentSceneFingerprint(dir).sceneHashes.scene_01;
    expect(after).not.toBe(before);
    const repaired = JSON.parse(fs.readFileSync(path.join(dir, "scenes", "scene_01.json"), "utf8")) as SceneSpec;
    expect(repaired.elements.some((e) => e.semanticId === "gate_01")).toBe(true);
    expect(evaluateSemanticEnactment([repaired]).ok).toBe(true);

    const row = readRepairLedger(dir).find((r) => r.failureType === "missing_semantic_object");
    expect(row?.decision).toBe("KEEP");
    expect(row?.evidenceAfter).toMatch(/cleared|missing/);
    expect(row?.source).toBe("deterministic-semantic");
  });

  it("ROLLS BACK a bad semantic repair that introduces another hard failure", async () => {
    const scene = missingEventScene();
    const { dir, scenes } = makeProject(scene);
    const baseline = await modelMeasure(scenes);
    const failures = failuresFor(scene);
    expect(failures.some((f) => f.type === "missing_event")).toBe(true);
    const before = currentSceneFingerprint(dir).sceneHashes.scene_01;

    const result = await runTargetedRepair({
      dir,
      scenes,
      round: 1,
      failures,
      provider: scriptedRepairProvider([
        {
          proposal: {
            sceneId: "scene_01",
            reason: "restore the move event (at the wrong time on purpose)",
            changes: [
              {
                target: "scene",
                property: "addEvent",
                to: {
                  id: "event_02",
                  atSeconds: 1.0, // promise says 2.6s -> event_timing_mismatch
                  type: "move",
                  action: "moveTo",
                  target: "person_01",
                  destination: "gate_01",
                  durationSec: 0.35,
                  easing: "easeInOut",
                  provenance: "explicit",
                } as unknown as string,
              },
            ],
            preserve: ["storyboard promises", "duration"],
          },
        },
      ]),
      baseline,
      maxScenes: 1,
    });

    expect(result.rolledBack).toContain("scene_01");
    expect(result.kept).toEqual([]);
    // exact baseline restored
    expect(currentSceneFingerprint(dir).sceneHashes.scene_01).toBe(before);
    const restored = JSON.parse(fs.readFileSync(path.join(dir, "scenes", "scene_01.json"), "utf8")) as SceneSpec;
    expect((restored.executionPlan as { events: { id: string }[] }).events.some((e) => e.id === "event_02")).toBe(false);

    const row = readRepairLedger(dir)[0];
    expect(row.decision).toBe("ROLLBACK");
    expect(row.reason).toMatch(/new hard failure|event_timing_mismatch/);
  });
});

describe("metric vectors include semantic evidence (Batch D / compareRepair)", () => {
  it("a new semantic hard key forces ROLLBACK", () => {
    const baseline = buildMetricVector({ scenes: [missingEventScene()], semantic: evaluateSemanticEnactment([missingEventScene()]), artifactConsistent: true });
    const candidate = buildMetricVector({ scenes: [timingMismatchScene()], semantic: evaluateSemanticEnactment([timingMismatchScene()]), artifactConsistent: true });
    expect(baseline.hardKeys).toContain("scene_01:missing_event");
    expect(candidate.hardKeys).toContain("scene_01:event_timing_mismatch");
    const cmp = compareRepair(baseline, candidate, { targetKey: "scene_01:missing_event" });
    expect(cmp.action).toBe("ROLLBACK");
    expect(cmp.reason).toMatch(/new hard failure/);
  });

  it("fixing the target with no regressions scores KEEP", () => {
    const broken = missingObjectScene();
    const fixed = JSON.parse(JSON.stringify(broken)) as SceneSpec;
    (fixed.elements as Record<string, unknown>[]).push({ ...({ ...gateElement } as Record<string, unknown>) });
    const baseline = buildMetricVector({ scenes: [broken], semantic: evaluateSemanticEnactment([broken]), artifactConsistent: true });
    const failure = failuresFor(broken)[0];
    const candidateSources = { scenes: [fixed], semantic: evaluateSemanticEnactment([fixed]), artifactConsistent: true };
    const candidate = buildMetricVector(candidateSources);
    const withSeverity = (v: typeof baseline, mag: number | null): typeof baseline =>
      mag === null ? v : { ...v, targetSeverity: mag };
    const cmp = compareRepair(withSeverity(baseline, 1), withSeverity(candidate, null), { targetKey: "scene_01:missing_semantic_object" });
    expect(cmp.action).toBe("KEEP");
    expect(failure.type).toBe("missing_semantic_object");
  });
});

/* ---------------- Batch E Phase 6: category rules in the repair contract ---------------- */

describe("semantic category repair contract (Batch E / Phase 6)", () => {
  /** person_01 is promised as a clock but rendered by a Person -> category_mismatch. */
  const clockForPerson = (): SceneSpec => {
    const raw = JSON.parse(JSON.stringify(passScene())) as SceneSpec;
    const sb = raw.storyboard as Storyboard;
    sb.semanticObjects[0].objectType = "clock";
    sb.semanticObjects[0].semanticRole = "the countdown clock";
    const parsed = validateScene(raw, "scene_01");
    if (!parsed.success || !parsed.scene) throw new Error(parsed.errors.join("; "));
    return parsed.scene;
  };

  it("REJECTS addElement that satisfies a missing object with an obviously wrong primitive", () => {
    const scene = missingObjectScene(); // promised: gate_01 (objectType "gate")
    const failure = onlyFailure(scene);
    expect(failure.type).toBe("missing_semantic_object");
    const p = proposal({
      changes: [
        {
          target: "scene",
          property: "addElement",
          // schema-valid element (Person params) but semantically a Person is no gate
          to: {
            primitive: "Person",
            position: "right",
            accent: "none",
            role: "semantic",
            purpose: "the gate rendered as a person",
            semanticId: "gate_01",
            delay: 0,
            entrance: "fade",
          } as unknown as string,
        },
      ],
    });
    const v = validateRepairProposal(scene, p, failure.type, { implicated: failure.target });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/incompatible primitive for promised object "gate_01"/);
  });

  it("ACCEPTS a category-compatible primitive replacement for category_mismatch", () => {
    const scene = clockForPerson();
    const failure = failuresFor(scene).find((f) => f.type === "category_mismatch")!;
    expect(failure).toBeTruthy();
    const p = proposal({ changes: [{ target: "person_01", property: "primitive", from: "Person", to: "Clock" }] });
    const v = validateRepairProposal(scene, p, failure.type, { implicated: failure.target });
    expect(v.ok, v.errors.join("; ")).toBe(true);
    expect(v.scene!.elements[0].primitive).toBe("Clock");
    expect(v.scene!.elements[0].semanticId).toBe("person_01"); // identity preserved
    expect(evaluateSemanticEnactment([v.scene!]).ok).toBe(true);
  });

  it("REJECTS a primitive replacement that is still incompatible", () => {
    const scene = clockForPerson();
    const failure = failuresFor(scene).find((f) => f.type === "category_mismatch")!;
    const p = proposal({ changes: [{ target: "person_01", property: "primitive", to: "Grid" }] });
    const v = validateRepairProposal(scene, p, failure.type, { implicated: failure.target });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/still incompatible/);
  });

  it("REJECTS unregistered primitives", () => {
    const scene = clockForPerson();
    const failure = failuresFor(scene).find((f) => f.type === "category_mismatch")!;
    const p = proposal({ changes: [{ target: "person_01", property: "primitive", to: "Gate3000" }] });
    const v = validateRepairProposal(scene, p, failure.type, { implicated: failure.target });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/not a registered primitive/);
  });

  it("primitive is NOT allow-listed for other failure types", () => {
    const scene = passScene();
    const p = proposal({ changes: [{ target: "person_01", property: "primitive", to: "Clock" }] });
    const v = validateRepairProposal(scene, p, "layout_clip", { implicated: ["elements:0"] });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/not allowed for layout_clip/);
  });

  it("category_mismatch participates in classification + allow-list coverage", () => {
    expect(SEMANTIC_FAILURE_TYPES).toContain("category_mismatch");
    expect(ALLOWED_PROPERTIES.category_mismatch).toEqual(["primitive"]);
    expect(isSemanticFailure("category_mismatch")).toBe(true);
    expect(FAILURE_PRIORITY.indexOf("missing_semantic_object")).toBeLessThan(
      FAILURE_PRIORITY.indexOf("category_mismatch"),
    );
    expect(FAILURE_PRIORITY.indexOf("category_mismatch")).toBeLessThan(FAILURE_PRIORITY.indexOf("missing_event"));
  });
});
