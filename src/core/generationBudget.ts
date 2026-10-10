import { StudioError, type ErrorStage } from "./errors";

/**
 * GENERATION-LEVEL BUDGET (Batch E / Phase 1).
 *
 * One wall-clock budget for a whole `generateProject()` run. Every LLM call, every repair
 * attempt (targeted AND legacy), every render round and every QA rerun draws from it, so a
 * generation can never run indefinitely:
 *
 *   - each LLM call checks the deadline BEFORE it starts (and re-checks between retries),
 *   - transient retries are capped (no more 12 x 85s per logical call),
 *   - identical prompts are refused within one generation (no repeats without new evidence),
 *   - legacy repairs have their own documented cap and share the same deadline,
 *   - exhaustion produces a STRUCTURED result (BudgetExhaustedError -> failed/partial run
 *     with diagnostics) - never a silent skip that could masquerade as PASS.
 *
 * The budget is generation-scoped: `beginGenerationBudget()` at pipeline start,
 * `endGenerationBudget()` when the run finishes. Outside a generation (unit tests, probes)
 * no budget is active and the bounded per-call retry policy still applies.
 */

export interface GenerationBudgetConfig {
  /** strict wall-clock limit for the whole generation (ms) */
  wallClockMs: number;
  /** hard cap on logical LLM calls per generation */
  maxLlmCalls: number;
  /** transient retries per call (attempt-level abort stays 85s) */
  maxRetriesPerCall: number;
  /** legacy (storyboard/scene) repair attempts per generation */
  maxLegacyRepairs: number;
  /** a call is refused when less than this much deadline remains (ms) */
  minCallMs: number;
  /** wall-clock headroom a storyboard rewrite must have left (it needs render+compare) */
  legacyStoryboardHeadroomMs: number;
  /**
   * Batch G (WS-E): wall-clock headroom a TARGETED repair must have left before it may
   * start. A repair cycle costs one proposal call (~20-70s observed) + deterministic
   * validation + (when measured) a rerender+compare. Starting a repair with less than
   * this much time produced the Batch F pattern: proposals consumed the last minutes and
   * the budget expired before any candidate could be verified or rolled back.
   */
  minRepairHeadroomMs: number;
}

export const DEFAULT_GENERATION_BUDGET: GenerationBudgetConfig = {
  wallClockMs: 25 * 60_000,
  maxLlmCalls: 80,
  maxRetriesPerCall: 4,
  maxLegacyRepairs: 4,
  minCallMs: 5_000,
  legacyStoryboardHeadroomMs: 150_000,
  minRepairHeadroomMs: 90_000,
};

export type LlmCallOutcome = "ok" | "error" | "timeout" | "budget_refused" | "duplicate_refused";

export interface LlmCallRecord {
  stage: string;
  startedAt: string;
  ms: number;
  outcome: LlmCallOutcome;
  detail?: string;
}

export interface StageRecordTiming {
  stage: string;
  startedAt: string;
  ms: number;
  status: "done" | "failed" | "budget_exhausted";
}

export interface LegacyRepairRecord {
  sceneId: string;
  mode: "storyboard" | "scene";
  decision: "KEEP" | "ROLLBACK" | "SKIPPED_BUDGET" | "ERROR";
  ms: number;
  reason: string;
}

export interface BudgetSummary {
  schema: "generation-budget/1";
  config: GenerationBudgetConfig;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  exhausted: boolean;
  llmCalls: number;
  llmMs: number;
  timeouts: number;
  budgetRefusals: number;
  duplicatePromptsRefused: number;
  legacyRepairs: LegacyRepairRecord[];
  legacyRepairsSkipped: number;
  stages: StageRecordTiming[];
  renders: { label: string; ms: number }[];
}

/** Structured budget failure - callers branch on this instead of parsing messages. */
export class BudgetExhaustedError extends StudioError {
  readonly budgetExhausted = true;
  constructor(stage: ErrorStage, detail: string) {
    super({
      stage,
      recoverable: false,
      explanation: `generation budget exhausted: ${detail}`,
      data: { budgetExhausted: true, detail },
    });
    this.name = "BudgetExhaustedError";
  }
}

export const isBudgetExhausted = (e: unknown): boolean =>
  e instanceof BudgetExhaustedError ||
  (e instanceof StudioError && e.data !== null && typeof e.data === "object" && (e.data as { budgetExhausted?: boolean }).budgetExhausted === true);

export class GenerationBudget {
  readonly config: GenerationBudgetConfig;
  readonly startedAtMs: number;
  readonly startedAt: string;
  private finishedAtMs: number | null = null;

  llmCalls = 0;
  llmMs = 0;
  timeouts = 0;
  budgetRefusals = 0;
  duplicatePromptsRefused = 0;
  legacyRepairsSkipped = 0;

  private readonly calls: LlmCallRecord[] = [];
  private readonly stageTimings: StageRecordTiming[] = [];
  private readonly legacy: LegacyRepairRecord[] = [];
  private readonly renders: { label: string; ms: number }[] = [];
  private readonly promptHashes = new Set<string>();
  private readonly legacyScenes = new Set<string>();

  constructor(over: Partial<GenerationBudgetConfig> = {}) {
    this.config = { ...DEFAULT_GENERATION_BUDGET, ...over };
    this.startedAtMs = Date.now();
    this.startedAt = new Date().toISOString();
  }

  elapsedMs(): number {
    return (this.finishedAtMs ?? Date.now()) - this.startedAtMs;
  }

  remainingMs(): number {
    return Math.max(0, this.config.wallClockMs - this.elapsedMs());
  }

  exhausted(): boolean {
    return this.remainingMs() < this.config.minCallMs;
  }

  finish(): void {
    this.finishedAtMs = Date.now();
  }

  /* --------------------------------- LLM calls -------------------------------- */

  /** Deadline + call-count gate. Returns false when the call must not start. */
  allowLlmCall(): boolean {
    if (this.llmCalls >= this.config.maxLlmCalls) return false;
    if (this.remainingMs() < this.config.minCallMs) return false;
    return true;
  }

  recordLlmCall(rec: LlmCallRecord): void {
    if (rec.outcome !== "budget_refused") this.llmCalls += 1;
    this.llmMs += rec.ms;
    if (rec.outcome === "timeout") this.timeouts += 1;
    if (rec.outcome === "budget_refused") this.budgetRefusals += 1;
    this.calls.push(rec);
  }

  /**
   * Refuse an identical prompt inside one generation (no repeats without new evidence).
   * Returns false when this exact payload was already sent.
   */
  recordPrompt(payload: string): boolean {
    let h = 5381;
    for (let i = 0; i < payload.length; i++) h = ((Math.imul(31, h) + payload.charCodeAt(i)) | 0) >>> 0;
    const key = `d${h}:${payload.length}`;
    if (this.promptHashes.has(key)) return false;
    this.promptHashes.add(key);
    return true;
  }

  /* ---------------------------------- stages ---------------------------------- */

  /**
   * Gate + time one pipeline stage. Throws BudgetExhaustedError BEFORE the stage starts
   * when the deadline/call budget is gone - the caller maps it to a structured failed run.
   */
  async stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (this.exhausted()) {
      this.stageTimings.push({ stage: name, startedAt: new Date().toISOString(), ms: 0, status: "budget_exhausted" });
      throw new BudgetExhaustedError("internal", `stage "${name}" never started (deadline reached)`);
    }
    const t0 = Date.now();
    try {
      const out = await fn();
      this.stageTimings.push({ stage: name, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, status: "done" });
      return out;
    } catch (e) {
      const status: StageRecordTiming["status"] = isBudgetExhausted(e) ? "budget_exhausted" : "failed";
      this.stageTimings.push({ stage: name, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, status });
      throw e;
    }
  }

  /** Non-gating timing mark (local work worth reporting: renders, evidence, QA). */
  mark<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    return fn().finally(() => {
      this.stageTimings.push({ stage: name, startedAt: new Date(t0).toISOString(), ms: Date.now() - t0, status: "done" });
    });
  }

  recordRender(label: string, ms: number): void {
    this.renders.push({ label, ms });
  }

  /* ------------------------------ legacy repairs ------------------------------ */

  /**
   * Legacy (whole-storyboard / whole-scene) repair policy: per-generation cap, one attempt
   * per scene, shared deadline - plus the extra headroom a storyboard rewrite needs because
   * it must render+compare against the baseline before it can be KEPT.
   */
  allowLegacyRepair(sceneId: string, mode: "storyboard" | "scene"): { ok: true } | { ok: false; reason: string } {
    if (this.legacy.length + this.legacyRepairsSkipped >= this.config.maxLegacyRepairs) {
      return { ok: false, reason: `legacy repair budget exhausted (${this.legacy.length}/${this.config.maxLegacyRepairs} used)` };
    }
    if (this.legacyScenes.has(sceneId)) {
      return { ok: false, reason: `scene ${sceneId} already received its legacy repair this generation` };
    }
    if (this.exhausted()) {
      return { ok: false, reason: "generation deadline reached" };
    }
    if (mode === "storyboard" && this.remainingMs() < this.config.legacyStoryboardHeadroomMs) {
      return {
        ok: false,
        reason: `insufficient wall-clock headroom for a storyboard rewrite + render-compare (${Math.round(this.remainingMs() / 1000)}s left, need ${Math.round(this.config.legacyStoryboardHeadroomMs / 1000)}s)`,
      };
    }
    return { ok: true };
  }

  /** Reserve a scene for legacy repair (called once the attempt actually starts). */
  claimLegacyRepair(sceneId: string): void {
    this.legacyScenes.add(sceneId);
  }

  /**
   * Release a claim after an attempt that produced NO candidate (LLM/infra error), so a
   * narrower fallback attempt for the same scene is still policy-allowed.
   */
  releaseLegacyClaim(sceneId: string): void {
    this.legacyScenes.delete(sceneId);
  }

  recordLegacyRepair(rec: LegacyRepairRecord): void {
    this.legacy.push(rec);
  }

  recordLegacySkip(): void {
    this.legacyRepairsSkipped += 1;
  }

  /* -------------------------------- reporting --------------------------------- */

  summary(): BudgetSummary {
    return {
      schema: "generation-budget/1",
      config: { ...this.config },
      startedAt: this.startedAt,
      finishedAt: this.finishedAtMs ? new Date(this.finishedAtMs).toISOString() : null,
      elapsedMs: this.elapsedMs(),
      exhausted: this.exhausted(),
      llmCalls: this.llmCalls,
      llmMs: this.llmMs,
      timeouts: this.timeouts,
      budgetRefusals: this.budgetRefusals,
      duplicatePromptsRefused: this.duplicatePromptsRefused,
      legacyRepairs: [...this.legacy],
      legacyRepairsSkipped: this.legacyRepairsSkipped,
      stages: [...this.stageTimings],
      renders: [...this.renders],
    };
  }

  /** Compact one-liner for progress logs. */
  line(): string {
    const s = this.summary();
    return `elapsed=${Math.round(s.elapsedMs / 1000)}s/${Math.round(s.config.wallClockMs / 1000)}s llm=${s.llmCalls}(${Math.round(s.llmMs / 1000)}s, to=${s.timeouts}) legacy=${s.legacyRepairs.length}+${s.legacyRepairsSkipped}skipped`;
  }
}

let activeBudget: GenerationBudget | null = null;

export function beginGenerationBudget(over: Partial<GenerationBudgetConfig> = {}): GenerationBudget {
  activeBudget = new GenerationBudget(over);
  return activeBudget;
}

/** Finish the active budget and return its final summary (null when none was active). */
export function endGenerationBudget(): BudgetSummary | null {
  const done = activeBudget;
  activeBudget = null;
  if (!done) return null;
  done.finish();
  return done.summary();
}

export function activeGenerationBudget(): GenerationBudget | null {
  return activeBudget;
}
