import { createSnapshotUnique, restoreSnapshot, currentSceneFingerprint } from "../core/snapshot";
import { writeJsonAt, readJsonAt } from "../core/projectStore";
import { fingerprintFile, sha256 } from "../core/identity";
import { ALLOWED_PROPERTIES, validateRepairProposal } from "../validation/repairContract";
import { evaluatePreRenderGate, type PreRenderGateReport } from "../validation/preRenderGate";
import { collisionSemantics } from "../validation/collisionSemantics";
import { evaluateSemanticEnactment, type SemanticEnactmentReport } from "../validation/semanticEnactment";
import {
  buildRepairContext,
  classifyFailures,
  primaryFailurePerScene,
  type RepairFailure,
} from "./repairContext";
import {
  buildMetricVector,
  compareRepair,
  describeComparison,
  withTargetSeverity,
  type MetricSources,
  type RepairComparison,
} from "./repairCompare";
import { buildRepairPrompt, type RepairProvider } from "./repairProviders";
import { resolveRecordPath, readRenderRecord } from "../core/artifacts";
import type { GenerationBudget } from "../core/generationBudget";
import type { SceneSpec } from "../validation/schema";

/**
 * Evidence-driven targeted repair loop (Batch C / §11-§14).
 *
 *   BASELINE (snapshot) -> propose (narrow) -> validate contract -> apply -> measure
 *        -> compare metric vectors -> KEEP | ROLLBACK (restore snapshot)
 *
 * Rules enforced here:
 *   - strict budget: max 2 attempts per scene, 6 model calls total, 120s per call;
 *   - no duplicate prompt and no retry without new evidence;
 *   - deterministic validation runs between every attempt;
 *   - a candidate that introduces a worse hard failure is never kept;
 *   - provider failures (timeout/stall/malformed) never corrupt the baseline;
 *   - every attempt writes a ledger row that explains the decision without reading source code.
 *
 * Nothing here renders: the caller decides whether to measure with pixels (`measure`) or with
 * the pre-render model only.
 */

export interface RepairBudget {
  maxAttemptsPerScene: number;
  maxRounds: number;
  maxCallsTotal: number;
  callTimeoutMs: number;
}

/** Batch C §13 exact limits. */
export const REPAIR_BUDGET: RepairBudget = {
  maxAttemptsPerScene: 2,
  maxRounds: 3,
  maxCallsTotal: 6,
  callTimeoutMs: 120_000,
};

export class RepairBudgetTracker {
  calls = 0;
  private attempts = new Map<string, number>();

  constructor(readonly budget: RepairBudget) {}

  canAttempt(sceneId: string): boolean {
    if (this.calls >= this.budget.maxCallsTotal) return false;
    if ((this.attempts.get(sceneId) ?? 0) >= this.budget.maxAttemptsPerScene) return false;
    return true;
  }

  record(sceneId: string): void {
    this.calls += 1;
    this.attempts.set(sceneId, (this.attempts.get(sceneId) ?? 0) + 1);
  }

  attemptsFor(sceneId: string): number {
    return this.attempts.get(sceneId) ?? 0;
  }

  remaining(): number {
    return Math.max(0, this.budget.maxCallsTotal - this.calls);
  }
}

export const REPAIR_LEDGER_PATH = "qa/repair-ledger.json";

export interface RepairLedgerRow {
  schema: "repair-ledger/1";
  round: number;
  attempt: number;
  sceneId: string;
  failureType: string;
  severity: string;
  source: string;
  target: string[];
  baselineHash: string | null;
  baselineSnapshotId: string | null;
  candidateHash: string | null;
  evidenceBefore: string;
  evidenceAfter: string;
  proposal: unknown;
  validation: string[];
  measurement: "measured" | "model-only";
  render: "candidate-rendered" | "not-rendered";
  decision: "KEEP" | "ROLLBACK" | "REJECT" | "TIMEOUT" | "ERROR" | "SKIPPED";
  reason: string;
  comparison: string | null;
  promptHash: string | null;
  elapsedMs: number;
  budgetRemaining: number;
}

export function readRepairLedger(dir: string): RepairLedgerRow[] {
  return readJsonAt<RepairLedgerRow[]>(dir, REPAIR_LEDGER_PATH) ?? [];
}

export function appendRepairLedger(dir: string, rows: RepairLedgerRow[]): RepairLedgerRow[] {
  const all = [...readRepairLedger(dir), ...rows];
  writeJsonAt(dir, REPAIR_LEDGER_PATH, all);
  return all;
}

export interface TargetedRepairOptions {
  dir: string;
  scenes: SceneSpec[];
  round: number;
  failures: RepairFailure[];
  provider: RepairProvider;
  budget?: Partial<RepairBudget>;
  /** shared tracker so the WHOLE generation shares one call budget (Batch C §13) */
  tracker?: RepairBudgetTracker;
  /**
   * Batch G (WS-E): the generation wall-clock budget. When present, a repair is
   * SKIPPED (with an explicit reason) if the remaining deadline cannot cover a
   * verifiable repair cycle (proposal + validation + rerender/compare headroom) -
   * the Batch F pattern of spending the last minutes on unverifiable proposals ends here.
   */
  generationBudget?: GenerationBudget;
  /** evidence from BEFORE the experiment (rendered when available) */
  baseline: MetricSources;
  /** optional measured step for the candidate - pass render+evidence to compare pixels */
  measure?: (scenes: SceneSpec[]) => Promise<MetricSources>;
  maxScenes?: number;
}

export interface TargetedRepairResult {
  scenes: SceneSpec[];
  ledger: RepairLedgerRow[];
  kept: string[];
  rolledBack: string[];
  rejected: string[];
  budgetUsed: number;
  budgetRemaining: number;
  comparisons: Record<string, RepairComparison>;
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`repair provider timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Model-only measurement (fast, no render): pre-render gate + collision + semantic enactment. */
async function modelSources(scenes: SceneSpec[]): Promise<MetricSources> {
  const gate = await evaluatePreRenderGate(scenes);
  const collisions: Record<string, ReturnType<typeof collisionSemantics>> = {};
  for (const s of scenes) collisions[s.sceneId] = collisionSemantics(s);
  return {
    scenes,
    preRenderHard: gate.hard.map((i) => ({ sceneId: i.sceneId, failureType: i.failureType, magnitude: i.magnitude })),
    collisions,
    // Batch D: deterministic state evidence - no render, no LLM
    semantic: evaluateSemanticEnactment(scenes),
    artifactConsistent: true,
  };
}

function severityFor(sources: MetricSources, sceneId: string, type: string): number | null {
  const pre = (sources.preRenderHard ?? []).filter((h) => h.sceneId === sceneId && h.failureType === type);
  if (pre.length) {
    // worst (max) magnitude: a partially-fixed failure must not look "better" just because a
    // smaller violation is listed first
    return pre.reduce((m, h) => Math.max(m, typeof h.magnitude === "number" ? h.magnitude : 0), 0);
  }
  const failures = classifyFailures({
    scenes: sources.scenes ?? [],
    layoutGate: sources.layoutGate ?? null,
    visualGates: sources.visualGates ?? null,
    collisions: sources.collisions ?? null,
    semantic: sources.semantic ?? null,
  }).filter((f) => f.sceneId === sceneId && f.type === type && typeof f.magnitude === "number");
  if (failures.length) return failures.reduce((m, f) => Math.max(m, f.magnitude as number), 0);
  // no matching failure means the target no longer exists -> treated as fixed (0)
  return null;
}

function evidenceAfter(sources: MetricSources, sceneId: string, type: string): string {
  const failures = classifyFailures({
    scenes: sources.scenes ?? [],
    layoutGate: sources.layoutGate ?? null,
    visualGates: sources.visualGates ?? null,
    collisions: sources.collisions ?? null,
    semantic: sources.semantic ?? null,
  });
  const hit = failures.find((f) => f.sceneId === sceneId && f.type === type);
  if (hit) return hit.evidence;
  const pre = (sources.preRenderHard ?? []).find((h) => h.sceneId === sceneId && h.failureType === type);
  if (pre) return "pre-render hard failure still present";
  return "target failure cleared";
}

/**
 * Attempt targeted repairs for the classified failures. Returns the (possibly rolled back)
 * scenes plus one ledger row per attempt.
 */
export async function runTargetedRepair(opts: TargetedRepairOptions): Promise<TargetedRepairResult> {
  const budget: RepairBudget = { ...REPAIR_BUDGET, ...(opts.budget ?? {}) };
  const tracker = opts.tracker ?? new RepairBudgetTracker(budget);
  const ledger: RepairLedgerRow[] = [];
  const kept: string[] = [];
  const rolledBack: string[] = [];
  const rejected: string[] = [];
  const comparisons: Record<string, RepairComparison> = {};

  let scenes = opts.scenes;
  const byScene = primaryFailurePerScene(opts.failures);
  const targets = [...byScene.entries()].slice(0, opts.maxScenes ?? 3);
  // Seed from the persisted ledger: an identical prompt must never be sent twice, across
  // rounds AND across runs (Batch C §13).
  const seenPrompts = new Set(
    readRepairLedger(opts.dir)
      .map((r) => r.promptHash)
      .filter((h): h is string => Boolean(h)),
  );

  const baselineVectorBase = buildMetricVector(opts.baseline);

  for (const [sceneId, failure] of targets) {
    const baselineScene = scenes.find((s) => s.sceneId === sceneId);
    if (!baselineScene) continue;

    // Batch G (WS-E): do not start a repair the deadline cannot finish. A verifiable
    // cycle needs one proposal call plus validation plus (when measured) a rerender;
    // starting anyway is what burned Batch F's last minutes on unverifiable proposals.
    if (opts.generationBudget && opts.generationBudget.exhausted()) {
      appendRepairLedger(opts.dir, [
        row(opts.round, 0, failure, null, "n/a", {
          decision: "SKIPPED",
          reason: `generation deadline reached - skipping repair for ${sceneId}/${failure.type} (a repair started now could not be verified before the budget expires)`,
          proposal: null,
          validation: [],
          candidateHash: null,
          evidenceAfter: failure.evidence,
          elapsedMs: 0,
          budgetRemaining: Math.round(opts.generationBudget.remainingMs() / 1000),
          measurement: opts.measure ? "measured" : "model-only",
        }),
      ]);
      continue;
    }

    const baselineHash = currentSceneFingerprint(opts.dir).sceneHashes[sceneId] ?? null;
    const snapshot = createSnapshotUnique(opts.dir, `r${opts.round}-${sceneId}`, {
      scenes,
      render: renderIdentityFor(opts.dir),
      qa: qaIdentityFor(opts.dir),
    });
    const baselineVector = withTargetSeverity(baselineVectorBase, failure);

    let attempt = 0;
    let finished = false;
    /** "decision" = a verdict exists (stops the scene); "provider-failure" = a retry is allowed */
    let lastOutcome: "decision" | "provider-failure" | null = null;

    while (!finished && attempt < budget.maxAttemptsPerScene && tracker.canAttempt(sceneId)) {
      attempt += 1;
      const ctx = buildRepairContext({
        round: opts.round,
        attempt,
        maxAttempts: budget.maxAttemptsPerScene,
        failure,
        allowedProperties: ALLOWED_PROPERTIES[failure.type] ?? ALLOWED_PROPERTIES.unknown,
        baselineArtifactHash: baselineHash,
        baselineSnapshotId: snapshot.label,
      });
      const prompt = buildRepairPrompt(ctx, baselineScene);
      const promptKey = sha256(prompt);

      if (seenPrompts.has(promptKey)) {
        ledger.push(row(opts.round, attempt, failure, baselineHash, snapshot.label, {
          decision: "REJECT",
          reason: "duplicate repair prompt - refused (budget rule: no second identical prompt)",
          proposal: null,
          validation: [],
          candidateHash: null,
          evidenceAfter: failure.evidence,
          elapsedMs: 0,
          budgetRemaining: tracker.remaining(),
          measurement: opts.measure ? "measured" : "model-only",
          promptHash: promptKey,
        }));
        finished = true;
        break;
      }
      if (lastOutcome === "decision" && attempt > 1) {
        ledger.push(row(opts.round, attempt, failure, baselineHash, snapshot.label, {
          decision: "REJECT",
          reason: "no new evidence since the previous attempt - refused",
          proposal: null,
          validation: [],
          candidateHash: null,
          evidenceAfter: failure.evidence,
          elapsedMs: 0,
          budgetRemaining: tracker.remaining(),
          measurement: opts.measure ? "measured" : "model-only",
          promptHash: promptKey,
        }));
        finished = true;
        break;
      }
      seenPrompts.add(promptKey);

      tracker.record(sceneId);
      const t0 = Date.now();

      let proposal;
      try {
        proposal = await withTimeout(() => opts.provider.propose({ context: ctx, prompt }), budget.callTimeoutMs);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const timedOut = /timed out/i.test(msg);
        lastOutcome = "provider-failure";
        ledger.push(row(opts.round, attempt, failure, baselineHash, snapshot.label, {
          decision: timedOut ? "TIMEOUT" : "ERROR",
          reason: msg.slice(0, 400),
          proposal: null,
          validation: [],
          candidateHash: null,
          evidenceAfter: failure.evidence,
          elapsedMs: Date.now() - t0,
          budgetRemaining: tracker.remaining(),
          measurement: opts.measure ? "measured" : "model-only",
          promptHash: promptKey,
        }));
        // never corrupt the baseline; continue only if budget remains
        continue;
      }

      const validation = validateRepairProposal(baselineScene, proposal, failure.type, {
        implicated: failure.target,
      });
      if (!validation.ok || !validation.scene) {
        lastOutcome = "decision";
        ledger.push(row(opts.round, attempt, failure, baselineHash, snapshot.label, {
          decision: "REJECT",
          reason: `contract violation: ${validation.errors.join("; ")}`,
          proposal,
          validation: validation.errors,
          candidateHash: null,
          evidenceAfter: failure.evidence,
          elapsedMs: Date.now() - t0,
          budgetRemaining: tracker.remaining(),
          measurement: opts.measure ? "measured" : "model-only",
          promptHash: promptKey,
        }));
        finished = true;
        break;
      }

      const candidate = validation.scene;
      // write the candidate so any subsequent render measures the experiment
      writeJsonAt(opts.dir, `scenes/${sceneId}.json`, candidate);
      const candidateHash = sceneHashOf(opts.dir, sceneId);
      const nextScenes = scenes.map((s) => (s.sceneId === sceneId ? candidate : s));

      const candidateSources = opts.measure
        ? await opts.measure(nextScenes)
        : await modelSources(nextScenes);
      const severity = severityFor(candidateSources, sceneId, failure.type);
      const candidateVector = withTargetSeverity(
        buildMetricVector(candidateSources),
        severity === null ? null : { ...failure, magnitude: severity },
      );
      const comparison = compareRepair(baselineVector, candidateVector, { targetKey: `${sceneId}:${failure.type}` });
      comparisons[sceneId] = comparison;

      const after = evidenceAfter(candidateSources, sceneId, failure.type);
      const elapsed = Date.now() - t0;
      lastOutcome = "decision";

      if (comparison.action === "KEEP") {
        ledger.push(row(opts.round, attempt, failure, baselineHash, snapshot.label, {
          decision: "KEEP",
          reason: comparison.reason,
          proposal,
          validation: [],
          candidateHash,
          evidenceAfter: after,
          elapsedMs: elapsed,
          budgetRemaining: tracker.remaining(),
          measurement: opts.measure ? "measured" : "model-only",
          render: typeof candidateSources.frameEdgeInk === "number" ? "candidate-rendered" : "not-rendered",
          comparison: describeComparison(comparison),
          promptHash: promptKey,
        }));
        scenes = nextScenes;
        kept.push(sceneId);
        finished = true;
        break;
      }

      // ROLLBACK / REJECT -> restore the exact baseline project state, then stop for this scene
      // (a retry on unchanged evidence is forbidden by the budget rules)
      restoreSnapshot(opts.dir, snapshot.label);
      scenes = scenes.map((s) => (s.sceneId === sceneId ? baselineScene : s));
      ledger.push(row(opts.round, attempt, failure, baselineHash, snapshot.label, {
        decision: comparison.action,
        reason: comparison.reason,
        proposal,
        validation: [],
        candidateHash,
        evidenceAfter: after,
        elapsedMs: elapsed,
        budgetRemaining: tracker.remaining(),
        measurement: opts.measure ? "measured" : "model-only",
        render: opts.measure ? "candidate-rendered" : "not-rendered",
        comparison: describeComparison(comparison),
        promptHash: promptKey,
      }));
      if (comparison.action === "ROLLBACK") rolledBack.push(sceneId);
      else rejected.push(sceneId);
      finished = true;
    }

    if (!finished) {
      // budget exhausted (attempts or project-wide calls): guarantee the baseline on disk
      restoreSnapshot(opts.dir, snapshot.label);
      scenes = scenes.map((s) => (s.sceneId === sceneId ? baselineScene : s));
      ledger.push(row(opts.round, attempt, failure, baselineHash, snapshot.label, {
        decision: "SKIPPED",
        reason: `repair budget exhausted for this scene (attempts=${attempt}/${budget.maxAttemptsPerScene}, calls used=${tracker.calls}/${budget.maxCallsTotal})`,
        proposal: null,
        validation: [],
        candidateHash: null,
        evidenceAfter: failure.evidence,
        elapsedMs: 0,
        budgetRemaining: tracker.remaining(),
        measurement: opts.measure ? "measured" : "model-only",
      }));
      if (!rejected.includes(sceneId) && !rolledBack.includes(sceneId)) rejected.push(sceneId);
    }
  }

  appendRepairLedger(opts.dir, ledger);
  return {
    scenes,
    ledger,
    kept,
    rolledBack,
    rejected,
    budgetUsed: tracker.calls,
    budgetRemaining: tracker.remaining(),
    comparisons,
  };
}

interface RowInput {
  decision: RepairLedgerRow["decision"];
  reason: string;
  proposal: unknown;
  validation: string[];
  candidateHash: string | null;
  evidenceAfter: string;
  elapsedMs: number;
  budgetRemaining: number;
  measurement: "measured" | "model-only";
  render?: RepairLedgerRow["render"];
  comparison?: string;
  promptHash?: string;
}

function row(round: number, attempt: number, failure: RepairFailure, baselineHash: string | null, snapshotId: string, input: RowInput): RepairLedgerRow {
  return {
    schema: "repair-ledger/1",
    round,
    attempt,
    sceneId: failure.sceneId,
    failureType: failure.type,
    severity: failure.severity,
    source: failure.source,
    target: failure.target ?? [],
    baselineHash,
    baselineSnapshotId: snapshotId,
    candidateHash: input.candidateHash,
    evidenceBefore: failure.evidence,
    evidenceAfter: input.evidenceAfter,
    proposal: input.proposal,
    validation: input.validation,
    measurement: input.measurement,
    render: input.render ?? "not-rendered",
    decision: input.decision,
    reason: input.reason,
    comparison: input.comparison ?? null,
    promptHash: input.promptHash ?? null,
    elapsedMs: input.elapsedMs,
    budgetRemaining: input.budgetRemaining,
  };
}

function sceneHashOf(dir: string, sceneId: string): string | null {
  const file = `${dir}/scenes/${sceneId}.json`;
  const fp = fingerprintFile(file);
  return fp ? fp.sha256 : null;
}

function renderIdentityFor(dir: string): { file: string; sha256: string } | null {
  const r = readRenderRecord(dir);
  return r ? { file: r.file, sha256: r.sha256 } : null;
}

function qaIdentityFor(dir: string): { qaSha256: string; status: string; renderSha256: string | null } | null {
  const q = readJsonAt<{ qaSha256?: string; status?: string; renderSha256?: string }>(dir, "qa/record.json");
  if (!q?.qaSha256) return null;
  return { qaSha256: q.qaSha256, status: q.status ?? "unknown", renderSha256: q.renderSha256 ?? null };
}

/** Convenience: classify + repair in one call for callers that only have reports. */
export async function repairFromReports(opts: {
  dir: string;
  scenes: SceneSpec[];
  round: number;
  reports: {
    layoutGate?: Parameters<typeof classifyFailures>[0]["layoutGate"];
    visualGates?: Parameters<typeof classifyFailures>[0]["visualGates"];
    collisions?: Parameters<typeof classifyFailures>[0]["collisions"];
    preRenderGate?: PreRenderGateReport | null;
    semantic?: SemanticEnactmentReport | null;
    judgeIssues?: Parameters<typeof classifyFailures>[0]["judgeIssues"];
    slopFindings?: Parameters<typeof classifyFailures>[0]["slopFindings"];
    timingIssues?: Parameters<typeof classifyFailures>[0]["timingIssues"];
  };
  baseline: MetricSources;
  provider: RepairProvider;
  measure?: (scenes: SceneSpec[]) => Promise<MetricSources>;
  maxScenes?: number;
}): Promise<TargetedRepairResult> {
  const failures = classifyFailures({
    scenes: opts.scenes,
    layoutGate: opts.reports.layoutGate ?? null,
    visualGates: opts.reports.visualGates ?? null,
    collisions: opts.reports.collisions ?? null,
    semantic: opts.reports.semantic ?? null,
    judgeIssues: opts.reports.judgeIssues ?? null,
    slopFindings: opts.reports.slopFindings ?? null,
    timingIssues: opts.reports.timingIssues ?? null,
  });
  if (failures.length === 0) {
    return {
      scenes: opts.scenes,
      ledger: [],
      kept: [],
      rolledBack: [],
      rejected: [],
      budgetUsed: 0,
      budgetRemaining: REPAIR_BUDGET.maxCallsTotal,
      comparisons: {},
    };
  }
  return runTargetedRepair({
    dir: opts.dir,
    scenes: opts.scenes,
    round: opts.round,
    failures,
    provider: opts.provider,
    baseline: opts.baseline,
    measure: opts.measure,
    maxScenes: opts.maxScenes,
  });
}
