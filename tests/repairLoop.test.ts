import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runTargetedRepair, readRepairLedger, RepairBudgetTracker, REPAIR_BUDGET, REPAIR_LEDGER_PATH } from "../src/agents/repairLoop";
import { scriptedRepairProvider, type RepairProvider } from "../src/agents/repairProviders";
import { classifyFailures } from "../src/agents/repairContext";
import { evaluatePreRenderGate, preRenderIssues } from "../src/validation/preRenderGate";
import { currentSceneFingerprint } from "../src/core/snapshot";
import { readJsonAt, writeJsonAt } from "../src/core/projectStore";
import type { SceneSpec } from "../src/validation/schema";
import type { RepairProposal } from "../src/validation/repairContract";
import type { VisualGateReport } from "../src/validation/visualGates";

/**
 * Batch C / §11-§14: evidence-driven repair loop with budget, keep/rollback and ledger.
 * Driven by the scripted provider - no model latency, no flakiness.
 */

const clipScene = (): SceneSpec =>
  ({
    sceneId: "scene_03",
    duration: 3,
    purpose: "test purpose for scene",
    visualConcept: "test_concept",
    composition: "leftTextRightObject",
    elements: [
      { primitive: "WordReveal", text: "OVERFLOWING", position: "right", scale: 2.2, accent: "teal", role: "semantic", purpose: "hero word" },
      { primitive: "Circle", position: "bottom", diameterPct: 30, accent: "none", role: "semantic", purpose: "ring" },
    ],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
  }) as unknown as SceneSpec;

const cleanScene = (): SceneSpec =>
  ({
    sceneId: "scene_01",
    duration: 3,
    purpose: "test purpose for scene",
    visualConcept: "test_concept",
    composition: "topTextBottomObject",
    elements: [{ primitive: "Circle", position: "bottom", diameterPct: 40, accent: "teal", role: "semantic", purpose: "ring" }],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
  }) as unknown as SceneSpec;

interface Fixture {
  dir: string;
  scenes: SceneSpec[];
}

function makeProject(scene: SceneSpec): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-loop-"));
  writeJsonAt(dir, `scenes/${scene.sceneId}.json`, scene);
  return { dir, scenes: [scene] };
}

/** Model-only measurement seam (no render, no browser at call time). */
const modelSources = async (scenes: SceneSpec[]) => ({
  scenes,
  preRenderHard: scenes.flatMap((s) =>
    preRenderIssues(s)
      .filter((i) => i.severity === "hard")
      .map((i) => ({ sceneId: i.sceneId, failureType: i.failureType, magnitude: i.magnitude })),
  ),
  artifactConsistent: true,
});

const failuresFor = (scenes: SceneSpec[]) =>
  classifyFailures({
    scenes,
    preRenderIssues: scenes.flatMap((s) => preRenderIssues(s)),
  });

const change = (target: string, property: string, from: number, to: number): RepairProposal => ({
  sceneId: "",
  reason: "measured fix",
  changes: [{ target, property, from, to }],
  preserve: ["scene meaning", "timing"],
});

beforeAll(async () => {
  // one browser batch: measure the fixture text so geometry/metrics are stable for the file
  await evaluatePreRenderGate([clipScene(), cleanScene()]);
}, 60000);

describe("targeted repair loop", () => {
  it("KEEPS an improving repair and records it in the ledger", async () => {
    const { dir, scenes } = makeProject(clipScene());
    const baseline = await modelSources(scenes);
    const failures = failuresFor(scenes);
    expect(failures.some((f) => f.type === "layout_clip")).toBe(true);

    const proposal = { ...change("elements:0", "scale", 2.2, 1.3), sceneId: "scene_03" };
    const provider: RepairProvider = scriptedRepairProvider([{ proposal }]);
    const result = await runTargetedRepair({
      dir,
      scenes,
      round: 1,
      failures,
      provider,
      baseline,
      measure: modelSources,
      maxScenes: 1,
    });

    expect(result.kept).toEqual(["scene_03"]);
    expect((result.scenes[0].elements[0] as { scale: number }).scale).toBe(1.3);
    // candidate written to disk and kept
    const onDisk = readJsonAt<SceneSpec>(dir, "scenes/scene_03.json");
    expect((onDisk!.elements[0] as { scale: number }).scale).toBe(1.3);
    // the TARGET failure (frame clipping) is gone from the candidate measurement
    const after = await modelSources(result.scenes);
    expect(after.preRenderHard.filter((h) => h.sceneId === "scene_03" && h.failureType === "layout_clip")).toEqual([]);

    const ledger = readRepairLedger(dir);
    expect(ledger).toHaveLength(1);
    const row = ledger[0];
    expect(row.decision).toBe("KEEP");
    expect(row.failureType).toBe("layout_clip");
    expect(row.baselineHash).toBeTruthy();
    expect(row.candidateHash).toBeTruthy();
    expect(row.baselineHash).not.toBe(row.candidateHash);
    expect(row.evidenceBefore).toMatch(/frame edge/);
    expect(row.evidenceAfter).toBe("target failure cleared");
    expect(row.proposal).toBeTruthy();
    expect(row.budgetRemaining).toBeLessThan(REPAIR_BUDGET.maxCallsTotal);
    expect(row.comparison).toMatch(/decision: KEEP/);
    expect(row.measurement).toBe("measured"); // a measurement step ran (model-only, no render)
    expect(row.render).toBe("not-rendered");
    expect(row.promptHash).toMatch(/^[0-9a-f]{64}$/);
    // snapshot exists for the baseline
    expect(fs.existsSync(path.join(dir, "snapshots"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("ROLLS BACK a worsening repair and restores the exact baseline bytes", async () => {
    const { dir, scenes } = makeProject(clipScene());
    const beforeHash = currentSceneFingerprint(dir).sceneHashes.scene_03;
    const beforeBytes = fs.readFileSync(path.join(dir, "scenes", "scene_03.json"), "utf8");

    const proposal = { ...change("elements:0", "scale", 2.2, 2.9), sceneId: "scene_03" };
    const result = await runTargetedRepair({
      dir,
      scenes,
      round: 1,
      failures: failuresFor(scenes),
      provider: scriptedRepairProvider([{ proposal }]),
      baseline: await modelSources(scenes),
      measure: modelSources,
      maxScenes: 1,
    });

    expect(result.rolledBack).toEqual(["scene_03"]);
    expect(result.kept).toEqual([]);
    // baseline restored on disk (byte-identical) and in memory
    expect(currentSceneFingerprint(dir).sceneHashes.scene_03).toBe(beforeHash);
    expect(fs.readFileSync(path.join(dir, "scenes", "scene_03.json"), "utf8")).toBe(beforeBytes);
    expect((result.scenes[0].elements[0] as { scale: number }).scale).toBe(2.2);

    const ledger = readRepairLedger(dir);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].decision).toBe("ROLLBACK");
    expect(ledger[0].reason).toMatch(/worsened/);
    expect(ledger[0].comparison).toMatch(/decision: ROLLBACK/);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("REJECTS a repair that leaves the target failure unchanged", async () => {
    const { dir, scenes } = makeProject(clipScene());
    const proposal = { ...change("elements:0", "offsetY", 0, 5), sceneId: "scene_03" };
    const result = await runTargetedRepair({
      dir,
      scenes,
      round: 1,
      failures: failuresFor(scenes),
      provider: scriptedRepairProvider([{ proposal }]),
      baseline: await modelSources(scenes),
      measure: modelSources,
      maxScenes: 1,
    });
    expect(result.rejected).toEqual(["scene_03"]);
    expect(result.kept).toEqual([]);
    const ledger = readRepairLedger(dir);
    expect(ledger[ledger.length - 1].decision).toBe("REJECT");
    expect(ledger[ledger.length - 1].reason).toMatch(/unchanged/);
    expect((result.scenes[0].elements[0] as { offsetY?: number }).offsetY ?? 0).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("ROLLS BACK when the measured evidence gains a NEW hard failure", async () => {
    const { dir, scenes } = makeProject(cleanScene());
    const beforeHash = currentSceneFingerprint(dir).sceneHashes.scene_01;

    // the model-only pre-render contract cannot see pixel problems: the candidate passes it,
    // but the measured evidence reports a brand new hard failure -> must roll back
    const visualGatesFor = (fail: boolean): VisualGateReport => ({
      schema: "visual-gates/1",
      generatedAt: "2026-10-08T00:00:00.000Z",
      scenes: [
        {
          sceneId: "scene_01",
          empty: {
            sceneId: "scene_01",
            status: fail ? "fail" : "ok",
            reason: fail
              ? "accidentally empty: 3 non-text objects are placed in the middle band but its rendered occupancy is 0.290% (< 0.5%)"
              : "all expected bands carry visible content (occupancy 5.10%)",
            occupancy: 0.046,
            contentBBox: null,
            motionDelta: 0.001,
            regionOccupancy: { top: 0.1, middle: 0.002, bottom: 0.02, subtitleBand: 0.05 },
            bands: [],
          },
          readability: { sceneId: "scene_01", status: "ok", reasons: [], brightShare: 0.04, headlineHeightPx: 104, smallestTextHeightPx: 40, subtitleBandOccupancy: 0.05 },
        },
      ],
      hard: fail
        ? ["scene_01: accidentally empty: 3 non-text objects are placed in the middle band but its rendered occupancy is 0.290% (< 0.5%)"]
        : [],
      warnings: [],
      ok: !fail,
    });

    const proposal = { ...change("elements:0", "scale", 1, 1.1), sceneId: "scene_01" };
    const failure = classifyFailures({
      scenes,
      judgeIssues: [{ sceneId: "scene_01", evidence: "judge: ring looks small" }],
    });
    expect(failure[0].type).toBe("judge_issue");

    const result = await runTargetedRepair({
      dir,
      scenes,
      round: 1,
      failures: failure,
      provider: scriptedRepairProvider([{ proposal }]),
      baseline: { scenes, visualGates: visualGatesFor(false), artifactConsistent: true },
      measure: async (s) => ({ scenes: s, visualGates: visualGatesFor(true), artifactConsistent: true }),
      maxScenes: 1,
    });
    expect(result.rolledBack).toEqual(["scene_01"]);
    expect(currentSceneFingerprint(dir).sceneHashes.scene_01).toBe(beforeHash);
    const ledger = readRepairLedger(dir);
    expect(ledger[0].decision).toBe("ROLLBACK");
    expect(ledger[0].reason).toMatch(/new hard failure/);
    expect(ledger[0].reason).toMatch(/scene_01:empty_visual_band/);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("rejects a contract violation without touching the baseline", async () => {
    const { dir, scenes } = makeProject(clipScene());
    const beforeHash = currentSceneFingerprint(dir).sceneHashes.scene_03;
    const proposal = { ...change("elements:0", "purpose", 0, 0), sceneId: "scene_03", reason: "nonsense" };
    const result = await runTargetedRepair({
      dir,
      scenes,
      round: 1,
      failures: failuresFor(scenes),
      provider: scriptedRepairProvider([{ proposal }]),
      baseline: await modelSources(scenes),
      measure: modelSources,
      maxScenes: 1,
    });
    expect(result.kept).toEqual([]);
    const row = readRepairLedger(dir)[0];
    expect(row.decision).toBe("REJECT");
    expect(row.reason).toMatch(/contract violation/);
    expect(currentSceneFingerprint(dir).sceneHashes.scene_03).toBe(beforeHash);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("enforces the per-scene attempt cap and the total call budget", async () => {
    const { dir, scenes } = makeProject(clipScene());
    const tracker = new RepairBudgetTracker({ ...REPAIR_BUDGET, maxAttemptsPerScene: 1, maxCallsTotal: 1 });
    const provider: RepairProvider = scriptedRepairProvider([
      { error: "provider exploded" },
      { proposal: { ...change("elements:0", "scale", 2.2, 1.6), sceneId: "scene_03" } },
    ]);
    const result = await runTargetedRepair({
      dir,
      scenes,
      round: 1,
      failures: failuresFor(scenes),
      provider,
      tracker,
      baseline: await modelSources(scenes),
      measure: modelSources,
      maxScenes: 2,
      budget: { maxAttemptsPerScene: 1, maxCallsTotal: 1 },
    });
    expect(result.budgetUsed).toBe(1);
    expect(result.budgetRemaining).toBe(0);
    expect(result.kept).toEqual([]);
    const ledger = readRepairLedger(dir);
    expect(ledger[0].decision).toBe("ERROR");
    expect(ledger.some((r) => r.decision === "SKIPPED")).toBe(true);
    expect(ledger.every((r) => r.budgetRemaining >= 0)).toBe(true);
    // baseline untouched
    expect((readJsonAt<SceneSpec>(dir, "scenes/scene_03.json")!.elements[0] as { scale: number }).scale).toBe(2.2);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("never sends the same repair prompt twice", async () => {
    const { dir, scenes } = makeProject(clipScene());
    const failures = failuresFor(scenes);
    const baseline = await modelSources(scenes);
    const goodProposal = { ...change("elements:0", "scale", 2.2, 1.6), sceneId: "scene_03" };
    // first run: the repair is rejected (offset change that does not fix anything)
    const first = await runTargetedRepair({
      dir,
      scenes,
      round: 1,
      failures,
      provider: scriptedRepairProvider([{ proposal: { ...change("elements:0", "offsetY", 0, 5), sceneId: "scene_03" } }]),
      baseline,
      measure: modelSources,
      maxScenes: 1,
    });
    expect(first.rejected).toEqual(["scene_03"]);

    // second run, same round + same failure evidence -> identical prompt -> refused
    const second = await runTargetedRepair({
      dir,
      scenes: first.scenes,
      round: 1,
      failures: failuresFor(first.scenes),
      provider: scriptedRepairProvider([{ proposal: goodProposal }]),
      baseline,
      measure: modelSources,
      maxScenes: 1,
    });
    const rows = readRepairLedger(dir);
    const duplicate = rows.find((r) => /duplicate repair prompt/.test(r.reason));
    expect(duplicate).toBeDefined();
    expect(duplicate!.decision).toBe("REJECT");
    expect(second.kept).toEqual([]);
    expect(second.budgetUsed).toBe(0); // no model call was made
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("times out a stalled provider instead of freezing the loop", async () => {
    const { dir, scenes } = makeProject(clipScene());
    const beforeHash = currentSceneFingerprint(dir).sceneHashes.scene_03;
    const t0 = Date.now();
    const result = await runTargetedRepair({
      dir,
      scenes,
      round: 1,
      failures: failuresFor(scenes),
      provider: scriptedRepairProvider([{ stall: true }]),
      baseline: await modelSources(scenes),
      measure: modelSources,
      maxScenes: 1,
      budget: { callTimeoutMs: 250, maxAttemptsPerScene: 1 },
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5000);
    expect(result.kept).toEqual([]);
    const row = readRepairLedger(dir)[0];
    expect(row.decision).toBe("TIMEOUT");
    expect(row.reason).toMatch(/timed out after 250ms/);
    expect(currentSceneFingerprint(dir).sceneHashes.scene_03).toBe(beforeHash);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it("accumulates the ledger and keeps the file machine-readable", async () => {
    const { dir, scenes } = makeProject(clipScene());
    await runTargetedRepair({
      dir,
      scenes,
      round: 1,
      failures: failuresFor(scenes),
      provider: scriptedRepairProvider([{ proposal: { ...change("elements:0", "offsetY", 0, 5), sceneId: "scene_03" } }]),
      baseline: await modelSources(scenes),
      measure: modelSources,
      maxScenes: 1,
    });
    const raw = readJsonAt<unknown[]>(dir, REPAIR_LEDGER_PATH);
    expect(Array.isArray(raw)).toBe(true);
    expect((raw as Record<string, unknown>[])[0].schema).toBe("repair-ledger/1");
    expect((raw as Record<string, unknown>[])[0].sceneId).toBe("scene_03");
    expect(readRepairLedger(dir)).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);
});
