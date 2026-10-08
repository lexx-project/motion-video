import { describe, it, expect } from "vitest";
import {
  primitiveRegistry,
  resolvePrimitive,
  registryConsistencyErrors,
} from "../src/primitives/registry";
import { PRIMITIVE_NAMES, primitives, isKnownPrimitive } from "../src/core/designSystem";
import { composition, motion, colors } from "../src/core/designSystem";

describe("primitive registry", () => {
  it("has no consistency gaps between primitives.json and the component registry", () => {
    expect(registryConsistencyErrors()).toEqual([]);
  });

  it("registers every Master Spec primitive by exact name", () => {
    const required = [
      "Headline", "Subheadline", "Label", "WordReveal", "CharacterReveal", "HighlightWord",
      "CounterText", "Quote", "Caption",
      "Clock", "Calendar", "ProfileCard", "GenericCard", "Target", "ProgressBar", "Checkbox",
      "Arrow", "Line", "Circle", "Stack", "Grid", "Indicator", "Number", "Badge",
      "Timeline", "Comparison", "BeforeAfter", "Flow", "Branch", "Relationship", "Progress", "Sequence",
      "GradientGlow", "SoftOrb", "Grain", "GridBackground", "LightSweep",
    ];
    for (const name of required) {
      expect(isKnownPrimitive(name), `missing primitive ${name}`).toBe(true);
      expect(primitiveRegistry[name], `missing component ${name}`).toBeTruthy();
      expect(typeof primitiveRegistry[name].component).toBe("function");
    }
  });

  it("fails loudly on unknown primitive resolution", () => {
    expect(() => resolvePrimitive("NoSuchThing")).toThrow(/Unknown primitive/);
  });

  it("every primitive is covered by a design-system category", () => {
    for (const name of PRIMITIVE_NAMES) {
      expect(["typography", "object", "diagram", "atmospheric"]).toContain(
        primitives.primitives[name].category,
      );
    }
  });
});

describe("design system invariants", () => {
  it("exposes all composition grammars from the spec", () => {
    for (const g of ["centered", "leftTextRightObject", "asymmetric", "split", "fullFrameSymbolic"]) {
      expect(composition.grammars).toContain(g);
    }
  });

  it("keeps motion vocabulary within the Master Motion Bible", () => {
    expect(motion.vocabulary.entrance).toEqual(["fade", "reveal", "slide", "scale", "draw", "stagger"]);
    expect(motion.vocabulary.exit).toEqual(["fade", "slide", "dissolve", "maskedTransition"]);
  });

  it("enforces accent discipline constants", () => {
    expect(colors.rules.maxAccentWordsPerHeadline).toBe(2);
    expect(colors.rules.oneDominantAccentPerScene).toBe(true);
    expect(Object.keys(colors.accents)).toEqual(["teal", "gold", "orange", "red"]);
  });
});
