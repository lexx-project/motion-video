import { primitiveRegistry } from "../primitives/registry";
import { readGlobalMemory, appendMemory, markStage, writeJson, updateManifest } from "../core/projectStore";
import { QA_THRESHOLDS } from "../core/output";
import type { SceneSpec } from "../validation/schema";
import type { MemoryEntry } from "../core/projectStore";

export interface NoveltyDimension {
  dimension:
    | "sameMetaphor"
    | "sameMechanism"
    | "sameDominantObject"
    | "sameComposition"
    | "samePrimitiveCombination"
    | "sameMotionPattern"
    | "sameStorytellingStructure";
  matched: boolean;
}

export interface NoveltyResult {
  sceneId: string;
  similarity: number;
  matchedDimensions: string[];
  verdict: "accept" | "revise" | "reject";
  against: string;
}

const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );

const normMech = (s: string | undefined): string =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 1;
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
};

const sceneObjects = (scene: SceneSpec): string[] =>
  scene.elements
    .map((e) => e.primitive)
    .filter((p) => primitiveRegistry[p]?.category === "object");

export function entryFromScene(projectId: string, scene: SceneSpec): MemoryEntry {
  const objects = sceneObjects(scene);
  const dominant =
    objects.length > 0
      ? objects
      : scene.elements.map((e) => e.primitive).slice(0, 2);
  return {
    projectId,
    sceneId: scene.sceneId,
    visualConcept: scene.visualConcept,
    metaphor: scene.metadata && typeof scene.metadata.metaphor === "string" ? scene.metadata.metaphor : scene.purpose,
    composition: scene.composition,
    dominantObjects: dominant,
    primitiveCombination: scene.elements.map((e) => e.primitive),
    motionPattern: `${scene.motion.entrance}/${scene.motion.emphasis}/${scene.motion.exit}`,
    semanticPurpose: scene.purpose,
    visualMechanism: scene.storyboard?.visualMechanism,
  };
}

/**
 * Deterministic novelty comparison (MASTER_SPEC section 10).
 * Sharing a primitive is fine; the same combination serving the same meaning is not.
 */
export function compareNovelty(a: MemoryEntry, b: MemoryEntry): NoveltyDimension[] {
  const aPrims = new Set(a.primitiveCombination);
  const bPrims = new Set(b.primitiveCombination);
  const aObjects = new Set(a.dominantObjects);
  const bObjects = new Set(b.dominantObjects);
  const sameComposition = a.composition === b.composition;
  const sameMotion = a.motionPattern === b.motionPattern;
  const metaphorOverlap = jaccard(tokens(a.semanticPurpose + " " + a.metaphor), tokens(b.semanticPurpose + " " + b.metaphor));
  return [
    { dimension: "sameMetaphor", matched: metaphorOverlap >= 0.6 },
    {
      dimension: "sameMechanism",
      matched:
        Boolean(a.visualMechanism) &&
        Boolean(b.visualMechanism) &&
        normMech(a.visualMechanism) === normMech(b.visualMechanism),
    },
    { dimension: "sameDominantObject", matched: aObjects.size > 0 && jaccard(aObjects, bObjects) >= 0.7 },
    { dimension: "sameComposition", matched: sameComposition },
    { dimension: "samePrimitiveCombination", matched: jaccard(aPrims, bPrims) >= 0.8 },
    { dimension: "sameMotionPattern", matched: sameMotion },
    { dimension: "sameStorytellingStructure", matched: sameComposition && sameMotion },
  ];
}

const WEIGHTS: Record<string, number> = {
  sameMetaphor: 25,
  sameMechanism: 15,
  sameDominantObject: 10,
  sameComposition: 10,
  samePrimitiveCombination: 15,
  sameMotionPattern: 15,
  sameStorytellingStructure: 10,
};

export function similarityScore(dims: NoveltyDimension[]): number {
  return dims.reduce((n, d) => n + (d.matched ? WEIGHTS[d.dimension] : 0), 0);
}

const verdictFor = (score: number): NoveltyResult["verdict"] =>
  score > 70 ? "reject" : score >= 50 ? "revise" : "accept";

export interface NoveltyOptions {
  /**
   * Fixture provenance (Batch C / §16): project ids whose history must NOT be compared against.
   * Used ONLY when a test/E2E project was copied from an existing one - otherwise the copy
   * would score ~100 against its own source and trigger expensive production repair.
   * Production runs pass nothing: every other project is still compared, thresholds unchanged.
   */
  excludeProjects?: string[];
}

/** Compare every scene against project history + the other scenes of this project. */
export function runNoveltyCheck(
  projectId: string,
  scenes: SceneSpec[],
  history: MemoryEntry[] = readGlobalMemory(),
  opts: NoveltyOptions = {},
): NoveltyResult[] {
  const excluded = new Set(opts.excludeProjects ?? []);
  const external = history.filter((h) => h.projectId !== projectId && !excluded.has(h.projectId));
  const ownEntries = scenes.map((s) => entryFromScene(projectId, s));
  const results: NoveltyResult[] = [];

  scenes.forEach((scene, i) => {
    const entry = ownEntries[i];
    let worst: NoveltyResult = {
      sceneId: scene.sceneId,
      similarity: 0,
      matchedDimensions: [],
      verdict: "accept",
      against: "history",
    };
    for (const h of external) {
      const dims = compareNovelty(entry, h);
      const score = similarityScore(dims);
      if (score > worst.similarity) {
        worst = {
          sceneId: scene.sceneId,
          similarity: score,
          matchedDimensions: dims.filter((d) => d.matched).map((d) => d.dimension),
          verdict: verdictFor(score),
          against: `${h.projectId}/${h.sceneId}`,
        };
      }
    }
    for (let j = 0; j < i; j++) {
      const dims = compareNovelty(entry, ownEntries[j]);
      const score = similarityScore(dims);
      if (score > worst.similarity) {
        worst = {
          sceneId: scene.sceneId,
          similarity: score,
          matchedDimensions: dims.filter((d) => d.matched).map((d) => d.dimension),
          verdict: verdictFor(score),
          against: `same-project/${ownEntries[j].sceneId}`,
        };
      }
    }
    results.push(worst);
  });
  return results;
}

export function commitProjectMemory(projectId: string, scenes: SceneSpec[]): void {
  for (const scene of scenes) appendMemory(entryFromScene(projectId, scene));
}

export interface NoveltyReport {
  results: NoveltyResult[];
  rejectedSceneIds: string[];
  status: "pass" | "needs_repair";
}

export function noveltyStage(projectId: string, scenes: SceneSpec[], opts: NoveltyOptions = {}): NoveltyReport {
  markStage(projectId, "novelty", "running");
  const results = runNoveltyCheck(projectId, scenes, readGlobalMemory(), opts);
  const rejectedSceneIds = results
    .filter((r) => r.verdict === "reject" && r.similarity > QA_THRESHOLDS.noveltySimilarityMax)
    .map((r) => r.sceneId);
  const report: NoveltyReport = {
    results,
    rejectedSceneIds,
    status: rejectedSceneIds.length > 0 ? "needs_repair" : "pass",
  };
  writeJson(projectId, "qa/novelty.json", report);
  markStage(projectId, "novelty", rejectedSceneIds.length > 0 ? "failed" : "done");
  if (rejectedSceneIds.length === 0) {
    updateManifest(projectId, {});
  }
  return report;
}
