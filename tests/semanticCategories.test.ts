import { describe, it, expect } from "vitest";
import {
  assessSemanticCategory,
  categoryForObjectType,
  categoriesForPrimitive,
  categoryRepresentable,
  semanticCategoryErrors,
} from "../src/validation/semanticCategories";
import { evaluateSemanticEnactment } from "../src/validation/semanticEnactment";
import { validateScene } from "../src/validation/validate";
import { compileExecutionPlan } from "../src/validation/executionPlan";
import { passScene, missingObjectScene } from "./fixtures/batchD";
import type { SceneSpec } from "../src/validation/schema";
import type { Storyboard } from "../src/validation/storyboardSchema";

/**
 * Batch E Phase 3: semantic object category validation.
 * Finite mapping over the ACTUAL registered primitives - deterministic, no vision claims.
 */

describe("semantic category map", () => {
  it("is consistent with the primitive registry (every primitive declared)", () => {
    expect(semanticCategoryErrors()).toEqual([]);
  });

  it("maps object types (and role fallback) to categories deterministically", () => {
    expect(categoryForObjectType("person")).toBe("person");
    expect(categoryForObjectType("actor")).toBe("person");
    expect(categoryForObjectType("Time pressure", "the clock counting down")).toBe("clock");
    expect(categoryForObjectType("castle gate")).toBe("gate");
    expect(categoryForObjectType("unicorn sparkle")).toBeNull();
    // longest keyword wins on overlap (deadline is clock, not line)
    expect(categoryForObjectType("deadline")).toBe("clock");
    expect(categoryForObjectType("timeline")).toBe("timeline");
    // role fallback only when the object type itself is unclassifiable
    expect(categoryForObjectType("widget", "the person waiting")).toBe("person");
  });

  it("declares categories and representability from data", () => {
    expect(categoriesForPrimitive("Person")).toEqual(["person"]);
    expect(categoriesForPrimitive("ProfileCard")).toContain("person");
    expect(categoriesForPrimitive("Grain")).toEqual([]); // generic atmospheric
    expect(categoryRepresentable("person")).toBe(true);
    expect(categoryRepresentable("gate")).toBe(false); // no gate primitive exists
  });
});

describe("category assessment verdicts (Batch E / Phase 3)", () => {
  const assess = (objectType: string, primitive: string, semanticRole?: string) =>
    assessSemanticCategory({ objectType, primitive, semanticRole });

  it("accepts an exactly compatible primitive", () => {
    expect(assess("person", "Person").status).toBe("pass");
    expect(assess("card", "GenericCard").status).toBe("pass"); // card semantics justify the mapping
    expect(assess("clock", "Clock").status).toBe("pass");
  });

  it("rejects obvious mismatches deterministically", () => {
    // the concrete Batch D failure: Person proposed for a gate
    const gateByPerson = assess("gate", "Person");
    expect(gateByPerson.status).toBe("fail");
    expect(gateByPerson.reason).toMatch(/mismatch/);
    // spec examples
    expect(assess("person", "Clock").status).toBe("fail");
    expect(assess("clock", "Person").status).toBe("fail");
    expect(assess("person", "Grid").status).toBe("fail");
  });

  it("marks ambiguous stand-ins NOT VERIFIED instead of inventing certainty", () => {
    const gateByCircle = assess("gate", "Circle");
    expect(gateByCircle.status).toBe("not_verified");
    expect(gateByCircle.reason).toMatch(/stand-in/);
    expect(assess("mystery thing", "Person").status).toBe("not_verified");
    expect(assess("person", "Grain").status).toBe("not_verified"); // generic primitive: cannot prove wrong
  });

  it("returns a structured unsupported-representation result", () => {
    const r = assess("gate", "Grain");
    expect(r.status).toBe("unsupported_representation");
    expect(r.promisedCategory).toBe("gate");
    expect(r.reason).toMatch(/unsupported representation/);
  });
});

describe("category mismatch enters the semantic enactment gate", () => {
  /** Promise person_01 as a CLOCK while the element stays a Person. */
  const clockForPersonScene = (): SceneSpec => {
    const raw = JSON.parse(JSON.stringify(passScene())) as SceneSpec;
    const sb = raw.storyboard as Storyboard;
    sb.semanticObjects[0].objectType = "clock";
    sb.semanticObjects[0].semanticRole = "the countdown clock";
    const parsed = validateScene(raw, "scene_01");
    if (!parsed.success || !parsed.scene) throw new Error(parsed.errors.join("; "));
    return parsed.scene;
  };

  it("reports category_mismatch as a hard deterministic-semantic failure", () => {
    const report = evaluateSemanticEnactment([clockForPersonScene()]);
    expect(report.ok).toBe(false);
    const f = report.failures.find((x) => x.type === "category_mismatch");
    expect(f).toBeTruthy();
    expect(f!.severity).toBe("hard");
    expect(f!.source).toBe("deterministic-semantic");
    expect(f!.evidence).toMatch(/person_01/);
    expect(f!.evidence).toMatch(/Person/);
    expect(report.scenes[0].summary).toMatch(/category=1 mismatch/);
  });

  it("records per-object category verdicts without failing compatible fixtures", () => {
    const ok = evaluateSemanticEnactment([passScene()]);
    expect(ok.ok).toBe(true); // person=Person pass, gate=Circle stand-in (not_verified, no failure)
    const cats = ok.scenes[0].categories;
    expect(cats).toHaveLength(2);
    expect(cats.find((c) => c.id === "person_01")!.status).toBe("pass");
    expect(cats.find((c) => c.id === "gate_01")!.status).toBe("not_verified");
    expect(ok.scenes[0].summary).not.toMatch(/category=/); // no segment unless a mismatch exists
  });

  it("does not report category checks for missing objects (absence is its own failure)", () => {
    const report = evaluateSemanticEnactment([missingObjectScene()]);
    expect(report.failures.map((f) => f.type)).toEqual(["missing_semantic_object"]);
    expect(report.scenes[0].categories.map((c) => c.id)).toEqual(["person_01"]);
  });
});

describe("scene validation guards semantic identity", () => {
  it("rejects an execution plan event whose target is empty (contract shape)", () => {
    const raw = JSON.parse(JSON.stringify(passScene())) as Record<string, unknown>;
    const plan = raw.executionPlan as { events: Record<string, unknown>[] };
    delete plan.events[0].target;
    expect(validateScene(raw).success).toBe(false);
  });

  it("compileExecutionPlan is deterministic for the same storyboard input", () => {
    const scene = passScene();
    const a = compileExecutionPlan(scene);
    const b = compileExecutionPlan(JSON.parse(JSON.stringify(scene)) as SceneSpec);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
