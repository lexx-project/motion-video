import { completeJson } from "./llm";
import { designBibleCompactPrompt, primitiveSpecsFor, sceneRulesPrompt, memoryPrompt } from "./context";
import { repairReportSchema, normalizeScenes, type RepairReport, type VisualQa, type SlopQa } from "./schemas";
import { markStage, writeJson, readJson } from "../core/projectStore";
import { stageError, type ErrorStage } from "../core/errors";
import { validateScene } from "../validation/validate";
import { textCollisions } from "../reference/conformance";
import type { SceneSpec } from "../validation/schema";
import type { NoveltyReport } from "./novelty";
import { QA_THRESHOLDS as QA } from "../core/output";

export interface RepairContext {
  projectId: string;
  scene: SceneSpec;
  beat: { id: string; text: string; emphasisPhrase?: string };
  visualIssues: string[];
  visualRepairs: string[];
  slopFindings: { type: string; evidence: string; severity: number }[];
  novelty?: NoveltyReport["results"][number];
  conformance?: import("../reference/conformance").SceneConformance;
  /** Repair routing category (Phase 3 §41): semantic | layout | subtitle | typography | composition */
  category?: "semantic" | "layout" | "subtitle" | "typography" | "composition";
}

/** Structural distance 0..1: did the repair silently replace the whole concept? */
export function conceptChanged(a: SceneSpec, b: SceneSpec): boolean {
  const primitiveSetChanged = (() => {
    const pa = a.elements.map((e) => e.primitive).sort().join(",");
    const pb = b.elements.map((e) => e.primitive).sort().join(",");
    return pa !== pb;
  })();
  const compositionChanged = a.composition !== b.composition;
  const conceptChanged = a.visualConcept !== b.visualConcept;
  return primitiveSetChanged && compositionChanged && conceptChanged;
}

/** Repair ONE scene with root-cause-driven minimal changes (MASTER_SPEC section 12 / Phase 2 §14). */
export async function repairScene(ctx: RepairContext): Promise<{ scene: SceneSpec; report: RepairReport }> {
  markStage(ctx.projectId, "repair", "running");
  const findings = [
    ...ctx.visualIssues.map((i) => `vision-qa: ${i}`),
    ...ctx.visualRepairs.map((i) => `vision-qa recommends: ${i}`),
    ...ctx.slopFindings.map((f) => `slop[${f.type}] severity ${f.severity}: ${f.evidence}`),
    ...(ctx.novelty
      ? [
          `novelty: similarity ${ctx.novelty.similarity} with ${ctx.novelty.against} (matched: ${ctx.novelty.matchedDimensions.join(", ")})`,
        ]
      : []),
    ...(ctx.conformance
      ? [
          `reference conformance ${ctx.conformance.overall}/10: ${ctx.conformance.evidence.slice(0, 3).join("; ")}`,
        ]
      : []),
  ];

  if (findings.length === 0) {
    throw stageError("repair", `No findings for scene ${ctx.scene.sceneId} - nothing to repair`, {
      projectId: ctx.projectId,
      sceneId: ctx.scene.sceneId,
      recoverable: true,
    });
  }

  try {
    let collisionRetries = 0;
    const result = await completeJson<RepairReport>({
      stage: "repair" as ErrorStage,
      projectId: ctx.projectId,
      temperature: 0.4,
      maxTokens: 16000,
      attempts: 3,
      reasoningEffort: "minimal",
      system: `You are the Repair Agent of a motion-design studio (MASTER_SPEC section 12 / Phase 2 §14).
${designBibleCompactPrompt()}

${primitiveSpecsFor(
  new Set([
    ...ctx.scene.elements.map((e) => e.primitive),
    "Headline",
    "WordReveal",
    "CharacterReveal",
    "HighlightWord",
    "Label",
    "Subheadline",
    "Caption",
  ]),
)}

${sceneRulesPrompt()}

${memoryPrompt(ctx.projectId)}

Be efficient: after a BRIEF root-cause analysis, output the JSON immediately - long deliberation causes gateway timeouts and truncated responses.
Repair category hint: ${ctx.category ?? "composition"} - semantic: you may revise scene.storyboard's mechanism/narrative/objects (keep beatId, keep it consistent with the new scene); layout: move anchors/offsets to clear collisions; subtitle: never add caption-like elements (the VO band is system-rendered) and keep the bottom band clear; typography: fix hierarchy/size/wraps; composition: restore hierarchy and reference grammar.
For EACH finding: identify the precise root cause, then repair only what that cause requires.
Keep every string short (issue/rootCause <= 300 chars, changesMade items <= 250 chars). Output structure (all required):
- issue: the concrete observable problem (one sentence)
- rootCause: WHY it happens (e.g. "headline anchor and caption anchor collide", "visual only narrates repetition instead of enacting it")
- scope: "minimal" (default - keep concept/composition/motion family) or "conceptReplacement" ONLY when the visual mechanism itself cannot communicate the beat
- changesMade: itemized minimal edits
- preserve: what must stay untouched (typography style, color discipline, composition family, VO timing/duration, passing elements)
- expectedEffect: how the repair resolves the issue
- scene: the full repaired scene JSON (same sceneId; duration unchanged unless timing was the issue)

Rules: valid scene JSON only (no code). Common minimal fixes: shorten/split headline; reduce accent words to <=2; remove decorative elements; restore hierarchy; replace only the offending object; single motion system; reduce glow.
For collisions caused by a long word overflowing its column (e.g. PENGARUHNYA in a 46% side column): move the headline to a wider anchor (change composition to centered or topTextBottomObject) or move the object to the opposite band - never keep them adjacent.
For relevance findings the frame must ENACT the beat (states changing, progress climbing, before/after, counters) - a static caption that merely narrates is insufficient; prefer one symbolic object performing the action + one typographic line.
A "minimal" scope that changes composition AND primitive set AND visualConcept simultaneously will be rejected.`,
      user: `# Scene (current)\n${JSON.stringify(ctx.scene, null, 1)}\n\n# Script beat\n${JSON.stringify(ctx.beat, null, 1)}\n\n# QA findings\n${findings.map((f) => `- ${f}`).join("\n")}`,
      parse: (obj) => {
        const raw = (obj && typeof obj === "object" ? { ...obj } : {}) as Record<string, unknown>;
        if (raw.scene) {
          const norm = normalizeScenes({ scenes: [raw.scene] }) as { scenes: unknown[] };
          raw.scene = norm.scenes[0];
        }
        const report = repairReportSchema.parse(raw);
        report.scene.sceneId = ctx.scene.sceneId;
        const check = validateScene(report.scene, ctx.scene.sceneId);
        if (!check.success) {
          throw stageError(
            "repair",
            `Repaired scene failed validation:\n- ${check.errors.join("\n- ")}`,
            { projectId: ctx.projectId, sceneId: ctx.scene.sceneId, recoverable: true },
          );
        }
        if (report.scope === "minimal" && conceptChanged(ctx.scene, report.scene)) {
          throw stageError(
            "repair",
            "scope=minimal but the repair replaced composition + primitives + visualConcept at once. Either restore the passing structure or set scope=conceptReplacement with a real root cause.",
            { projectId: ctx.projectId, sceneId: ctx.scene.sceneId, recoverable: true },
          );
        }
        const cols = textCollisions(report.scene);
        if (cols.length > 0 && collisionRetries === 0) {
          collisionRetries += 1;
          throw stageError(
            "repair",
            `The repaired scene still has layout collisions:\n- ${cols.map((c) => `${c.a} overlaps ${c.b} (${Math.round(c.ratio * 100)}%)`).join("\n")}\nMove the colliding items to different bands or the SAME anchor (or shorten the headline).`,
            { projectId: ctx.projectId, sceneId: ctx.scene.sceneId, recoverable: true },
          );
        }
        if (cols.length > 0) {
          console.warn(
            `[${report.scene.sceneId}] repair accepted with unresolved collisions: ${cols.map((c) => `${c.a} x ${c.b}`).join(", ")}`,
          );
        }
        return report;
      },
    });

    writeJson(ctx.projectId, `scenes/${result.scene.sceneId}.json`, result.scene);
    writeJson(ctx.projectId, `qa/repair-${result.scene.sceneId}.json`, {
      sceneId: result.scene.sceneId,
      issue: result.issue,
      rootCause: result.rootCause,
      scope: result.scope,
      changesMade: result.changesMade,
      preserve: result.preserve,
      expectedEffect: result.expectedEffect,
    });
    return { scene: result.scene, report: result };
  } catch (e) {
    markStage(ctx.projectId, "repair", "failed", String(e));
    if (e && typeof e === "object" && "stage" in e) throw e;
    throw stageError("repair", e instanceof Error ? e.message : String(e), {
      projectId: ctx.projectId,
      sceneId: ctx.scene.sceneId,
    });
  }
}

export interface RepairPlanItem {
  sceneId: string;
  reason: string;
  /** Drives targeted repair routing (Phase 3 §41): semantic issues regenerate the storyboard. */
  category: "semantic" | "layout" | "subtitle" | "typography" | "composition";
}

const classify = (reason: string): RepairPlanItem["category"] => {
  if (/semantic relevance|visual storytelling|evidence coverage|displays instead|does not represent/i.test(reason))
    return "semantic";
  if (/COLLISION|SUBTITLE_COLLISION|overlap|clipping|safe margin|crosses/i.test(reason)) return "layout";
  if (/subtitle|caption band/i.test(reason)) return "subtitle";
  if (/typography|headline|label|line wrap|accent word/i.test(reason)) return "typography";
  return "composition";
};

/** Build the minimal repair plan from aggregated QA results. */
export function buildRepairPlan(
  scenes: SceneSpec[],
  visual: VisualQa,
  sop: SlopQa,
  novelty: NoveltyReport,
  conformance?: { scenes: { sceneId: string; overall: number; evidence: string[] }[] },
  semantic?: { scenes: { sceneId: string; semanticRelevance: number; visualStorytelling: number; evidenceCoverage: number; evidenceGaps: string[] }[] },
): RepairPlanItem[] {
  const plan = new Map<string, { reasons: string[]; category: RepairPlanItem["category"] }>();
  const add = (sceneId: string, category: RepairPlanItem["category"], ...reasons: string[]) => {
    if (!scenes.some((s) => s.sceneId === sceneId)) return;
    const entry = plan.get(sceneId) ?? { reasons: [], category };
    entry.reasons.push(...reasons);
    // semantic outranks other categories (root cause beats symptom)
    if (category === "semantic" || entry.reasons.length === 1) entry.category = category;
    plan.set(sceneId, entry);
  };

  // median-driven: one outlier evaluator cannot drag a scene into repair alone; the
  // relevance/clarity dims additionally require a low SCENE median so cross-session
  // judge swings on a single dim don't churn otherwise-good scenes.
  for (const s of visual.scenes) {
    const badScores =
      s.scores.aiSlopSeverity > QA.slopSeverityMax ||
      ((s.scores.scriptRelevance < 6 || s.scores.visualClarity < 6) && s.stats.median < 6.5) ||
      s.scores.typography < 6 ||
      s.scores.composition < 6 ||
      s.scores.designConsistency < 6;
    if (badScores || s.technicalCorrectness === "fail") {
      const cat = classify([...s.issues, ...s.recommendedRepair].join(" "));
      if (s.issues.length > 0) add(s.sceneId, cat, ...s.issues.slice(0, 3).map((i) => `vision: ${i}`));
      if (s.recommendedRepair.length > 0)
        add(s.sceneId, cat, ...s.recommendedRepair.slice(0, 3).map((r) => `vision fix: ${r}`));
      if (s.issues.length === 0) {
        add(s.sceneId, cat, `median scores below threshold: ${JSON.stringify(s.scores)} (confidence ${s.stats.confidence}, variance ${s.stats.variance})`);
      }
    }
  }
  // semantic QA drives ROOT-CAUSE repairs (storyboard regeneration) - Phase 3 §41.
  // Require BOTH low dims (or severe coverage failure): single-dim judge swings must not
  // mass-trigger storyboard regeneration (variance control).
  for (const s of semantic?.scenes ?? []) {
    const bothLow = s.semanticRelevance < 6 && s.visualStorytelling < 6;
    const coverageDead = s.evidenceCoverage < 3;
    if (bothLow || coverageDead) {
      add(
        s.sceneId,
        "semantic",
        `semantic: relevance ${s.semanticRelevance}, storytelling ${s.visualStorytelling}, coverage ${s.evidenceCoverage}${s.evidenceGaps.length ? `; gaps: ${s.evidenceGaps.join(", ")}` : ""}`,
      );
    }
  }
  for (const f of sop.findings.filter((f) => f.severity >= 5)) {
    add(f.sceneId, classify(f.evidence), `slop[${f.type}] ${f.severity}/10: ${f.evidence}`);
  }
  for (const r of novelty.results.filter((r) => r.verdict !== "accept")) {
    add(r.sceneId, "composition", `novelty ${r.verdict} (similarity ${r.similarity} vs ${r.against})`);
  }
  for (const c of (conformance?.scenes ?? []).filter(
    (c) =>
      c.overall < 6 ||
      c.evidence.some(
        (e) =>
          e.startsWith("COLLISION") ||
          e.startsWith("SUBTITLE_COLLISION") ||
          e.startsWith("TEXT_ONLY") ||
          e.startsWith("GENERIC"),
      ),
  )) {
    add(c.sceneId, classify(c.evidence.join(" ")), `reference conformance ${c.overall}/10: ${c.evidence.slice(0, 3).join("; ")}`);
  }
  return [...plan.entries()].map(([sceneId, v]) => ({ sceneId, reason: v.reasons.join("\n"), category: v.category }));
}

export function sceneBeat(
  sceneId: string,
  beats: { id: string; text: string; emphasisPhrase?: string }[],
): { id: string; text: string; emphasisPhrase?: string } {
  const idx = parseInt(sceneId.replace(/\D/g, ""), 10) - 1;
  return beats[Math.max(0, idx)] ?? beats[0] ?? { id: "b1", text: "" };
}

export function loadScene(projectId: string, sceneId: string): SceneSpec | null {
  return readJson<SceneSpec>(projectId, `scenes/${sceneId}.json`);
}
