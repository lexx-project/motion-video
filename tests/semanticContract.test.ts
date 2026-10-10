import { describe, it, expect } from "vitest";
import {
  inspectSemanticContract,
  reconcileSemanticContract,
  headlineBindingTarget,
  requiredSemanticIds,
  summarizeContract,
} from "../src/validation/semanticContract";
import { evaluateSemanticEnactment } from "../src/validation/semanticEnactment";
import { validateScene } from "../src/validation/validate";
import { compileExecutionPlan } from "../src/validation/executionPlan";
import { assessSemanticCategory } from "../src/validation/semanticCategories";
import { passScene, missingObjectScene, headlineGapScene } from "./fixtures/batchD";
import type { SceneSpec } from "../src/validation/schema";
import type { Storyboard } from "../src/validation/storyboardSchema";

/**
 * Batch F §1 - semantic-contract reconciliation regressions.
 *
 * Every case required by the brief is covered here:
 * complete scene passes without a model call / missing id detected / safe micro-repair /
 * unrelated element untouched / unrelated element never falsely bound / duplicates +
 * conflicts per schema / failed repair rolls back / required ⊇ present superset /
 * budget exhaustion is explicit / category mismatch still fails after repair.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("semantic contract inspection (Batch F)", () => {
  it("extracts the gate-identical required id set (objects + event targets)", () => {
    const scene = passScene();
    // storyboard objects: person_01, gate_01; event targets: person_01, gate_01
    expect(requiredSemanticIds(scene)).toEqual(["gate_01", "person_01"]);
  });

  it("a complete scene passes without any model call (pure inspection)", () => {
    const scene = passScene();
    const result = reconcileSemanticContract(scene);
    expect(result.report.verdict).toBe("pass");
    expect(result.report.decision).toBe("UNCHANGED");
    expect(result.scene).toBe(scene); // same object reference - nothing touched
    expect(result.report.missingIds).toEqual([]);
    expect(result.report.reasons).toEqual([]);
  });

  it("detects a missing semantic id deterministically (same input -> same report)", () => {
    const scene = missingObjectScene(); // gate_01 promised, no element carries it
    const a = inspectSemanticContract(scene);
    const b = inspectSemanticContract(scene);
    expect(a).toEqual(b);
    expect(a.verdict).toBe("fail");
    expect(a.missingIds).toEqual(["gate_01"]);
    expect(a.reasons).toContainEqual({ code: "missing_semantic_id", id: "gate_01" });
  });

  it("reports duplicates and invalid ids per the actual schema contract", () => {
    const scene = passScene();
    const raw = clone(scene) as unknown as Record<string, unknown>;
    // schema forbids duplicates - construct the invalid shape directly for the inspector
    const els = raw.elements as Record<string, unknown>[];
    els[1] = { ...els[1], semanticId: "person_01" };
    const inspected = inspectSemanticContract(raw as unknown as SceneSpec);
    expect(inspected.duplicateIds).toEqual(["person_01"]);
    expect(inspected.reasons).toContainEqual({ code: "duplicate_semantic_id", id: "person_01" });
    // and validateScene rejects the same shape (schema is the authority)
    expect(validateScene(raw, "scene_01").success).toBe(false);

    const raw2 = clone(scene) as unknown as Record<string, unknown>;
    (raw2.elements as Record<string, unknown>[])[1] = { ...els[1], semanticId: "9bad-id" };
    const inspected2 = inspectSemanticContract(raw2 as unknown as SceneSpec);
    expect(inspected2.reasons.some((r) => r.code === "invalid_semantic_id")).toBe(true);
  });

  it("flags an element bound to an id the storyboard never promised (unpromised conflict)", () => {
    const scene = passScene();
    const raw = clone(scene) as unknown as Record<string, unknown>;
    (raw.elements as Record<string, unknown>[])[1] = {
      ...((raw.elements as Record<string, unknown>[])[1]),
      semanticId: "ghost_01",
    };
    const inspected = inspectSemanticContract(raw as unknown as SceneSpec);
    expect(inspected.conflictingBindings).toContain("ghost_01");
    expect(inspected.reasons).toContainEqual({ code: "unpromised_semantic_id", id: "ghost_01" });
    expect(inspected.verdict).toBe("fail");
  });

  it("detects drift between the scene's embedded storyboard and the authority", () => {
    const scene = passScene();
    const authority = clone(scene.storyboard!) as Storyboard;
    authority.semanticObjects = authority.semanticObjects.filter((o) => o.id !== "gate_01");
    const inspected = inspectSemanticContract(scene, authority);
    expect(inspected.reasons).toContainEqual({ code: "authoritative_contract_changed", id: "storyboard" });
  });
});

describe("headline micro-repair (Batch F)", () => {
  it("restores a safe missing binding on the existing headline", () => {
    const scene = headlineGapScene();
    expect(inspectSemanticContract(scene).missingIds).toEqual(["headline_01"]);

    const result = reconcileSemanticContract(scene);
    expect(result.report.decision).toBe("KEEP");
    expect(result.report.verdict).toBe("pass");
    expect(result.scene.headline?.semanticId).toBe("headline_01");
    // re-validates against the same schema contract
    expect(validateScene(result.scene, "scene_01").success).toBe(true);
    // and the enactment gate now sees the object present
    const gate = evaluateSemanticEnactment([result.scene]);
    expect(gate.scenes[0].objects.present).toContain("headline_01");
    expect(gate.failures.some((f) => f.type === "missing_semantic_object")).toBe(false);
  });

  it("does not modify any unrelated element (byte-identical elements)", () => {
    const scene = headlineGapScene();
    const before = JSON.stringify(scene.elements);
    const result = reconcileSemanticContract(scene);
    expect(JSON.stringify(result.scene.elements)).toBe(before);
    // only the headline field differs
    expect(JSON.stringify({ ...result.scene, headline: scene.headline })).toBe(JSON.stringify(scene));
    expect(result.scene.storyboard).toBe(scene.storyboard); // contract object untouched
  });

  it("cannot falsely assign the missing id to an unrelated element", () => {
    // a missing NON-headline id with an unbound element present must never be bound to it
    const scene = missingObjectScene();
    const raw = clone(scene) as unknown as Record<string, unknown>;
    (raw.elements as Record<string, unknown>[]).push({
      primitive: "Circle",
      position: "bottom",
      accent: "none",
      role: "supporting",
      purpose: "decorative dot - NOT the gate",
    });
    const withExtra = validateScene(raw, "scene_01").scene!;
    const before = JSON.stringify(withExtra.elements);
    const result = reconcileSemanticContract(withExtra);
    expect(result.report.decision).toBe("UNRESOLVED");
    expect(JSON.stringify(result.scene.elements)).toBe(before);
    expect(result.scene.elements.some((e) => e.semanticId === "gate_01")).toBe(false);
    expect(result.report.unresolved).toEqual([
      { id: "gate_01", code: "no_unambiguous_existing_binding" },
    ]);
  });

  it("does not bind a headline-looking id without the storyboard beat evidence", () => {
    const scene = headlineGapScene();
    const sb = clone(scene.storyboard!) as Storyboard;
    // id looks like a headline but NO beat action mentions it -> ambiguous, no guess
    sb.motionBeats = sb.motionBeats.map((b) =>
      b.target === "headline_01" ? { ...b, action: "Label fades into place" } : b,
    );
    expect(headlineBindingTarget(scene, sb, ["headline_01"])).toBeNull();
  });

  it("does not bind when more than one missing id has headline evidence (ambiguous)", () => {
    const scene = headlineGapScene();
    const sb = clone(scene.storyboard!) as Storyboard;
    sb.motionBeats.push({
      order: 5,
      action: "Second headline caption appears",
      purpose: "secondary label",
      id: "event_05",
      target: "headline_02",
      eventType: "reveal",
      atSeconds: 2.0,
    });
    expect(headlineBindingTarget(scene, sb, ["headline_01", "headline_02"])).toBeNull();
    // with only one candidate the mapping is unambiguous again
    expect(headlineBindingTarget(scene, sb, ["headline_02"])).toBe("headline_02");
  });

  it("keeps the storyboard's required ids a SUPERSET of represented ids after repair", () => {
    const scene = headlineGapScene();
    const result = reconcileSemanticContract(scene);
    const report = summarizeContract([result]);
    expect(report.supersetHolds).toBe(true);
    expect(report.ok).toBe(true);
    for (const id of result.report.presentIds) {
      expect(result.report.requiredIds).toContain(id);
    }
  });

  it("a schema-legal element binding satisfies the id without touching the headline", () => {
    const scene = headlineGapScene();
    const raw = clone(scene) as unknown as Record<string, unknown>;
    (raw.elements as Record<string, unknown>[]).push({
      primitive: "Headline",
      position: "top",
      accent: "none",
      role: "semantic",
      purpose: "the promised headline object",
      text: "A SECOND LINE",
      semanticId: "headline_01",
    });
    const withElement = validateScene(raw, "scene_01").scene!;
    const result = reconcileSemanticContract(withElement);
    expect(result.report.missingIds).toEqual([]);
    expect(result.report.verdict).toBe("pass");
    expect(result.scene.headline?.semanticId).toBeUndefined(); // no redundant binding
    expect(result.report.decision).toBe("UNCHANGED");
  });

  it("rolls back without corrupting the scene when the repair candidate fails re-validation", () => {
    // event targets are NOT schema-constrained like semanticObject ids, so a beat may
    // target "headline_bad!" - the prefix matches the binding rule but the schema
    // semanticId regex rejects it -> ROLLBACK with the original scene preserved byte-for-byte
    const scene = headlineGapScene();
    const raw = clone(scene) as unknown as Record<string, unknown>;
    const sb = raw.storyboard as Storyboard;
    sb.motionBeats = sb.motionBeats.map((b) =>
      b.target === "headline_01" ? { ...b, target: "headline_bad!" } : b,
    );
    raw.executionPlan = compileExecutionPlan({ ...raw, storyboard: sb } as unknown as SceneSpec);
    const scene2 = validateScene(raw, "scene_01").scene!;
    const originalJson = JSON.stringify(scene2);

    const result = reconcileSemanticContract(scene2);
    expect(result.report.decision).toBe("ROLLBACK");
    expect(result.report.repairErrors.length).toBeGreaterThan(0);
    expect(result.report.verdict).toBe("fail"); // never a pass by attempt
    expect(JSON.stringify(result.scene)).toBe(originalJson); // scene not corrupted
    expect(result.scene.headline?.semanticId).toBeUndefined();

    // structural contract failure (duplicate id) also blocks the repair entirely
    const dupRaw = clone(scene) as unknown as Record<string, unknown>;
    (dupRaw.elements as Record<string, unknown>[])[1] = {
      ...((dupRaw.elements as Record<string, unknown>[])[1]),
      semanticId: "person_01",
    };
    const dupJson = JSON.stringify(dupRaw);
    const attempt = reconcileSemanticContract(dupRaw as unknown as SceneSpec);
    expect(attempt.report.duplicateIds).toEqual(["person_01"]);
    expect(attempt.report.decision).toBe("UNRESOLVED"); // never KEEP on a structurally broken scene
    expect(JSON.stringify(attempt.scene)).toBe(dupJson); // original untouched
  });

  it("budget exhaustion is explicit and never a false pass", () => {
    const scene = missingObjectScene();
    const result = reconcileSemanticContract(scene, scene.storyboard, true);
    expect(result.report.decision).toBe("SKIPPED_BUDGET");
    expect(result.report.verdict).toBe("fail"); // still FAIL - no silent upgrade
    expect(result.report.unresolved).toEqual([{ id: "gate_01", code: "budget_exhausted" }]);
    expect(result.report.budgetExhausted).toBe(true);
    expect(summarizeContract([result]).ok).toBe(false);
  });

  it("a real category mismatch still fails after the semantic id is repaired", () => {
    const scene = headlineGapScene();
    // make the headline promise a PERSON so the bound Headline primitive genuinely mismatches
    const sb = clone(scene.storyboard!) as Storyboard;
    sb.semanticObjects = sb.semanticObjects.map((o) =>
      o.id === "headline_01" ? { ...o, objectType: "person", semanticRole: "the figure in the frame" } : o,
    );
    const raw = clone(scene) as unknown as Record<string, unknown>;
    raw.storyboard = sb;
    raw.executionPlan = compileExecutionPlan({ ...raw, storyboard: sb } as unknown as SceneSpec);
    const scene2 = validateScene(raw, "scene_01").scene!;

    const result = reconcileSemanticContract(scene2);
    expect(result.report.decision).toBe("KEEP"); // id binding itself is valid
    const gate = evaluateSemanticEnactment([result.scene]);
    expect(gate.scenes[0].objects.missing).toEqual([]); // id IS bound now
    const categoryFail = gate.failures.filter((f) => f.type === "category_mismatch");
    expect(categoryFail.length).toBeGreaterThan(0); // ...but the visual mismatch still fails
    expect(gate.ok).toBe(false);
  });

  it("the headline category assessment is honest for a bound headline", () => {
    const assessment = assessSemanticCategory({
      objectType: "headline text",
      semanticRole: "names the protagonist idea",
      primitive: "Headline",
    });
    expect(assessment.status).toBe("pass");
  });
});
