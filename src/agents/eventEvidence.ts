import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { createStillRenderer } from "../render/renderProject";
import { analyzeFrame, frameDiff } from "../render/frameEvidence";
import { evaluateSemanticEnactment } from "../validation/semanticEnactment";
import type { EventEvidence, SemanticEnactmentReport } from "../validation/semanticEnactment";
import { resolveExecutionPlan } from "../validation/executionPlan";
import { stateForSemanticId, snapshotOf, type StateSnapshot } from "../scenes/state";
import { projectDir, writeJsonAt } from "../core/projectStore";
import { OUTPUT } from "../core/output";
import type { SceneSpec } from "../validation/schema";

/**
 * EVENT EVIDENCE (Batch D §27 + Batch E Phases 4-5): pre / at / post stills ONLY around
 * real events, plus an honest three-dimension cross-check:
 *
 *   state        - Batch D deterministic state transition (pure, no pixels)
 *   pixel_change - frame difference over the EVENT window (isolated object render when
 *                  available, whole-frame fallback otherwise; method recorded)
 *   identity     - whether the pixels can be attributed to the semantic id. With Batch E
 *                  isolation the answer is YES by construction (only that element paints);
 *                  without it: NOT VERIFIED. No segmentation, no confidence fabrication.
 *   combined     - PASS only when all dimensions pass; FAIL when state fails (or verified
 *                  pixels contradict a required visual change); otherwise NOT VERIFIED.
 *
 * Scenes without an executable storyboard contract cost NOTHING (no bundle, no stills).
 */

export const EVENT_STILL_ROLES = ["pre", "at", "post"] as const;
export type EventStillRole = (typeof EVENT_STILL_ROLES)[number];

/** Mean pixel difference floor for an object-level change (270x480 analysis frames). */
export const EVENT_PIXEL_DIFF_FLOOR = 0.0015;
/** Occupancy delta floor (fallback signal when content shifts in place). */
export const EVENT_OCCUPANCY_FLOOR = 0.0005;
/** Minimum measurable ink for an isolated object to count as painted at all. */
export const EVENT_MIN_OBJECT_INK = 0.0004;

/** Event types whose promised transition MUST change pixels (attach/detach intentionally may not). */
export const PIXEL_REQUIRED_EVENT_TYPES: readonly string[] = [
  "enter",
  "exit",
  "move",
  "scale",
  "rotate",
  "fade",
  "replace",
  "reveal",
  "progress",
];

export type EventDimensionStatus = "PASS" | "FAIL" | "NOT_APPLICABLE" | "NOT_VERIFIED";

export interface EventCrossCheck {
  state: "PASS" | "FAIL";
  pixel_change: "PASS" | "FAIL" | "NOT_APPLICABLE";
  identity: "PASS" | "NOT_VERIFIED";
  combined: "PASS" | "FAIL" | "NOT_VERIFIED";
  methods: {
    state: "deterministic-state";
    pixel: "isolated-render-frame-diff" | "frame-diff" | "none";
    identity: "isolated-render" | "none";
  };
  pixelEvidence?: {
    frameDiff: number;
    occupancyBefore: number | null;
    occupancyAfter: number | null;
    files: string[];
  };
  identityEvidence?: string;
}

/**
 * Pure combined-status rules (Batch E / Phase 5) - kept separate so state, pixel and
 * identity can never be conflated:
 *
 *   state=FAIL                                        -> FAIL   (a missing event is a failure)
 *   state=PASS + pixel=FAIL (required) + identity=PASS -> FAIL   (verified pixels disagree)
 *   state=PASS + identity=NOT_VERIFIED                -> NOT_VERIFIED
 *   otherwise                                         -> PASS
 */
export function combineEventStatus(input: {
  state: "PASS" | "FAIL";
  pixelChange?: "PASS" | "FAIL" | "NOT_APPLICABLE";
  identity: "PASS" | "NOT_VERIFIED";
  pixelRequired: boolean;
}): { combined: "PASS" | "FAIL" | "NOT_VERIFIED" } {
  if (input.state === "FAIL") return { combined: "FAIL" };
  if (input.pixelRequired && input.pixelChange === "FAIL" && input.identity === "PASS") {
    return { combined: "FAIL" };
  }
  if (input.identity === "NOT_VERIFIED") return { combined: "NOT_VERIFIED" };
  return { combined: "PASS" };
}

export interface EventStill {
  role: EventStillRole;
  timeSec: number;
  sceneFrame: number;
  absoluteFrame: number;
  /** path relative to the project directory (portable) */
  file: string;
  sha256: string;
}

export interface EventEvidenceFile {
  schema: "event-evidence/1";
  sceneId: string;
  eventId: string;
  target: string;
  type: string;
  status: EventEvidence["status"];
  promisedAt: number;
  planAt: number | null;
  detectedAt: number | null;
  timingDeltaSec: number | null;
  toleranceSec: number;
  window: { pre: number; at: number; post: number };
  expected: string;
  state: { before: StateSnapshot | null; at: StateSnapshot | null; after: StateSnapshot | null };
  detected: boolean;
  confidence: number;
  evidence: string;
  stills: EventStill[];
  /** Batch E: state vs pixel vs identity, reported separately (never conflated) */
  crossCheck: EventCrossCheck;
  /** isolated per-object stills (empty when isolation was not run) */
  isolatedStills: EventStill[];
}

export interface EventEvidenceResult {
  written: string[];
  reports: EventEvidenceFile[];
}

export interface CollectEventEvidenceOptions {
  label?: string;
  /** evidence stills are capped per scene (cost control - QA evidence, not a dataset) */
  maxEventsPerScene?: number;
  /**
   * Batch E Phase 4/5: per-object isolated renders for pixel+identity evidence.
   * Default true; set false to reproduce the pre-isolation behaviour (identity NOT VERIFIED).
   */
  objectIsolation?: boolean;
}

const sha256File = (file: string): string =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const sceneStartSeconds = (scenes: SceneSpec[], sceneId: string): number => {
  let cursor = 0;
  for (const s of scenes) {
    if (s.sceneId === sceneId) return cursor;
    cursor += s.duration;
  }
  return 0;
};

/** Deterministic still plan for one event: the window the gate actually measured. */
export function planEventStills(
  scenes: SceneSpec[],
  scene: SceneSpec,
  ev: { eventId: string; window: { pre: number; at: number; post: number } },
): EventStill[] {
  const start = sceneStartSeconds(scenes, scene.sceneId);
  const durationFrames = Math.max(1, Math.round(scene.duration * OUTPUT.fps));
  const out: EventStill[] = [];
  for (const role of EVENT_STILL_ROLES) {
    const t = ev.window[role];
    const sceneFrame = Math.max(0, Math.min(durationFrames - 1, Math.round(t * OUTPUT.fps)));
    const absoluteFrame = Math.round(start * OUTPUT.fps) + sceneFrame;
    out.push({
      role,
      timeSec: Number(t.toFixed(4)),
      sceneFrame,
      absoluteFrame,
      file: "",
      sha256: "",
    });
  }
  return out;
}

/**
 * Render pre/at/post stills + write one JSON evidence file per promised event.
 * Returns immediately (no render at all) when no scene carries an executable contract.
 */
export async function collectEventEvidence(
  projectId: string,
  scenes: SceneSpec[],
  audioPath: string | undefined,
  opts: CollectEventEvidenceOptions = {},
): Promise<EventEvidenceResult> {
  const label = opts.label ?? "events";
  const maxEvents = opts.maxEventsPerScene ?? 2;
  const dir = projectDir(projectId);

  const gate: SemanticEnactmentReport = evaluateSemanticEnactment(scenes);
  const active = gate.scenes.filter((s) => s.contractActive && s.events.length > 0);
  if (active.length === 0) return { written: [], reports: [] };

  const renderStill = await createStillRenderer(scenes, audioPath);
  const written: string[] = [];
  const reports: EventEvidenceFile[] = [];

  // isolated renderers are created lazily and cached per semantic id
  const isolationEnabled = opts.objectIsolation !== false;
  const isoRenderers = new Map<string, Awaited<ReturnType<typeof createStillRenderer>>>();
  const isoRendererFor = async (semanticId: string): Promise<Awaited<ReturnType<typeof createStillRenderer>>> => {
    const hit = isoRenderers.get(semanticId);
    if (hit) return hit;
    const r = await createStillRenderer(scenes, audioPath, { isolateSemanticId: semanticId });
    isoRenderers.set(semanticId, r);
    return r;
  };

  for (const sceneGate of active) {
    const scene = scenes.find((s) => s.sceneId === sceneGate.sceneId);
    if (!scene) continue;
    const plan = resolveExecutionPlan(scene);

    for (const ev of sceneGate.events.slice(0, maxEvents)) {
      const stills = planEventStills(scenes, scene, ev);
      for (const still of stills) {
        const rel = `qa/events/${scene.sceneId}/${ev.eventId}_${still.role}.png`;
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        await renderStill(still.absoluteFrame, abs);
        still.file = rel;
        still.sha256 = sha256File(abs);
      }

      /* ---------------- Batch E Phase 4/5: object-level pixel evidence ---------------- */
      const pixelRequired = PIXEL_REQUIRED_EVENT_TYPES.includes(ev.type);
      const stateStatus: "PASS" | "FAIL" = ev.status === "pass" ? "PASS" : "FAIL";
      let isolatedStills: EventStill[] = [];
      let identity: "PASS" | "NOT_VERIFIED" = "NOT_VERIFIED";
      let identityEvidence: string | undefined;
      let pixelChange: "PASS" | "FAIL" | "NOT_APPLICABLE" = "NOT_APPLICABLE";
      let pixelMethod: EventCrossCheck["methods"]["pixel"] = "none";
      let pixelEvidence: EventCrossCheck["pixelEvidence"];

      if (isolationEnabled && ev.target) {
        const iso = await isoRendererFor(ev.target);
        isolatedStills = planEventStills(scenes, scene, ev);
        const occ: (number | null)[] = [];
        for (const still of isolatedStills) {
          const rel = `qa/events/${scene.sceneId}/${ev.eventId}_${still.role}_iso.png`;
          const abs = path.join(dir, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          await iso(still.absoluteFrame, abs);
          still.file = rel;
          still.sha256 = sha256File(abs);
          const m = await analyzeFrame(abs);
          occ.push(m ? m.occupancy : null);
        }
        const maxInk = occ.reduce<number>((mx, o) => Math.max(mx, o ?? 0), 0);
        identity = maxInk >= EVENT_MIN_OBJECT_INK ? "PASS" : "NOT_VERIFIED";
        identityEvidence =
          identity === "PASS"
            ? `isolated render: pixels attributable to semanticId=${ev.target} (max occupancy ${maxInk})`
            : `isolated render: semanticId=${ev.target} produced no measurable ink in pre/at/post (identity NOT VERIFIED)`;

        if (pixelRequired && isolatedStills.length === 3) {
          const preFile = path.join(dir, isolatedStills[0].file);
          const postFile = path.join(dir, isolatedStills[2].file);
          const d = (await frameDiff(preFile, postFile)) ?? 0;
          const dOcc = Math.abs((occ[2] ?? 0) - (occ[0] ?? 0));
          pixelChange = d >= EVENT_PIXEL_DIFF_FLOOR || dOcc >= EVENT_OCCUPANCY_FLOOR ? "PASS" : "FAIL";
          pixelMethod = "isolated-render-frame-diff";
          pixelEvidence = {
            frameDiff: Number(d.toFixed(6)),
            occupancyBefore: occ[0],
            occupancyAfter: occ[2],
            files: [isolatedStills[0].file, isolatedStills[2].file],
          };
        } else if (!pixelRequired) {
          pixelMethod = "isolated-render-frame-diff";
        }
      } else {
        identityEvidence = "object-level pixel attribution unavailable (isolation disabled) - identity NOT VERIFIED";
        if (pixelRequired && stills.length === 3) {
          const d = (await frameDiff(path.join(dir, stills[0].file), path.join(dir, stills[2].file))) ?? 0;
          pixelChange = d >= EVENT_PIXEL_DIFF_FLOOR ? "PASS" : "FAIL";
          pixelMethod = "frame-diff";
          pixelEvidence = { frameDiff: Number(d.toFixed(6)), occupancyBefore: null, occupancyAfter: null, files: [stills[0].file, stills[2].file] };
        }
      }

      const crossCheck: EventCrossCheck = {
        state: stateStatus,
        pixel_change: pixelChange,
        identity,
        combined: combineEventStatus({ state: stateStatus, pixelChange, identity, pixelRequired }).combined,
        methods: { state: "deterministic-state", pixel: pixelMethod, identity: isolationEnabled ? "isolated-render" : "none" },
        ...(pixelEvidence ? { pixelEvidence } : {}),
        ...(identityEvidence ? { identityEvidence } : {}),
      };

      const planEvent = plan.events.find((e) => e.id === ev.eventId) ?? null;
      const report: EventEvidenceFile = {
        schema: "event-evidence/1",
        sceneId: scene.sceneId,
        eventId: ev.eventId,
        target: ev.target,
        type: ev.type,
        status: ev.status,
        promisedAt: ev.promisedAt,
        planAt: planEvent ? planEvent.atSeconds : null,
        detectedAt: ev.detectedAt,
        timingDeltaSec: ev.timingDeltaSec,
        toleranceSec: gate.toleranceSec,
        window: ev.window,
        expected: ev.expected,
        state: {
          before: snapshotOf(stateForSemanticId(scene, ev.target, ev.window.pre)),
          at: snapshotOf(stateForSemanticId(scene, ev.target, ev.window.at)),
          after: snapshotOf(stateForSemanticId(scene, ev.target, ev.window.post)),
        },
        detected: ev.detected,
        confidence: ev.confidence,
        evidence: ev.evidence,
        stills,
        crossCheck,
        isolatedStills,
      };
      const relJson = `qa/events/${scene.sceneId}/${ev.eventId}.json`;
      writeJsonAt(dir, relJson, report);
      written.push(relJson);
      reports.push(report);
    }
  }
  void label;
  return { written, reports };
}
