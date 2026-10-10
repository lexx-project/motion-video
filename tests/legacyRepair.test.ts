import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runBoundedLegacyRepair, scopeMetrics, storyboardPromises } from "../src/agents/legacyRepair";
import { readRepairLedger } from "../src/agents/repairLoop";
import { GenerationBudget } from "../src/core/generationBudget";
import { currentSceneFingerprint } from "../src/core/snapshot";
import { writeJsonAt, readJsonAt } from "../src/core/projectStore";
import { evaluateSemanticEnactment } from "../src/validation/semanticEnactment";
import type { MetricSources } from "../src/agents/repairCompare";
import type { SceneSpec } from "../src/validation/schema";
import type { Storyboard } from "../src/validation/storyboardSchema";
import { passScene, missingObjectScene } from "./fixtures/batchD";

/**
 * Batch E Phase 2: the legacy (judge-driven) repair path under the generation budget +
 * explicit policy: snapshot -> run -> schema/promise/gate validation -> compare -> KEEP or
 * ROLLBACK (byte-exact restore). No LLM is used here: the repair() seam is scripted.
 */

function makeProject(scenes: SceneSpec[]): { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-repair-"));
  fs.mkdirSync(path.join(dir, "concepts"), { recursive: true });
  for (const s of scenes) writeJsonAt(dir, `scenes/${s.sceneId}.json`, s);
  return { dir };
}

const baselineMetrics = (scenes: SceneSpec[]): MetricSources => ({
  scenes,
  semantic: evaluateSemanticEnactment(scenes),
  artifactConsistent: true,
});

describe("bounded legacy repair (Batch E / Phase 2)", () => {
  it("SKIPPED_BUDGET without invoking the repair when the budget is exhausted", async () => {
    const scenes = [passScene()];
    const { dir } = makeProject(scenes);
    const budget = new GenerationBudget({ wallClockMs: 1000, minCallMs: 60_000 });
    let called = false;
    const before = currentSceneFingerprint(dir).sceneHashes.scene_01;
    const out = await runBoundedLegacyRepair({
      projectId: "_t",
      dir,
      scenes,
      sceneId: "scene_01",
      budget,
      round: 1,
      mode: "scene",
      baselineMetrics: baselineMetrics(scenes),
      repair: async () => {
        called = true;
        return scenes[0];
      },
    });
    expect(out.decision).toBe("SKIPPED_BUDGET");
    expect(called).toBe(false);
    expect(currentSceneFingerprint(dir).sceneHashes.scene_01).toBe(before);
    expect(budget.summary().legacyRepairsSkipped).toBe(1);
    const row = readRepairLedger(dir)[0];
    expect(row.decision).toBe("SKIPPED");
    expect(row.failureType).toBe("legacy_scene");
  });

  it("refuses a second legacy attempt for the same scene (one per generation)", async () => {
    const scenes = [passScene()];
    const { dir } = makeProject(scenes);
    const budget = new GenerationBudget();
    const req = {
      projectId: "_t",
      dir,
      scenes,
      sceneId: "scene_01",
      budget,
      round: 1,
      mode: "scene" as const,
      baselineMetrics: baselineMetrics(scenes),
      repair: async () => scenes[0],
    };
    const first = await runBoundedLegacyRepair(req);
    expect(first.decision).toBe("KEEP");
    const second = await runBoundedLegacyRepair(req);
    expect(second.decision).toBe("SKIPPED_BUDGET");
    expect(budget.summary().legacyRepairs).toHaveLength(1);
  });

  it("releases the scene claim after an ERROR so a narrow fallback is still allowed", async () => {
    const scenes = [passScene()];
    const { dir } = makeProject(scenes);
    const budget = new GenerationBudget();
    const err = await runBoundedLegacyRepair({
      projectId: "_t",
      dir,
      scenes,
      sceneId: "scene_01",
      budget,
      round: 1,
      mode: "storyboard",
      baselineMetrics: baselineMetrics(scenes),
      repair: async () => {
        throw new Error("provider exploded");
      },
    });
    expect(err.decision).toBe("ERROR");
    const fallback = await runBoundedLegacyRepair({
      projectId: "_t",
      dir,
      scenes,
      sceneId: "scene_01",
      budget,
      round: 1,
      mode: "scene",
      baselineMetrics: baselineMetrics(scenes),
      repair: async () => scenes[0],
    });
    expect(fallback.decision).toBe("KEEP");
    expect(budget.summary().legacyRepairs.map((r) => r.decision)).toEqual(["ERROR", "KEEP"]);
  });

  it("ROLLS BACK a storyboard rewrite that drops a mandatory semantic promise", async () => {
    const scenes = [passScene()];
    const { dir } = makeProject(scenes);
    // simulate existing concept files that a rewrite would clobber
    const sbFile = path.join(dir, "concepts", "storyboard.json");
    fs.writeFileSync(sbFile, JSON.stringify({ storyboards: [scenes[0].storyboard] }), "utf8");
    const beforeHash = currentSceneFingerprint(dir).sceneHashes.scene_01;
    const budget = new GenerationBudget();

    const broken = JSON.parse(JSON.stringify(passScene())) as SceneSpec;
    const sb = broken.storyboard as Storyboard;
    sb.semanticObjects = sb.semanticObjects.filter((o) => o.id !== "gate_01"); // drops the promise!
    delete (broken.elements as { semanticId?: string }[])[1].semanticId;

    const out = await runBoundedLegacyRepair({
      projectId: "_t",
      dir,
      scenes,
      sceneId: "scene_01",
      budget,
      round: 1,
      mode: "storyboard",
      baselineMetrics: baselineMetrics(scenes),
      repair: async () => {
        // a rewrite also clobbers the concept file before validation runs
        fs.writeFileSync(sbFile, JSON.stringify({ storyboards: [] }), "utf8");
        return broken;
      },
    });
    expect(out.decision).toBe("ROLLBACK");
    expect(out.reason).toMatch(/dropped mandatory promises.*gate_01|object:gate_01/);
    expect(currentSceneFingerprint(dir).sceneHashes.scene_01).toBe(beforeHash);
    // storyboard concept files restored byte-for-byte as well
    const restored = JSON.parse(fs.readFileSync(sbFile, "utf8")) as { storyboards: unknown[] };
    expect(restored.storyboards).toHaveLength(1);
    expect(budget.summary().legacyRepairs[0].decision).toBe("ROLLBACK");
    const row = readRepairLedger(dir).find((r) => r.failureType === "legacy_storyboard");
    expect(row?.decision).toBe("ROLLBACK");
    expect(row?.reason).toMatch(/dropped mandatory promises/);
  });

  it("ROLLS BACK a candidate that changes the scene duration (VO/timeline preserved)", async () => {
    const scenes = [passScene()];
    const { dir } = makeProject(scenes);
    const budget = new GenerationBudget();
    const longer = { ...passScene(), duration: passScene().duration + 1 };
    const out = await runBoundedLegacyRepair({
      projectId: "_t",
      dir,
      scenes,
      sceneId: "scene_01",
      budget,
      round: 1,
      mode: "scene",
      baselineMetrics: baselineMetrics(scenes),
      repair: async () => longer,
    });
    expect(out.decision).toBe("ROLLBACK");
    expect(out.reason).toMatch(/duration/);
    const onDisk = readJsonAt<SceneSpec>(dir, "scenes/scene_01.json");
    expect(onDisk?.duration).toBe(passScene().duration);
  });

  it("ROLLS BACK a candidate that introduces a NEW semantic failure", async () => {
    const scenes = [missingObjectScene()]; // baseline: missing gate_01
    const { dir } = makeProject(scenes);
    const budget = new GenerationBudget();
    // candidate "fixes" the missing object with a Person for the promised gate -> new category failure
    const candidate = JSON.parse(JSON.stringify(passScene())) as SceneSpec;
    (candidate.elements as Record<string, unknown>[])[1] = {
      primitive: "Person",
      position: "right",
      accent: "none",
      role: "semantic",
      purpose: "the destination rendered as a person (obviously wrong)",
      semanticId: "gate_01",
      delay: 0,
      entrance: "fade",
    };
    const out = await runBoundedLegacyRepair({
      projectId: "_t",
      dir,
      scenes,
      sceneId: "scene_01",
      budget,
      round: 1,
      mode: "scene",
      baselineMetrics: baselineMetrics(scenes),
      repair: async () => candidate,
    });
    expect(out.decision).toBe("ROLLBACK");
    expect(out.reason).toMatch(/new semantic failure/);
    expect(out.reason).toMatch(/category_mismatch/);
  });

  it("KEEPS a valid neutral candidate and records it in the ledger", async () => {
    const scenes = [passScene()];
    const { dir } = makeProject(scenes);
    const before = currentSceneFingerprint(dir).sceneHashes.scene_01;
    const budget = new GenerationBudget({ maxLegacyRepairs: 2 });
    const neutral = JSON.parse(JSON.stringify(passScene())) as SceneSpec;
    neutral.purpose = "neutral change that keeps every promise";
    const out = await runBoundedLegacyRepair({
      projectId: "_t",
      dir,
      scenes,
      sceneId: "scene_01",
      budget,
      round: 1,
      mode: "scene",
      baselineMetrics: baselineMetrics(scenes),
      repair: async () => neutral,
    });
    expect(out.decision).toBe("KEEP");
    expect(out.scenes[0].purpose).toBe("neutral change that keeps every promise");
    expect(currentSceneFingerprint(dir).sceneHashes.scene_01).not.toBe(before);
    expect(evaluateSemanticEnactment([out.scenes[0]]).ok).toBe(true);
    const row = readRepairLedger(dir).find((r) => r.decision === "KEEP");
    expect(row?.failureType).toBe("legacy_scene");
    expect(row?.budgetRemaining).toBeGreaterThan(0); // wall-clock seconds left, recorded
  });

  it("scopeMetrics compares one scene against itself (apples-to-apples vectors)", () => {
    const a = passScene();
    const other = { ...passScene(), sceneId: "scene_02" };
    const scoped = scopeMetrics(
      { scenes: [a, other], collisions: { scene_01: { unintended: [] } as never, scene_02: { unintended: [] } as never }, artifactConsistent: true },
      "scene_01",
    );
    expect(scoped.scenes?.map((s) => s.sceneId)).toEqual(["scene_01"]);
    expect(Object.keys(scoped.collisions ?? {})).toEqual(["scene_01"]);
  });

  it("storyboardPromises extracts ids and typed events (the immutability contract)", () => {
    const p = storyboardPromises(passScene().storyboard);
    expect(p.objects).toEqual(["gate_01", "person_01"]);
    expect(p.events).toEqual(["event_01:enter", "event_02:move", "event_03:scale"]);
    expect(storyboardPromises(undefined)).toEqual({ objects: [], events: [] });
  });
});
