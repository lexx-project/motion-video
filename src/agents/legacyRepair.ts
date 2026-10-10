import fs from "fs";
import path from "path";
import { createSnapshotUnique, restoreSnapshot, currentSceneFingerprint } from "../core/snapshot";
import { appendRepairLedger, type RepairLedgerRow } from "./repairLoop";
import { evaluatePreRenderGate } from "../validation/preRenderGate";
import { collisionSemantics } from "../validation/collisionSemantics";
import { evaluateSemanticEnactment } from "../validation/semanticEnactment";
import { promisedEventSchedule } from "../validation/executionPlan";
import { buildMetricVector, compareRepair, describeComparison, type MetricSources } from "./repairCompare";
import { validateScene } from "../validation/validate";
import { reconcileSemanticContract } from "../validation/semanticContract";
import { renderProject } from "../render/renderProject";
import { collectFrameEvidence } from "./qa";
import { evaluateProjectLayoutGate } from "../validation/layoutGate";
import { evaluateVisualGates } from "../validation/visualGates";
import { readRenderRecord } from "../core/artifacts";
import { readJsonAt, writeJsonAt } from "../core/projectStore";
import type { GenerationBudget } from "../core/generationBudget";
import type { SceneSpec } from "../validation/schema";
import type { Storyboard } from "../validation/storyboardSchema";

/**
 * BOUNDED LEGACY REPAIR (Batch E / Phase 2).
 *
 * The legacy judge-driven paths (`regenerateStoryboard` + scene recompilation, and
 * `repairScene`) previously ran outside the Batch C/D contract: no snapshot, no gate, no
 * KEEP/ROLLBACK, unbounded by wall clock. This wrapper puts BOTH under the same
 * generation-level budget and an explicit repair policy:
 *
 *   budget check (cap + per-scene + wall-clock headroom)
 *     -> snapshot baseline
 *     -> run the legacy repair (LLM, budget-gated at the llm layer)
 *     -> schema + semantic-gate validation
 *        + MANDATORY PROMISE PRESERVATION (storyboard mode: every baseline semantic object
 *          id and promised event id/type must survive - a rewrite can never drop requirements)
 *     -> measure (storyboard mode: single-scene render + pixel gates vs the baseline metrics;
 *        scene mode: model-only pre-render/collision/semantic metrics)
 *     -> compareRepair -> KEEP | ROLLBACK (snapshot restore, byte-for-byte)
 *     -> ledger row + budget record
 *
 * Budget exhaustion produces SKIPPED_BUDGET without touching state - the QA verdict stays
 * exactly as honest as it was (never upgraded by skipping work).
 */

export type LegacyRepairDecision = "KEEP" | "ROLLBACK" | "SKIPPED_BUDGET" | "ERROR";

export interface LegacyRepairRequest {
  projectId: string;
  dir: string;
  scenes: SceneSpec[];
  sceneId: string;
  budget: GenerationBudget;
  round: number;
  mode: "storyboard" | "scene";
  /** the actual legacy LLM repair - returns the candidate scene or throws */
  repair: () => Promise<SceneSpec>;
  /** baseline metric vector source (pipeline's current gates/evidence) */
  baselineMetrics: MetricSources;
  /** audio path for the candidate render (storyboard mode) */
  audioPath?: string;
  /** short human reason from the repair plan (ledger evidence) */
  reason?: string;
}

export interface LegacyRepairOutcome {
  sceneId: string;
  mode: "storyboard" | "scene";
  decision: LegacyRepairDecision;
  reason: string;
  elapsedMs: number;
  /** scenes to use after the attempt (unchanged unless KEEP) */
  scenes: SceneSpec[];
  candidate?: SceneSpec;
  comparison?: string;
}

/* --------------------------- storyboard file rollback -------------------------- */

interface FileBackup {
  rel: string;
  content: string | null;
}

function backupStoryboardFiles(dir: string): FileBackup[] {
  const rels = ["concepts/storyboard.json"];
  const sbDir = path.join(dir, "scenes");
  if (fs.existsSync(sbDir)) {
    for (const f of fs.readdirSync(sbDir)) {
      if (/^storyboard-.*\.json$/.test(f)) rels.push(`scenes/${f}`);
    }
  }
  return rels.map((rel) => {
    const abs = path.join(dir, rel);
    return { rel, content: fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null };
  });
}

function restoreStoryboardFiles(dir: string, backup: FileBackup[]): void {
  for (const b of backup) {
    const abs = path.join(dir, b.rel);
    if (b.content === null) {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, b.content, "utf8");
    }
  }
}

/* ------------------------- mandatory promise preservation ---------------------- */

/** Baseline promises that a whole-storyboard rewrite MUST keep (ids + event types). */
export function storyboardPromises(sb: Storyboard | undefined): { objects: string[]; events: string[] } {
  if (!sb) return { objects: [], events: [] };
  const objects = sb.semanticObjects.map((o) => o.id).filter((id): id is string => Boolean(id)).sort();
  const events = (sb ? promisedEventSchedule({ storyboard: sb, duration: 60 } as SceneSpec) : [])
    .map((e) => `${e.id}:${e.type}`)
    .sort();
  return { objects, events };
}

function missingPromises(baseline: Storyboard | undefined, candidate: Storyboard | undefined): string[] {
  const before = storyboardPromises(baseline);
  const after = new Set(storyboardPromises(candidate).objects);
  const afterEvents = new Set(storyboardPromises(candidate).events);
  const missing: string[] = [];
  for (const o of before.objects) if (!after.has(o)) missing.push(`object:${o}`);
  for (const e of before.events) if (!afterEvents.has(e)) missing.push(`event:${e}`);
  return missing;
}

/** No NEW hard semantic failure may appear in the candidate (baseline storyboard is authority). */
function newSemanticFailures(baseline: SceneSpec, candidate: SceneSpec): string[] {
  const key = (f: { type: string; target?: string[] }): string => `${f.type}|${(f.target ?? []).join(",")}`;
  const base = new Set(evaluateSemanticEnactment([baseline]).failures.map(key));
  return evaluateSemanticEnactment([candidate]).failures.filter((f) => !base.has(key(f))).map((f) => `${f.type}: ${f.evidence}`);
}

/* --------------------------------- the wrapper -------------------------------- */

/** Scope a project-wide metric source to ONE scene so the comparison is apples-to-apples. */
export function scopeMetrics(m: MetricSources, sceneId: string): MetricSources {
  const scoped: MetricSources = {
    scenes: (m.scenes ?? []).filter((s) => s.sceneId === sceneId),
    artifactConsistent: m.artifactConsistent ?? true,
    ...(typeof m.frameEdgeInk === "number" ? { frameEdgeInk: m.frameEdgeInk } : {}),
    ...(typeof m.timingViolations === "number" ? { timingViolations: m.timingViolations } : {}),
  };
  if (m.layoutGate) {
    scoped.layoutGate = {
      ...m.layoutGate,
      findings: m.layoutGate.findings.filter((f) => f.sceneId === sceneId),
      hard: m.layoutGate.hard.filter((h) => h.startsWith(sceneId)),
      warnings: m.layoutGate.warnings.filter((w) => w.startsWith(sceneId)),
    };
  }
  if (m.visualGates) {
    scoped.visualGates = {
      ...m.visualGates,
      scenes: m.visualGates.scenes.filter((s) => s.sceneId === sceneId),
      hard: m.visualGates.hard.filter((h) => h.startsWith(sceneId)),
      warnings: m.visualGates.warnings.filter((w) => w.startsWith(sceneId)),
    };
  }
  if (m.collisions) {
    scoped.collisions = m.collisions[sceneId] ? { [sceneId]: m.collisions[sceneId] } : {};
  }
  if (m.preRenderHard) scoped.preRenderHard = m.preRenderHard.filter((h) => h.sceneId === sceneId);
  if (m.semantic) {
    scoped.semantic = {
      ...m.semantic,
      scenes: m.semantic.scenes.filter((s) => s.sceneId === sceneId),
      failures: m.semantic.failures.filter((f) => f.sceneId === sceneId),
    };
  }
  return scoped;
}

async function modelMetrics(scenes: SceneSpec[]): Promise<MetricSources> {
  const gate = await evaluatePreRenderGate(scenes);
  const collisions: Record<string, ReturnType<typeof collisionSemantics>> = {};
  for (const s of scenes) collisions[s.sceneId] = collisionSemantics(s);
  return {
    scenes,
    preRenderHard: gate.hard.map((i) => ({ sceneId: i.sceneId, failureType: i.failureType, magnitude: i.magnitude })),
    collisions,
    semantic: evaluateSemanticEnactment(scenes),
    artifactConsistent: true,
  };
}

export async function runBoundedLegacyRepair(req: LegacyRepairRequest): Promise<LegacyRepairOutcome> {
  const { budget, sceneId, mode } = req;
  const t0 = Date.now();

  const skip = (reason: string): LegacyRepairOutcome => {
    budget.recordLegacySkip();
    appendRepairLedger(req.dir, [
      ledgerRow(req, "SKIPPED_BUDGET", reason, null, null, "model-only", "not-rendered", t0, budget),
    ]);
    return { sceneId, mode, decision: "SKIPPED_BUDGET", reason, elapsedMs: Date.now() - t0, scenes: req.scenes };
  };

  const allowed = budget.allowLegacyRepair(sceneId, mode);
  if (!allowed.ok) return skip(allowed.reason);

  const baselineScene = req.scenes.find((s) => s.sceneId === sceneId);
  if (!baselineScene) return skip(`scene ${sceneId} not found`);

  budget.claimLegacyRepair(sceneId);
  const storyboardBackup = mode === "storyboard" ? backupStoryboardFiles(req.dir) : [];
  const snapshot = createSnapshotUnique(req.dir, `legacy-${sceneId}`, {
    scenes: req.scenes,
    render: readRenderRecord(req.dir)
      ? { file: readRenderRecord(req.dir)!.file, sha256: readRenderRecord(req.dir)!.sha256 }
      : null,
    qa: null,
  });
  const baselineHash = currentSceneFingerprint(req.dir).sceneHashes[sceneId] ?? null;
  const baselineSemantic = evaluateSemanticEnactment([baselineScene]);
  const evidenceBefore = baselineSemantic.compact.join(" | ") || "no semantic contract";

  const rollback = (reason: string, decision: "ROLLBACK" | "ERROR", measurement: "measured" | "model-only", render: "candidate-rendered" | "not-rendered", comparison?: string): LegacyRepairOutcome => {
    restoreSnapshot(req.dir, snapshot.label);
    if (storyboardBackup.length) restoreStoryboardFiles(req.dir, storyboardBackup);
    const elapsed = Date.now() - t0;
    appendRepairLedger(req.dir, [
      ledgerRow(req, decision, reason, baselineHash, null, measurement, render, t0, budget, comparison),
    ]);
    budget.recordLegacyRepair({ sceneId, mode, decision, ms: elapsed, reason });
    return { sceneId, mode, decision, reason, elapsedMs: elapsed, scenes: req.scenes, comparison };
  };

  /* ------------------------------ run the repair ------------------------------ */
  let candidate: SceneSpec;
  try {
    candidate = await req.repair();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // an infrastructure/LLM failure produced no candidate: restore and RELEASE the scene
    // claim so a narrower fallback attempt is still policy-allowed
    restoreSnapshot(req.dir, snapshot.label);
    if (storyboardBackup.length) restoreStoryboardFiles(req.dir, storyboardBackup);
    budget.releaseLegacyClaim(sceneId);
    appendRepairLedger(req.dir, [
      ledgerRow(req, "ERROR", msg.slice(0, 400), baselineHash, null, "model-only", "not-rendered", t0, budget),
    ]);
    budget.recordLegacyRepair({ sceneId, mode, decision: "ERROR", ms: Date.now() - t0, reason: msg.slice(0, 200) });
    return { sceneId, mode, decision: "ERROR", reason: msg.slice(0, 400), elapsedMs: Date.now() - t0, scenes: req.scenes };
  }

  /* -------------------------- validation + preservation ----------------------- */
  // Batch F: a recompiled candidate goes through the same deterministic contract
  // reconciliation before validation - the baseline binding is restored the same way it
  // was created (no model call), so a rewrite is never rejected merely because the
  // composer dropped the headline binding again.
  candidate = reconcileSemanticContract(candidate, candidate.storyboard ?? baselineScene.storyboard).scene;
  const check = validateScene(candidate, sceneId);
  if (!check.success) {
    return rollback(`candidate failed schema validation: ${check.errors.join("; ")}`, "ERROR", "model-only", "not-rendered");
  }
  if (candidate.duration !== baselineScene.duration) {
    return rollback(
      `candidate changed duration ${baselineScene.duration}s -> ${candidate.duration}s (VO/timeline must be preserved)`,
      "ROLLBACK",
      "model-only",
      "not-rendered",
    );
  }
  if (mode === "storyboard") {
    const dropped = missingPromises(baselineScene.storyboard, candidate.storyboard);
    if (dropped.length) {
      return rollback(
        `storyboard rewrite dropped mandatory promises: ${dropped.join(", ")} (baseline storyboard is authoritative)`,
        "ROLLBACK",
        "model-only",
        "not-rendered",
      );
    }
  }
  const newSemantic = newSemanticFailures(baselineScene, candidate);
  if (newSemantic.length) {
    return rollback(
      `candidate introduces new semantic failure(s): ${newSemantic.join("; ")}`,
      "ROLLBACK",
      "model-only",
      "not-rendered",
    );
  }

  /* --------------------------------- measure ---------------------------------- */
  const baselineVector = buildMetricVector(scopeMetrics(req.baselineMetrics, sceneId));
  let measurement: "measured" | "model-only" = "model-only";
  let renderFlag: "candidate-rendered" | "not-rendered" = "not-rendered";
  let candidateVector: ReturnType<typeof buildMetricVector>;

  if (mode === "storyboard") {
    // Whole-storyboard rewrites must render and compare against the baseline (Phase 2).
    try {
      const outFile = await renderProject({ scenes: [candidate], outputName: `legacy-${sceneId}.mp4` });
      // keep the project's latest frame-evidence pointer intact around this single-scene probe
      const evidencePath = path.join(req.dir, "qa", "frame-evidence.json");
      const prevEvidence = fs.existsSync(evidencePath) ? fs.readFileSync(evidencePath, "utf8") : null;
      const ev = await collectFrameEvidence(req.projectId, [candidate], undefined, `legacy-${sceneId}`);
      if (prevEvidence !== null) fs.writeFileSync(evidencePath, prevEvidence, "utf8");
      else if (fs.existsSync(evidencePath)) fs.unlinkSync(evidencePath);
      void outFile;
      const lg = await evaluateProjectLayoutGate([candidate], ev);
      const vg = evaluateVisualGates([candidate], ev);
      const collisions: Record<string, ReturnType<typeof collisionSemantics>> = {};
      collisions[candidate.sceneId] = collisionSemantics(candidate);
      measurement = "measured";
      renderFlag = "candidate-rendered";
      candidateVector = buildMetricVector({
        scenes: [candidate],
        layoutGate: lg,
        visualGates: vg,
        collisions,
        semantic: evaluateSemanticEnactment([candidate]),
        artifactConsistent: true,
      });
    } catch (e) {
      return rollback(
        `candidate render/measurement failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
        "ERROR",
        "model-only",
        "not-rendered",
      );
    }
  } else {
    candidateVector = buildMetricVector(await modelMetrics([candidate]));
  }

  const comparison = compareRepair(baselineVector, candidateVector, {});
  const afterSemantic = evaluateSemanticEnactment([candidate]);
  const evidenceAfter = afterSemantic.compact.join(" | ") || "no semantic contract";
  const elapsed = Date.now() - t0;

  if (comparison.action === "KEEP") {
    // persist the kept candidate (repair seams that do not write themselves stay consistent)
    writeJsonAt(req.dir, `scenes/${sceneId}.json`, candidate);
    const keptHash = currentSceneFingerprint(req.dir).sceneHashes[sceneId] ?? null;
    appendRepairLedger(req.dir, [
      ledgerRow(req, "KEEP", comparison.reason, baselineHash, keptHash, measurement, renderFlag, t0, budget, describeComparison(comparison), evidenceBefore, evidenceAfter),
    ]);
    budget.recordLegacyRepair({ sceneId, mode, decision: "KEEP", ms: elapsed, reason: comparison.reason });
    return {
      sceneId,
      mode,
      decision: "KEEP",
      reason: comparison.reason,
      elapsedMs: elapsed,
      scenes: req.scenes.map((s) => (s.sceneId === sceneId ? candidate : s)),
      candidate,
      comparison: describeComparison(comparison),
    };
  }
  return rollback(comparison.reason, "ROLLBACK", measurement, renderFlag, describeComparison(comparison));
}

/* ---------------------------------- ledger ----------------------------------- */

function ledgerRow(
  req: LegacyRepairRequest,
  decision: LegacyRepairDecision,
  reason: string,
  baselineHash: string | null,
  candidateHash: string | null,
  measurement: "measured" | "model-only",
  render: "candidate-rendered" | "not-rendered",
  t0: number,
  budget: GenerationBudget,
  comparison?: string,
  evidenceBefore = "",
  evidenceAfter = "",
): RepairLedgerRow {
  return {
    schema: "repair-ledger/1",
    round: req.round,
    attempt: 1,
    sceneId: req.sceneId,
    failureType: `legacy_${req.mode}`,
    severity: "hard",
    source: "judge",
    target: [],
    baselineHash,
    baselineSnapshotId: `legacy-${req.sceneId}`,
    candidateHash,
    evidenceBefore,
    evidenceAfter,
    proposal: { legacy: req.mode, reason: req.reason ?? reason },
    validation: [],
    measurement,
    render,
    // "SKIPPED" is Batch C's budget-exhaustion row (same semantics for the legacy path)
    decision: decision === "SKIPPED_BUDGET" ? "SKIPPED" : decision,
    reason,
    comparison: comparison ?? null,
    promptHash: null,
    elapsedMs: Date.now() - t0,
    budgetRemaining: Math.round(budget.remainingMs() / 1000),
  };
}
