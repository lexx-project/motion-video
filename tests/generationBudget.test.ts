import { describe, it, expect, afterEach } from "vitest";
import {
  GenerationBudget,
  DEFAULT_GENERATION_BUDGET,
  BudgetExhaustedError,
  isBudgetExhausted,
  beginGenerationBudget,
  endGenerationBudget,
  activeGenerationBudget,
} from "../src/core/generationBudget";
import { chatRaw, completeJson } from "../src/agents/llm";

/**
 * Batch E Phase 1: generation-level budget.
 * All llm-layer tests below are network-free: an exhausted budget refuses BEFORE any
 * provider config/network work, and duplicate structured prompts are refused before chatRaw.
 */

afterEach(() => {
  endGenerationBudget();
});

describe("generation budget core (Batch E / Phase 1)", () => {
  it("documents its default limits", () => {
    expect(DEFAULT_GENERATION_BUDGET.wallClockMs).toBeGreaterThan(0);
    expect(DEFAULT_GENERATION_BUDGET.maxLlmCalls).toBeGreaterThan(0);
    expect(DEFAULT_GENERATION_BUDGET.maxRetriesPerCall).toBeLessThanOrEqual(4);
    expect(DEFAULT_GENERATION_BUDGET.maxLegacyRepairs).toBeGreaterThan(0);
    const b = new GenerationBudget({ wallClockMs: 1000, minCallMs: 5000 });
    expect(b.exhausted()).toBe(true); // minCallMs > wall clock -> always exhausted
    expect(b.allowLlmCall()).toBe(false);
  });

  it("refuses LLM calls once the call cap is reached", () => {
    const b = new GenerationBudget({ maxLlmCalls: 2 });
    expect(b.allowLlmCall()).toBe(true);
    b.recordLlmCall({ stage: "a", startedAt: new Date().toISOString(), ms: 5, outcome: "ok" });
    b.recordLlmCall({ stage: "b", startedAt: new Date().toISOString(), ms: 5, outcome: "ok" });
    expect(b.allowLlmCall()).toBe(false);
    expect(b.summary().llmCalls).toBe(2);
  });

  it("records timeouts and budget refusals in the summary", () => {
    const b = new GenerationBudget({ maxLlmCalls: 1 });
    b.recordLlmCall({ stage: "x", startedAt: new Date().toISOString(), ms: 900, outcome: "timeout" });
    b.recordLlmCall({ stage: "x", startedAt: new Date().toISOString(), ms: 0, outcome: "budget_refused" });
    const s = b.summary();
    expect(s.timeouts).toBe(1);
    expect(s.budgetRefusals).toBe(1);
    expect(s.llmCalls).toBe(1); // refusals are not counted as real calls
  });

  it("stage() throws a structured BudgetExhaustedError when the deadline is reached", async () => {
    const b = new GenerationBudget({ wallClockMs: 1000, minCallMs: 60_000 });
    await expect(b.stage("storyboards", async () => "never")).rejects.toBeInstanceOf(BudgetExhaustedError);
    const stages = b.summary().stages;
    expect(stages).toHaveLength(1);
    expect(stages[0].stage).toBe("storyboards");
    expect(stages[0].status).toBe("budget_exhausted");
  });

  it("stage() times successful and failing stages", async () => {
    const b = new GenerationBudget();
    await b.stage("ok", async () => 42);
    await expect(b.stage("bad", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const s = b.summary();
    expect(s.stages.find((x) => x.stage === "ok")?.status).toBe("done");
    expect(s.stages.find((x) => x.stage === "bad")?.status).toBe("failed");
    expect(s.stages.every((x) => x.ms >= 0)).toBe(true);
  });

  it("refuses an identical structured prompt (no repeat without new evidence)", () => {
    const b = new GenerationBudget();
    expect(b.recordPrompt('{"system":"s","user":"u"}')).toBe(true);
    expect(b.recordPrompt('{"system":"s","user":"u"}')).toBe(false);
    expect(b.recordPrompt('{"system":"s","user":"u2"}')).toBe(true);
    expect(b.recordPrompt("")).toBe(true); // distinct key (length)
    expect(b.summary().duplicatePromptsRefused).toBe(0); // counted by the caller
  });

  it("legacy repair policy: cap, per-scene claim, release after ERROR, storyboard headroom", () => {
    const b = new GenerationBudget({ maxLegacyRepairs: 1, legacyStoryboardHeadroomMs: 5_000 });
    expect(b.allowLegacyRepair("scene_01", "scene").ok).toBe(true);
    b.claimLegacyRepair("scene_01");
    // second attempt for the same scene is refused (one legacy attempt per scene)
    const second = b.allowLegacyRepair("scene_01", "scene");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/already received/);
    // cap counts COMPLETED + SKIPPED attempts (an in-flight claim is not yet a completed one)
    expect(b.allowLegacyRepair("scene_02", "scene").ok).toBe(true);
    b.recordLegacyRepair({ sceneId: "scene_01", mode: "scene", decision: "ERROR", ms: 1, reason: "llm" });
    const capped = b.allowLegacyRepair("scene_02", "scene");
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.reason).toMatch(/legacy repair budget exhausted/);
    b.releaseLegacyClaim("scene_01");
    expect(b.summary().legacyRepairs).toHaveLength(1);

    // storyboard mode needs render-compare headroom
    const hb = new GenerationBudget({ wallClockMs: 10_000, minCallMs: 1_000, legacyStoryboardHeadroomMs: 11_000 });
    const headroom = hb.allowLegacyRepair("scene_09", "storyboard");
    expect(headroom.ok).toBe(false);
    if (!headroom.ok) expect(headroom.reason).toMatch(/headroom/);
    expect(hb.allowLegacyRepair("scene_09", "scene").ok).toBe(true); // scene mode has no headroom requirement
  });

  it("begin/end expose the active budget and return a final summary", async () => {
    const b = beginGenerationBudget({ wallClockMs: 60_000 });
    expect(activeGenerationBudget()).toBe(b);
    await b.stage("analysis", async () => undefined);
    const summary = endGenerationBudget();
    expect(summary?.schema).toBe("generation-budget/1");
    expect(summary?.finishedAt).not.toBeNull();
    expect(summary?.stages.find((s) => s.stage === "analysis")?.status).toBe("done");
    expect(activeGenerationBudget()).toBeNull();
    expect(endGenerationBudget()).toBeNull();
  });

  it("isBudgetExhausted recognizes the structured error", () => {
    expect(isBudgetExhausted(new BudgetExhaustedError("llm", "deadline"))).toBe(true);
    expect(isBudgetExhausted(new Error("other"))).toBe(false);
  });
});

describe("llm layer honours the active budget (no network touched)", () => {
  it("chatRaw refuses an exhausted budget before any provider work", async () => {
    beginGenerationBudget({ wallClockMs: 1000, minCallMs: 60_000 });
    await expect(chatRaw([{ role: "user", content: "hi" }], { stage: "probe" })).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
    const summary = endGenerationBudget();
    expect(summary?.budgetRefusals).toBe(1);
    expect(summary?.llmCalls).toBe(0);
  });

  it("chatRaw refuses when the call cap is reached", async () => {
    beginGenerationBudget({ maxLlmCalls: 0 });
    await expect(chatRaw([{ role: "user", content: "hi" }], { stage: "probe" })).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
    endGenerationBudget();
  });

  it("completeJson refuses a byte-identical repeat prompt (structured generation calls)", async () => {
    const budget = beginGenerationBudget();
    const system = "You output JSON only.";
    const user = "Return {}";
    // pre-record the first prompt, as if this exact call already ran this generation
    budget!.recordPrompt(JSON.stringify([{ role: "system", content: system }, { role: "user", content: user }]));
    await expect(
      completeJson({ stage: "concepts", system, user, parse: (o) => o }),
    ).rejects.toThrow(/duplicate prompt refused/);
    const summary = endGenerationBudget();
    expect(summary?.duplicatePromptsRefused).toBe(1);
  });
});

describe("structured budget results reach artifacts/diagnostics", () => {
  it("BudgetExhaustedError carries machine-readable data", () => {
    const e = new BudgetExhaustedError("qa", "deadline reached");
    expect(isBudgetExhausted(e)).toBe(true);
    expect((e.data as { budgetExhausted?: boolean }).budgetExhausted).toBe(true);
    expect(e.explanation).toMatch(/budget exhausted/);
  });

  it("diagnostics embed the generation budget timeline when the artifact exists", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const { writeJsonAt } = await import("../src/core/projectStore");
    const { buildDiagnostics } = await import("../src/core/diagnostics");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-diag-"));
    const b = new GenerationBudget({ wallClockMs: 123_000 });
    b.recordLlmCall({ stage: "storyboards", startedAt: new Date().toISOString(), ms: 400, outcome: "ok" });
    b.recordLegacyRepair({ sceneId: "scene_01", mode: "storyboard", decision: "KEEP", ms: 5000, reason: "improved" });
    const summary = b.summary();
    writeJsonAt(dir, "qa/generation-budget.json", summary);
    const diag = buildDiagnostics(dir);
    expect(diag.generation).not.toBeNull();
    expect(diag.generation!.wallClockMs).toBe(123_000);
    expect(diag.generation!.llmCalls).toBe(1);
    expect(diag.generation!.legacyRepairs[0].decision).toBe("KEEP");
    expect(diag.generation!.stages.length).toBeGreaterThanOrEqual(0);
  });
});
