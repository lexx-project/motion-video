import path from "path";
import { readJsonAt, writeJsonAt, listSceneFilesAt } from "./projectStore";
import { scenesFingerprint, sha256Json } from "./identity";
import {
  QA_SUMMARY_PATH,
  readFinalRecord,
  readQaRecord,
  readRenderRecord,
  resolveRecordPath,
  verifyConsistency,
  type ConsistencyReport,
  type FinalRecord,
  type QaRecord,
  type RenderRecord,
} from "./artifacts";
import { latestSnapshot, listSnapshots, type SnapshotRecord } from "./snapshot";
import { layoutBoundsEvidence } from "../validation/layoutEvidence";
import type { SceneSpec } from "../validation/schema";
import type { FrameEvidenceReport, SceneEvidenceRollup } from "../render/frameEvidence";

/**
 * Machine-readable diagnostic summary per render/QA cycle (Batch A / A7).
 *
 * Answers, from project state alone (no prose logs, no LLM):
 *   - what was rendered?              -> render
 *   - which scene version?            -> project.scenes (+ per-scene hashes)
 *   - which frames were inspected?    -> frames.samples (metrics in qa/frame-evidence*.json)
 *   - what metrics were observed?     -> frames.sceneRollup
 *   - which QA belongs to it?         -> qa
 *   - what changed since the baseline -> changesSinceBaseline
 *   - what can be restored?           -> baseline
 */

export const DIAGNOSTICS_PATH = "qa/diagnostics.json";
export const FRAME_EVIDENCE_PATH = "qa/frame-evidence.json";

export interface DiagnosticsSceneEntry {
  sceneId: string;
  sha256: string;
  durationSec: number | null;
  elementCount: number | null;
  elementsHash: string | null;
}

export interface DiagnosticsChangeSet {
  baseline: string;
  changed: string[];
  added: string[];
  removed: string[];
  unchanged: string[];
}

export interface DiagnosticsReport {
  schema: "diagnostics/1";
  projectId: string;
  generatedAt: string;
  project: {
    scenesHash: string;
    sceneIds: string[];
    scenes: DiagnosticsSceneEntry[];
  };
  /** model-side bounds evidence per scene (A3): does the layout place anything off-frame? */
  sceneBounds: {
    sceneId: string;
    frameViolations: number;
    safeAreaViolations: number;
    contentBox: [number, number, number, number] | null;
  }[];
  render: RenderRecord | null;
  frames: {
    file: string;
    label: string;
    generatedAt: string;
    sampleCount: number;
    samples: {
      sceneId: string;
      sampleIndex: number;
      reason: string;
      timeSec: number;
      absoluteFrame: number;
      file: string;
      occupancy: number | null;
      edgeInkMax: number | null;
      contentOutsideFrame: boolean;
    }[];
    sceneRollup: SceneEvidenceRollup[];
    sourceRenderSha256: string | null;
    matchesCurrentRender: boolean | null;
    matchesCurrentScenes: boolean | null;
  } | null;
  qa: (QaRecord & { summaryFile: string }) | null;
  final: FinalRecord | null;
  consistency: ConsistencyReport;
  /** Batch B: deterministic layout/readability gates over the rendered evidence */
  gates: {
    layout: {
      ok: boolean;
      hard: string[];
      warningCount: number;
      disagreements: number;
      perScene: { sceneId: string; hard: number; warnings: number; frameAgreement: string; safeAgreement: string }[];
    } | null;
    visual: {
      ok: boolean;
      hard: string[];
      warningCount: number;
      perScene: { sceneId: string; empty: string; emptyReason: string; readability: string; occupancy: number | null; motionDelta: number | null }[];
    } | null;
    /** Batch C: model-only gate that runs BEFORE the first render */
    preRender: { proceed: boolean; hard: number; warnings: number; hardByType: Record<string, number> } | null;
    /** Batch D: semantic enactment gate (storyboard promises vs deterministic state) */
    enactment: {
      ok: boolean;
      toleranceSec: number;
      hard: number;
      perScene: {
        sceneId: string;
        contract: boolean;
        summary: string;
        events: number;
        failures: number;
        /** Batch E: category verdicts (fail = obvious primitive mismatch) */
        categoryMismatches: number;
        categoryNotVerified: number;
        categoryUnsupported: number;
      }[];
      /** flat event trace: answers "why did event_03 fail?" without reading source code */
      events: {
        sceneId: string;
        eventId: string;
        target: string;
        type: string;
        status: string;
        promisedAt: number;
        planAt: number | null;
        detectedAt: number | null;
        timingDeltaSec: number | null;
        evidence: string;
        /** Batch E Phase 5: state/pixel/identity combined verdict (separate dimensions) */
        combined: string | null;
      }[];
    } | null;
  };
  /** Batch E Phase 1: generation budget timeline + provider call accounting */
  generation: {
    schema: string;
    startedAt: string;
    finishedAt: string | null;
    elapsedMs: number;
    wallClockMs: number;
    exhausted: boolean;
    llmCalls: number;
    llmMs: number;
    timeouts: number;
    budgetRefusals: number;
    duplicatePromptsRefused: number;
    legacyRepairs: { sceneId: string; mode: string; decision: string; ms: number; reason: string }[];
    legacyRepairsSkipped: number;
    stages: { stage: string; startedAt: string; ms: number; status: string }[];
    renders: { label: string; ms: number }[];
  } | null;
  /** Batch C: why the agent changed (or kept) each scene - readable without source code */
  repairs: {
    total: number;
    byDecision: Record<string, number>;
    budgetRemaining: number | null;
    rows: {
      round: number;
      attempt: number;
      sceneId: string;
      failureType: string;
      decision: string;
      target: string[];
      baselineHash: string | null;
      candidateHash: string | null;
      evidenceBefore: string;
      evidenceAfter: string;
      reason: string;
      comparison: string | null;
      elapsedMs: number;
      budgetRemaining: number | null;
    }[];
  };
  /** Batch B: VO timing provenance for this project (never fabricated) */
  timing: {
    source: string | null;
    measuredGaps: number;
    measuredSegments: number;
    snapToleranceSec: number | null;
    alignedBoundaries: number;
  } | null;
  baseline: {
    label: string;
    createdAt: string;
    scenesHash: string;
    restorable: boolean;
    renderSha256: string | null;
    qaSha256: string | null;
  } | null;
  previousBaseline: { label: string; createdAt: string; scenesHash: string } | null;
  changesSinceBaseline: DiagnosticsChangeSet | null;
  qaStatusKnown: boolean;
}

function buildSceneEntry(id: string, data: Record<string, unknown>): DiagnosticsSceneEntry {
  const elements = Array.isArray(data.elements) ? (data.elements as unknown[]) : null;
  return {
    sceneId: id,
    sha256: sha256Json(data),
    durationSec: typeof data.duration === "number" ? data.duration : null,
    elementCount: elements ? elements.length : null,
    elementsHash: elements ? sha256Json(elements) : null,
  };
}

function diffAgainst(
  current: Record<string, string>,
  baseline: Record<string, string>,
  baselineLabel: string,
): DiagnosticsChangeSet {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  for (const [id, hash] of Object.entries(current)) {
    if (!(id in baseline)) added.push(id);
    else if (baseline[id] !== hash) changed.push(id);
    else unchanged.push(id);
  }
  for (const id of Object.keys(baseline)) if (!(id in current)) removed.push(id);
  const sort = (a: string, b: string) => a.localeCompare(b);
  return {
    baseline: baselineLabel,
    changed: changed.sort(sort),
    added: added.sort(sort),
    removed: removed.sort(sort),
    unchanged: unchanged.sort(sort),
  };
}

export interface BuildDiagnosticsOptions {
  /** label of the frame-evidence file to embed (default: latest `qa/frame-evidence.json`) */
  frameEvidenceFile?: string;
  manifest?: { status?: string } | null;
}

export function buildDiagnostics(dir: string, opts: BuildDiagnosticsOptions = {}): DiagnosticsReport {
  const sceneFiles = listSceneFilesAt(dir);
  const fp = scenesFingerprint(sceneFiles.map((s) => s.data));
  const scenes: DiagnosticsSceneEntry[] = sceneFiles.map((s) =>
    buildSceneEntry(s.sceneId, s.data as Record<string, unknown>),
  );

  const render = readRenderRecord(dir);
  const qa = readQaRecord(dir);
  const final = readFinalRecord(dir);

  const evidenceFile = opts.frameEvidenceFile ?? FRAME_EVIDENCE_PATH;
  const evidence = readJsonAt<FrameEvidenceReport>(dir, evidenceFile);

  let frames: DiagnosticsReport["frames"] = null;
  if (evidence) {
    frames = {
      file: evidenceFile,
      label: evidence.label,
      generatedAt: evidence.generatedAt,
      sampleCount: evidence.samples.length,
      samples: evidence.samples.map((s) => ({
        sceneId: s.sceneId,
        sampleIndex: s.sampleIndex,
        reason: s.reason,
        timeSec: s.timeSec,
        absoluteFrame: s.absoluteFrame,
        file: s.file,
        occupancy: s.metrics?.occupancy ?? null,
        edgeInkMax: s.metrics
          ? Math.max(s.metrics.edgeInk.left, s.metrics.edgeInk.right, s.metrics.edgeInk.top, s.metrics.edgeInk.bottom)
          : null,
        contentOutsideFrame: s.metrics?.contentOutsideFrame ?? false,
      })),
      sceneRollup: evidence.sceneRollup,
      sourceRenderSha256: evidence.sourceRender?.sha256 ?? null,
      matchesCurrentRender: render && evidence.sourceRender?.sha256
        ? render.sha256 === evidence.sourceRender.sha256
        : null,
      matchesCurrentScenes: evidence.scenesHash ? evidence.scenesHash === fp.scenesHash : null,
    };
  }

  const snapshots: SnapshotRecord[] = listSnapshots(dir);
  const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const previous = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null;

  const baseline = latest
    ? {
        label: latest.label,
        createdAt: latest.createdAt,
        scenesHash: latest.scenesHash,
        restorable: true,
        renderSha256: latest.render?.sha256 ?? null,
        qaSha256: latest.qa?.qaSha256 ?? null,
      }
    : null;

  const currentHashes: Record<string, string> = {};
  for (const s of sceneFiles) {
    const hash = fp.sceneHashes[s.sceneId];
    if (hash) currentHashes[s.sceneId] = hash;
  }

  const consistency = verifyConsistency(dir, {
    requireQa: Boolean(qa) || opts.manifest?.status === "complete",
    requireFinal: opts.manifest?.status === "complete",
    manifest: opts.manifest ?? null,
  });

  const layoutGateFile = readJsonAt<{
    ok: boolean;
    hard: string[];
    warnings: string[];
    disagreements: number;
    findings: { sceneId: string; hard: string[]; warnings: string[]; agreement: { frame: string; safeArea: string } }[];
  }>(dir, "qa/layout-gate.json");
  const visualGateFile = readJsonAt<{
    ok: boolean;
    hard: string[];
    warnings: string[];
    scenes: { sceneId: string; empty: { status: string; reason: string; occupancy: number | null; motionDelta: number | null }; readability: { status: string } }[];
  }>(dir, "qa/visual-gates.json");
  const timestamps = readJsonAt<{
    source?: string;
    gaps?: unknown[];
    segments?: unknown[];
    snapToleranceSec?: number;
  }>(dir, "analysis/timestamps.json");
  const beatsFile = readJsonAt<{ beats?: { timing?: { evidence?: { aligned?: boolean } } }[] }>(dir, "analysis/beats.json");

  const gates: {
    layout: DiagnosticsReport["gates"]["layout"];
    visual: DiagnosticsReport["gates"]["visual"];
  } = {
    layout: layoutGateFile
      ? {
          ok: layoutGateFile.ok,
          hard: layoutGateFile.hard,
          warningCount: layoutGateFile.warnings.length,
          disagreements: layoutGateFile.disagreements,
          perScene: (layoutGateFile.findings ?? []).map((f) => ({
            sceneId: f.sceneId,
            hard: f.hard.length,
            warnings: f.warnings.length,
            frameAgreement: f.agreement.frame,
            safeAgreement: f.agreement.safeArea,
          })),
        }
      : null,
    visual: visualGateFile
      ? {
          ok: visualGateFile.ok,
          hard: visualGateFile.hard,
          warningCount: visualGateFile.warnings.length,
          perScene: (visualGateFile.scenes ?? []).map((s) => ({
            sceneId: s.sceneId,
            empty: s.empty.status,
            emptyReason: s.empty.reason,
            readability: s.readability.status,
            occupancy: s.empty.occupancy,
            motionDelta: s.empty.motionDelta,
          })),
        }
      : null,
  };

  const timing: DiagnosticsReport["timing"] = timestamps
    ? {
        source: timestamps.source ?? null,
        measuredGaps: timestamps.gaps?.length ?? 0,
        measuredSegments: timestamps.segments?.length ?? 0,
        snapToleranceSec: timestamps.snapToleranceSec ?? null,
        alignedBoundaries: (beatsFile?.beats ?? []).filter((b) => b.timing?.evidence?.aligned).length,
      }
    : null;

  const preRenderFile = readJsonAt<{
    proceed: boolean;
    hard: { failureType: string }[];
    warnings: { failureType: string }[];
  }>(dir, "qa/pre-render-gate.json");
  const preRender = preRenderFile
    ? {
        proceed: preRenderFile.proceed,
        hard: preRenderFile.hard.length,
        warnings: preRenderFile.warnings.length,
        hardByType: preRenderFile.hard.reduce<Record<string, number>>((acc, i) => {
          acc[i.failureType] = (acc[i.failureType] ?? 0) + 1;
          return acc;
        }, {}),
      }
    : null;

  // Batch D: semantic enactment report (written by the pipeline / gate; deterministic)
  const enactmentFile = readJsonAt<{
    ok?: boolean;
    toleranceSec?: number;
    failures?: { type: string; sceneId: string; evidence: string }[];
    scenes?: {
      sceneId: string;
      contractActive?: boolean;
      summary?: string;
      failures?: unknown[];
      categories?: { status: string }[];
      events?: {
        eventId: string;
        target: string;
        type: string;
        status: string;
        promisedAt: number;
        planAt: number | null;
        detectedAt: number | null;
        timingDeltaSec: number | null;
        evidence: string;
      }[];
    }[];
  }>(dir, "qa/semantic-enactment.json");
  const enactment: DiagnosticsReport["gates"]["enactment"] = enactmentFile
    ? {
        ok: enactmentFile.ok ?? true,
        toleranceSec: enactmentFile.toleranceSec ?? 0,
        hard: enactmentFile.failures?.length ?? 0,
        perScene: (enactmentFile.scenes ?? []).map((s) => {
          const cats = s.categories ?? [];
          return {
            sceneId: s.sceneId,
            contract: s.contractActive ?? false,
            summary: s.summary ?? "",
            events: s.events?.length ?? 0,
            failures: s.failures?.length ?? 0,
            categoryMismatches: cats.filter((c) => c.status === "fail").length,
            categoryNotVerified: cats.filter((c) => c.status === "not_verified").length,
            categoryUnsupported: cats.filter((c) => c.status === "unsupported_representation").length,
          };
        }),
        events: (enactmentFile.scenes ?? []).flatMap((s) =>
          (s.events ?? []).map((e) => {
            // Batch E Phase 5: combined status lives with the event's own evidence file
            const evFile = readJsonAt<{ crossCheck?: { combined?: string } }>(
              dir,
              `qa/events/${s.sceneId}/${e.eventId}.json`,
            );
            return {
              sceneId: s.sceneId,
              eventId: e.eventId,
              target: e.target,
              type: e.type,
              status: e.status,
              promisedAt: e.promisedAt,
              planAt: e.planAt,
              detectedAt: e.detectedAt,
              timingDeltaSec: e.timingDeltaSec,
              evidence: e.evidence,
              combined: evFile?.crossCheck?.combined ?? null,
            };
          }),
        ),
      }
    : null;

  // Batch E Phase 1: generation budget timeline (qa/generation-budget.json)
  const generationFile = readJsonAt<{
    schema?: string;
    startedAt?: string;
    finishedAt?: string | null;
    elapsedMs?: number;
    exhausted?: boolean;
    config?: { wallClockMs?: number };
    llmCalls?: number;
    llmMs?: number;
    timeouts?: number;
    budgetRefusals?: number;
    duplicatePromptsRefused?: number;
    legacyRepairs?: { sceneId: string; mode: string; decision: string; ms: number; reason: string }[];
    legacyRepairsSkipped?: number;
    stages?: { stage: string; startedAt: string; ms: number; status: string }[];
    renders?: { label: string; ms: number }[];
  }>(dir, "qa/generation-budget.json");
  const generation: DiagnosticsReport["generation"] = generationFile
    ? {
        schema: generationFile.schema ?? "generation-budget/1",
        startedAt: generationFile.startedAt ?? "",
        finishedAt: generationFile.finishedAt ?? null,
        elapsedMs: generationFile.elapsedMs ?? 0,
        wallClockMs: generationFile.config?.wallClockMs ?? 0,
        exhausted: generationFile.exhausted ?? false,
        llmCalls: generationFile.llmCalls ?? 0,
        llmMs: generationFile.llmMs ?? 0,
        timeouts: generationFile.timeouts ?? 0,
        budgetRefusals: generationFile.budgetRefusals ?? 0,
        duplicatePromptsRefused: generationFile.duplicatePromptsRefused ?? 0,
        legacyRepairs: generationFile.legacyRepairs ?? [],
        legacyRepairsSkipped: generationFile.legacyRepairsSkipped ?? 0,
        stages: generationFile.stages ?? [],
        renders: generationFile.renders ?? [],
      }
    : null;

  // typed structurally: core must not import agents (the ledger is a project artifact)
  const ledger = readJsonAt<
    {
      round: number;
      attempt: number;
      sceneId: string;
      failureType: string;
      decision: string;
      target?: string[];
      baselineHash?: string | null;
      candidateHash?: string | null;
      evidenceBefore?: string;
      evidenceAfter?: string;
      reason: string;
      comparison?: string | null;
      elapsedMs?: number;
      budgetRemaining?: number;
    }[]
  >(dir, "qa/repair-ledger.json");
  const rows = (ledger ?? []).map((r) => ({
    round: r.round,
    attempt: r.attempt,
    sceneId: r.sceneId,
    failureType: r.failureType,
    decision: r.decision,
    target: r.target ?? [],
    baselineHash: r.baselineHash ?? null,
    candidateHash: r.candidateHash ?? null,
    evidenceBefore: r.evidenceBefore ?? "",
    evidenceAfter: r.evidenceAfter ?? "",
    reason: r.reason,
    comparison: r.comparison ?? null,
    elapsedMs: r.elapsedMs ?? 0,
    budgetRemaining: r.budgetRemaining ?? null,
  }));
  const repairs: DiagnosticsReport["repairs"] = {
    total: rows.length,
    byDecision: rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.decision] = (acc[r.decision] ?? 0) + 1;
      return acc;
    }, {}),
    budgetRemaining: rows.length ? rows[rows.length - 1].budgetRemaining : null,
    rows,
  };

  return {
    schema: "diagnostics/1",
    projectId: path.basename(path.resolve(dir)),
    generatedAt: new Date().toISOString(),
    project: {
      scenesHash: fp.scenesHash,
      sceneIds: fp.sceneIds,
      scenes,
    },
    sceneBounds: sceneFiles.map((s) => {
      const e = layoutBoundsEvidence(s.data as SceneSpec);
      return {
        sceneId: s.sceneId,
        frameViolations: e.frameViolations.length,
        safeAreaViolations: e.safeAreaViolations.length,
        contentBox: e.contentBox
          ? [Math.round(e.contentBox.x0), Math.round(e.contentBox.y0), Math.round(e.contentBox.x1), Math.round(e.contentBox.y1)]
          : null,
      };
    }),
    render,
    frames,
    qa: qa ? { ...qa, summaryFile: QA_SUMMARY_PATH } : null,
    final,
    consistency,
    gates: { ...gates, preRender, enactment },
    generation,
    repairs,
    timing,
    baseline,
    previousBaseline: previous
      ? { label: previous.label, createdAt: previous.createdAt, scenesHash: previous.scenesHash }
      : null,
    changesSinceBaseline: latest
      ? diffAgainst(currentHashes, latest.sceneHashes, latest.label)
      : null,
    qaStatusKnown: qa !== null,
  };
}

export function writeDiagnostics(dir: string, opts: BuildDiagnosticsOptions = {}): DiagnosticsReport {
  const report = buildDiagnostics(dir, opts);
  writeJsonAt(dir, DIAGNOSTICS_PATH, report);
  return report;
}

export const readDiagnostics = (dir: string): DiagnosticsReport | null =>
  readJsonAt<DiagnosticsReport>(dir, DIAGNOSTICS_PATH);

/** Compact one-liner for progress logs. */
export const summarizeDiagnostics = (r: DiagnosticsReport): string => {
  const parts = [
    `render=${r.render ? r.render.sha256.slice(0, 12) : "none"}`,
    `qa=${r.qa ? `${r.qa.status ?? "?"}/${r.qa.qaSha256.slice(0, 12)}` : "none"}`,
    `final=${r.final ? r.final.sha256.slice(0, 12) : "none"}`,
    `frames=${r.frames?.sampleCount ?? 0}`,
    `consistency=${r.consistency.ok ? "ok" : r.consistency.issues.filter((i) => i.severity === "error").map((i) => i.code).join(",")}`,
    `baseline=${r.baseline?.label ?? "none"}`,
  ];
  return parts.join(" ");
};

/** Absolute path of the artifact QA inspected (convenience for later agents). */
export const qaArtifactPath = (dir: string, qa: QaRecord | null): string | null =>
  qa ? resolveRecordPath(dir, qa.renderFile) : null;

/** Convenience re-export so callers do not need two imports for the common case. */
export { latestSnapshot };
