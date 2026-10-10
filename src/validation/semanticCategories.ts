import { semanticCategories, PRIMITIVE_NAMES } from "../core/designSystem";

/**
 * SEMANTIC OBJECT CATEGORY VALIDATION (Batch E / Phase 3).
 *
 * Batch D's live probe proposed a `Person` primitive for an object promised as a `gate`.
 * This module closes that hole deterministically - no vision, no guessing:
 *
 *   - promised side  : storyboard semanticObject objectType (+ semanticRole fallback),
 *                      mapped to a finite category via keyword data;
 *   - rendered side  : the bound element's primitive -> its declared categories;
 *   - verdict:
 *       exact category match            -> pass
 *       declared stand-in primitive     -> not_verified  (accepted, never overclaimed)
 *       known-category primitive that   -> fail          (obvious, unambiguous mismatch)
 *         is neither the category nor a stand-in
 *       category no primitive supports  -> unsupported_representation (structured result)
 *       promise has no known category   -> not_verified  (do not infer from the id alone)
 *
 * All mappings live in design-system/semantic-categories.json and are checked against the
 * actual primitive registry (`semanticCategoryErrors`).
 */

export type CategoryStatus = "pass" | "fail" | "not_verified" | "unsupported_representation";

export interface CategoryAssessment {
  status: CategoryStatus;
  /** keyword-resolved category of the promise (null = the promise itself is unclassifiable) */
  promisedCategory: string | null;
  /** declared categories of the rendering primitive */
  primitiveCategories: string[];
  reason: string;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();

/** Escape a keyword for literal RegExp use (keywords are plain words/phrases). */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Longest-keyword-first lookup keeps matching deterministic when keywords overlap.
 * Batch F: keywords match on WORD BOUNDARIES, not substrings - "disciplines" must not
 * resolve to the `line` category (live-run false positive), while "castle gate",
 * "Time pressure", "deadline" and "timeline" keep their pinned Batch E verdicts.
 */
function matchCategory(texts: (string | undefined)[]): string | null {
  const keywords: { cat: string; kw: string }[] = [];
  for (const [cat, kws] of Object.entries(semanticCategories.categoryKeywords)) {
    if (!Array.isArray(kws)) continue;
    for (const kw of kws) keywords.push({ cat, kw: kw.toLowerCase().trim() });
  }
  keywords.sort((a, b) => b.kw.length - a.kw.length);
  for (const text of texts) {
    if (!text) continue;
    const t = norm(text);
    if (!t) continue;
    for (const { cat, kw } of keywords) {
      if (!kw) continue;
      const boundary = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(kw)}(?:$|[^\\p{L}\\p{N}])`, "u");
      if (boundary.test(t)) return cat;
    }
  }
  return null;
}

export function categoryForObjectType(objectType: string, semanticRole?: string): string | null {
  return matchCategory([objectType, semanticRole]);
}

export function categoriesForPrimitive(primitive: string): string[] {
  const cats = semanticCategories.primitiveCategories[primitive];
  return Array.isArray(cats) ? cats : [];
}

/**
 * Batch G (WS-D): the OLD normalizer defaulted a missing `objectType` to `"Actor"`,
 * which the keyword map resolves to `person` - turning every legacy storyboard object
 * into a false person promise (the 24 category failures in the Batch F live run).
 *
 * Compatibility policy (read-time, no artifact rewriting):
 *   - exactly `"Actor"` (the historical default string) is treated as a LEGACY
 *     PLACEHOLDER, not a concrete type: the objectType keyword is skipped and only
 *     `semanticRole` decides the category;
 *   - a meaningful explicit declaration is preserved: if the semanticRole itself
 *     resolves to a category (e.g. "the person waiting" -> person), that verdict
 *     stands - so an explicit actor intent expressed through the role stays strict;
 *   - a lowercase "actor" (or any other spelling) still matches the person keyword
 *     exactly as before;
 *   - if neither resolves, the promise is honestly `not_verified`, never auto-passed.
 *
 * Newly generated storyboards never emit the placeholder (the normalizer defaults to
 * neutral "object" and the expansion prompt demands a concrete type), so this branch
 * only ever fires on pre-Batch-F artifacts. Idempotent by construction: it changes no
 * stored bytes, so snapshot/restore and artifact identity are untouched.
 */
export const LEGACY_DEFAULT_OBJECT_TYPE = "Actor";

export function isLegacyDefaultObjectType(objectType: string): boolean {
  return objectType === LEGACY_DEFAULT_OBJECT_TYPE;
}

const standinsFor = (category: string): string[] => {
  const s = (semanticCategories.standinPrimitives as Record<string, unknown>)[category];
  return Array.isArray(s) ? (s as string[]) : [];
};

/** Can ANY registered primitive represent this category exactly? */
export function categoryRepresentable(category: string): boolean {
  return Object.values(semanticCategories.primitiveCategories).some(
    (cats) => Array.isArray(cats) && cats.includes(category),
  );
}

export function assessSemanticCategory(input: {
  objectType: string;
  semanticRole?: string;
  primitive: string;
}): CategoryAssessment {
  // Batch G (WS-D): a legacy default "Actor" is a placeholder, not a concrete type -
  // skip its keyword and let semanticRole decide (explicit actor intent survives via
  // the role; a slab described as "Actor" by the old default becomes not_verified).
  const legacy = isLegacyDefaultObjectType(input.objectType);
  const promisedCategory = legacy
    ? matchCategory([input.semanticRole])
    : categoryForObjectType(input.objectType, input.semanticRole);
  const primitiveCategories = categoriesForPrimitive(input.primitive);
  const legacyNote = legacy ? " [legacy default objectType treated as unclassified]" : "";

  if (promisedCategory === null) {
    return {
      status: "not_verified",
      promisedCategory: null,
      primitiveCategories,
      reason: `objectType "${input.objectType}" maps to no known category - compatibility not verified${legacyNote}`,
    };
  }
  if (primitiveCategories.includes(promisedCategory)) {
    return {
      status: "pass",
      promisedCategory,
      primitiveCategories,
      reason: `primitive ${input.primitive} represents category "${promisedCategory}"${legacyNote}`,
    };
  }
  if (standinsFor(promisedCategory).includes(input.primitive)) {
    return {
      status: "not_verified",
      promisedCategory,
      primitiveCategories,
      reason: `primitive ${input.primitive} is a declared stand-in for "${promisedCategory}" (accepted, visual match not verified)${legacyNote}`,
    };
  }
  if (primitiveCategories.length === 0) {
    return {
      status: categoryRepresentable(promisedCategory) ? "not_verified" : "unsupported_representation",
      promisedCategory,
      primitiveCategories,
      reason: categoryRepresentable(promisedCategory)
        ? `primitive ${input.primitive} is generic and cannot be checked against promised category "${promisedCategory}"${legacyNote}`
        : `no registered primitive can represent category "${promisedCategory}" (unsupported representation)${legacyNote}`,
    };
  }
  return {
    status: "fail",
    promisedCategory,
    primitiveCategories,
    reason: `obvious mismatch: promised "${promisedCategory}" is rendered by ${input.primitive} (categories: ${primitiveCategories.join("|")})${legacyNote}`,
  };
}

/**
 * Data-vs-registry consistency: every registered primitive must be declared (even as
 * generic []), stand-ins must be registered primitives, and every category keyword must
 * point at a declared category key.
 */
export function semanticCategoryErrors(): string[] {
  const errors: string[] = [];
  for (const name of PRIMITIVE_NAMES) {
    if (!(name in semanticCategories.primitiveCategories)) {
      errors.push(`primitive "${name}" has no entry in semantic-categories.json (declare [] for generic)`);
    }
  }
  for (const name of Object.keys(semanticCategories.primitiveCategories)) {
    if (!PRIMITIVE_NAMES.includes(name)) {
      errors.push(`semantic-categories.json declares "${name}" but the registry has no such primitive`);
    }
  }
  const knownCategories = new Set(Object.keys(semanticCategories.categoryKeywords));
  for (const [cat, list] of Object.entries(semanticCategories.primitiveCategories)) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (!knownCategories.has(c)) errors.push(`primitive category "${c}" (${cat}) has no keyword entry`);
    }
  }
  for (const [cat, list] of Object.entries(semanticCategories.standinPrimitives)) {
    if (cat.startsWith("$")) continue;
    if (!Array.isArray(list)) continue;
    if (!knownCategories.has(cat)) errors.push(`standinPrimitives key "${cat}" has no keyword entry`);
    for (const p of list as string[]) {
      if (!PRIMITIVE_NAMES.includes(p)) errors.push(`stand-in "${p}" for "${cat}" is not a registered primitive`);
    }
  }
  return errors;
}
