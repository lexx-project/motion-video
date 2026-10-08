import fs from "fs";
import path from "path";
import {
  colors,
  composition,
  motion,
  typography,
  primitives,
  forbiddenPatterns,
} from "../core/designSystem";
import { readJson, readGlobalMemory, type MemoryEntry } from "../core/projectStore";

const compact = (obj: unknown): string => JSON.stringify(obj, null, 1);

function describeParam(key: string, s: import("../core/designSystem").ParamSpec): string {
  switch (s.type) {
    case "enum":
      return `${key}:enum(${s.values.join("|")})${s.required ? " required" : ""}`;
    case "number":
      return `${key}:number[${s.min ?? "-inf"}..${s.max ?? "inf"}]${s.required ? " required" : ""}`;
    case "string":
      return `${key}:string${s.required ? " required" : ""}${s.max ? ` max${s.max}` : ""}`;
    case "boolean":
      return `${key}:boolean${s.required ? " required" : ""}`;
    case "stringArray":
      return `${key}:string[]${s.maxItems ? ` max${s.maxItems}` : ""}${s.required ? " required" : ""}`;
    case "objectArray":
      return `${key}:object[]{${Object.entries(s.itemFields)
        .map(([fk, fs]) => describeParam(fk, fs))
        .join(",")}}${s.required ? " required" : ""}`;
    default:
      return key;
  }
}

/** Parameter specs for a SUBSET of primitives (e.g. repair prompt: only what the scene uses). */
export function primitiveSpecsFor(names?: Set<string>): string {
  const common = Object.entries(primitives.common)
    .map(([k, s]) => describeParam(k, s))
    .join(", ");
  const entries = Object.entries(primitives.primitives).filter(([name]) => !names || names.has(name));
  const list = entries
    .map(([name, def]) => {
      const params = Object.entries(def.params)
        .map(([k, s]) => describeParam(k, s))
        .join(", ");
      return `${name} [${def.category}]: ${params}`;
    })
    .join("\n");
  const scope = names
    ? `Scoped primitives (used by this scene + headline family) - other registry names may be substituted if the root cause requires: ${Object.keys(primitives.primitives).join(", ")}`
    : "Registered primitives - ONLY these names/params may be used (enums are exhaustive)";
  return `## ${scope}\nCommon element params (apply to ALL elements): ${common}\n${list}`;
}

/** Full machine-readable parameter spec per primitive (enums spelled out - prevents invalid values). */
function primitiveSpecs(): string {
  return primitiveSpecsFor(undefined);
}

/** Design-system constraints embedded in every generation prompt (source of truth: design-system/). */
export function designBiblePrompt(): string {
  return [
    "# MASTER DESIGN BIBLE (binding constraints)",
    "## Colors",
    compact(colors),
    "## Typography",
    compact(typography),
    "## Composition grammars (choose one per scene)",
    JSON.stringify(composition.grammars),
    `safeArea: ${JSON.stringify(composition.safeArea)}, maxElementsPerScene: ${composition.maxElementsPerScene}`,
    "## Motion vocabulary (use ONLY these)",
    compact(motion.vocabulary),
    `scene duration range: ${motion.durations.scene.min}-${motion.durations.scene.max}s, entrance ${motion.durations.entrance.min}-${motion.durations.entrance.max}s`,
    "## Forbidden patterns (Slop Critic scores against these ids)",
    JSON.stringify(forbiddenPatterns.patterns.map((p) => `${p.id}: ${p.rule}`)),
    primitiveSpecs(),
    "Rules: dark near-black backgrounds, off-white type, ONE dominant accent per scene (semantic), strong negative space, symbolic objects over literal imagery, short high-impact uppercase headlines, max 2 accent words, no paragraphs as primary content.",
  ].join("\n\n");
}

/**
 * Compact design brief for QA/vision calls (Phase 2 §11/15): same rules, ~1/4 the tokens.
 * Gateway timeouts (HTTP 524) and rate limits punish oversized review prompts.
 */
export function designBibleCompactPrompt(): string {
  const accentLine = Object.entries(colors.accents)
    .map(([k, a]) => `${k} ${a.value} (${a.semantic.split(";")[0]})`)
    .join(", ");
  const tier = (name: keyof typeof typography.scale): string => {
    const s = typography.scale[name];
    return `${name}: ${s.default}px w${s.weight}${s.uppercase ? " UPPERCASE" : ""}`;
  };
  return [
    "# DESIGN BIBLE (reference-derived, compact)",
    `Colors: bg ${colors.background.base} (dark, radial vignette), text ${colors.text.primary} / secondary ${colors.text.secondary}; accents: ${accentLine}. ONE dominant accent per scene, semantic use only, max 2 accent words.`,
    `Typography (bold grotesque): ${tier("headline")}, ${tier("subheadline")}, ${tier("label")}; headline align left preferred, max ${typography.rules.maxHeadlineLines} lines / ${typography.rules.maxHeadlineChars} chars, never shrink to fit.`,
    `Composition grammars: ${composition.grammars.join(", ")}. Reference shares: leftTextRightObject 30%, centered 20%, top/bottom-object 30%, typographyDominant/asymmetric 20%. Safe margins ~8% x. Max ${composition.maxElementsPerScene} elements/scene; one text block + one dominant object; 60-70% negative space.`,
    `Motion: entrance ${motion.vocabulary.entrance.join("/")}; emphasis ${motion.vocabulary.emphasis.join("/")}; exit ${motion.vocabulary.exit.join("/")}. Restrained (measured frame-diff 0.0112), static camera, soft ease-out, staged sequential entrances.`,
    `Forbidden: ${forbiddenPatterns.patterns.map((p) => p.id).join(", ")}.`,
  ].join("\n");
}

/**
 * HARD scene-layout rules shared by every scene entry point (generation, repair,
 * regeneration) so all three enforce the SAME constraints - validation rejects
 * violations and the corrective re-ask includes this text.
 */
export function sceneRulesPrompt(): string {
  return [
    "HARD LAYOUT RULES (validation rejects violations):",
    "- Offsets are % of the FULL canvas and may only move content INWARD from an edge anchor: left/topLeft/bottomLeft => offsetX >= 0; right/topRight/bottomRight => offsetX <= 0; top/topLeft/topRight => offsetY >= 0; bottom/bottomLeft/bottomRight => offsetY <= 0. Prefer offset 0; use positions (not offsets) for placement.",
    "- Headline budget: left/right anchors (leftTextRightObject, split, rightTextLeftObject) => MAX 34 chars; wide anchors => MAX 60 chars. SINGLE LINE only (no \\n - the renderer wraps), total rendered lines <= 4, at most 2 accent words.",
    "- Bands must not collide: the headline and any other TEXT, and any large OBJECT (Circle/Grid/Stack/diagrams), must occupy different bands at different anchors OR share the SAME anchor (the renderer stacks same-anchor items safely). Examples: headline top => objects/text go center or bottom; headline left => objects go RIGHT only; never place an object where the headline's lines run.",
    "- A single long word (e.g. PENGARUHNYA) overflows a 46% side column into the object side. If the headline contains words longer than ~9 characters, use a WIDE anchor (centered / topTextBottomObject / typographyDominant) or move the object to the opposite band with clear separation.",
    "- One dominant accent per scene; max 4 elements; preserve negative space (60-70% empty).",
  ].join("\n");
}

export interface BeatPrompt {
  id: string;
  text: string;
  why?: string;
  emotion?: string;
  metaphorHints?: string[];
  important?: boolean;
  timing?: { start: number; end: number; duration: number; source: string };
}

export function beatsPrompt(beats: BeatPrompt[]): string {
  return `# Story beats\n${beats
    .map(
      (b, i) =>
        `${i + 1}. [${b.id}] "${b.text}"${b.why ? ` — why: ${b.why}` : ""}${b.emotion ? ` — emotion: ${b.emotion}` : ""}${
          b.timing ? ` — timing: ${b.timing.start.toFixed(2)}s-${b.timing.end.toFixed(2)}s (${b.timing.source})` : ""
        }`,
    )
    .join("\n")}`;
}

export function memoryPrompt(projectId: string): string {
  const global = readGlobalMemory();
  const own = global.filter((m) => m.projectId !== projectId);
  const priorProjects = [...new Set(global.map((m) => m.projectId))].filter((p) => p !== projectId);
  if (own.length === 0 && priorProjects.length === 0) {
    return "# Project memory\nNo prior scenes yet (first project).";
  }
  const mechCount = new Map<string, number>();
  for (const m of own) {
    if (m.visualMechanism) mechCount.set(m.visualMechanism, (mechCount.get(m.visualMechanism) ?? 0) + 1);
  }
  const mechLine = mechCount.size
    ? `Recently used mechanisms (vary away from repeats): ${[...mechCount.entries()].map(([k, v]) => `${k}×${v}`).join(", ")}`
    : "No mechanisms recorded yet.";
  return [
    "# Project memory (avoid repeating these visual solutions for the same meanings)",
    `Prior projects: ${priorProjects.join(", ") || "none"}`,
    mechLine,
    ...own.slice(-40).map(
      (m) =>
        `- [${m.projectId}/${m.sceneId}] purpose="${m.semanticPurpose}" concept="${m.visualConcept}" metaphor="${m.metaphor}" composition=${m.composition} objects=[${m.dominantObjects.join(",")}] primitives=[${m.primitiveCombination.join(",")}] motion=${m.motionPattern}`,
    ),
  ].join("\n");
}

export function candidateDiversityCheck(candidates: { metaphor: string; composition: string; objects: string[] }[]): string[] {
  const issues: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      const sameComposition = a.composition === b.composition;
      const overlap = a.objects.filter((o) => b.objects.includes(o)).length;
      if (sameComposition && overlap >= Math.min(a.objects.length, b.objects.length) && overlap > 0) {
        issues.push(`candidates ${i} and ${j} are near-duplicates (same composition "${a.composition}", overlapping objects)`);
      }
    }
  }
  return issues;
}

export function readScript(projectId: string): string {
  const p = path.join(process.cwd(), "projects", projectId, "input", "script.md");
  if (!fs.existsSync(p)) throw new Error(`script.md missing for project ${projectId}`);
  return fs.readFileSync(p, "utf8");
}

export function readAnalysis<T>(projectId: string, file: string): T | null {
  return readJson<T>(projectId, file);
}
