import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { runNoveltyCheck, entryFromScene } from "../src/agents/novelty";
import { QA_THRESHOLDS } from "../src/core/output";
import type { MemoryEntry } from "../src/core/projectStore";
import type { SceneSpec } from "../src/validation/schema";

/**
 * Batch C / §16: novelty fixture provenance.
 *
 * A project COPIED from an existing one scores ~100 against its own source, which sends the
 * pipeline into expensive production repair (observed: >11 minutes of stalled repair calls).
 * The fix is provenance-scoped: skip ONLY the project it was copied from. Production
 * comparisons and thresholds stay exactly as they are.
 */

const scenes = (): SceneSpec[] =>
  [
    {
      sceneId: "scene_01",
      duration: 3,
      purpose: "pleasing everyone tires you out",
      visualConcept: "drifting_answer_line",
      composition: "leftTextRightObject",
      elements: [
        { primitive: "Line", position: "right", accent: "gold", role: "semantic", purpose: "original heading" },
        { primitive: "Badge", text: "YES", position: "right", role: "semantic", purpose: "each compliance" },
      ],
      motion: { entrance: "fade", emphasis: "highlight", exit: "fade" },
    },
  ] as unknown as SceneSpec[];

const historyFrom = (projectId: string): MemoryEntry[] => scenes().map((s) => entryFromScene(projectId, s));

describe("novelty self-similarity fixtures", () => {
  it("production path still rejects a copy of another project (novelty is NOT disabled)", () => {
    const history = [...historyFrom("proj_source"), ...historyFrom("proj_unrelated")];
    const results = runNoveltyCheck("proj_copy", scenes(), history);
    expect(results[0].verdict).toBe("reject");
    expect(results[0].similarity).toBeGreaterThan(QA_THRESHOLDS.noveltySimilarityMax);
    expect(results[0].against).toBe("proj_source/scene_01");
  });

  it("fixture provenance skips ONLY the copied-from project", () => {
    const history = [...historyFrom("proj_source"), ...historyFrom("proj_unrelated")];
    const results = runNoveltyCheck("proj_copy", scenes(), history, { excludeProjects: ["proj_source"] });
    expect(results[0].against).not.toMatch(/^proj_source\//);
    // everything else is still compared - this is not a novelty bypass
    expect(results[0].against).toBe("proj_unrelated/scene_01");
  });

  it("production thresholds are untouched", () => {
    expect(QA_THRESHOLDS.noveltySimilarityMax).toBe(70);
  });

  it("an empty exclusion list behaves exactly like production", () => {
    const history = historyFrom("proj_source");
    const withOption = runNoveltyCheck("proj_copy", scenes(), history, { excludeProjects: [] });
    const without = runNoveltyCheck("proj_copy", scenes(), history);
    expect(withOption).toEqual(without);
  });

  it.runIf(fs.existsSync(path.join("projects", "_memory", "history.json")))(
    "the real memory cannot make a fixture compare against its own source",
    () => {
      const source = "proj_p3_demo";
      const sourceScenesDir = path.join("projects", source, "scenes");
      if (!fs.existsSync(sourceScenesDir)) return;
      const file = fs.readdirSync(sourceScenesDir).find((f) => /^scene_\d+\.json$/.test(f));
      if (!file) return;
      const scene = JSON.parse(fs.readFileSync(path.join(sourceScenesDir, file), "utf8")) as SceneSpec;
      const real = JSON.parse(fs.readFileSync(path.join("projects", "_memory", "history.json"), "utf8")) as MemoryEntry[];

      const withoutProvenance = runNoveltyCheck("_fixture_probe", [scene], real);
      const withProvenance = runNoveltyCheck("_fixture_probe", [scene], real, { excludeProjects: [source] });

      // without provenance the copy matches its source (that is the bug we are fixing)
      expect(withoutProvenance.some((r) => r.against.startsWith(`${source}/`))).toBe(true);
      // with provenance the source is skipped, other projects are still compared
      expect(withProvenance.some((r) => r.against.startsWith(`${source}/`))).toBe(false);
      expect(withProvenance.every((r) => !r.against.startsWith(`${source}/`))).toBe(true);
    },
  );
});
