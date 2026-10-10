import { promisedEventSchedule } from "./executionPlan";
import { validateScene } from "./validate";
import type { SceneSpec } from "./schema";
import type { Storyboard } from "./storyboardSchema";

/**
 * SEMANTIC-CONTRACT RECONCILIATION (Batch F / Â§1).
 *
 * Deterministic stage between scene composition and the next stage that consumes the
 * completed scene (novelty -> enactment gate -> render -> QA):
 *
 *   1. extract the REQUIRED semantic ids from the authoritative storyboard
 *      (semanticObjects ids + promised event targets - the same set the enactment gate
 *      derives, so contract and gate can never disagree),
 *   2. inspect the composed scene for PRESENT ids (elements + the existing scene.headline
 *      binding) -> missing / duplicate / invalid / unpromised,
 *   3. if anything is missing, attempt ONE narrowly scoped micro-repair: bind the existing
 *      `scene.headline` when (and only when) the contract proves that headline IS the
 *      unbound object (id looks like a headline AND a promised motion beat targets it with
 *      a headline action). No new visual object, no element re-assignment, no model call,
 *      no storyboard change - a single field on the object that already exists,
 *   4. re-validate the candidate against the SAME contract (+ schema). A candidate that
 *      fails validation is discarded (ROLLBACK) - the original scene stays untouched,
 *   5. return a machine-readable report: required / present / missing / duplicates /
 *      conflicting bindings / verdict / reasons. Anything unresolved stays FAIL - a pass
 *      is never claimed because a repair was attempted.
 *
 * The stage is pure and synchronous: when the contract already holds it cannot spend an
 * LLM call (the budget is only consulted to label unresolved failures honestly when the
 * generation deadline has passed - the downstream LLM repair path will not run then).
 */

export type ReconcileDecision =
  | "UNCHANGED" // contract already complete - nothing touched
  | "KEEP" // micro-repair applied and re-validated
  | "ROLLBACK" // candidate failed re-validation - original scene preserved
  | "UNRESOLVED" // missing ids with no unambiguous existing binding
  | "SKIPPED_BUDGET"; // missing ids remain and the generation deadline has passed

export interface ContractReason {
  /** machine-readable failure code */
  code:
    | "missing_semantic_id"
    | "duplicate_semantic_id"
    | "invalid_semantic_id"
    | "unpromised_semantic_id"
    | "authoritative_contract_changed";
  id: string;
}

export interface UnresolvedMissing {
  id: string;
  code: "no_unambiguous_existing_binding" | "budget_exhausted";
}

export interface SemanticContractReport {
  schema: "semantic-contract/1";
  sceneId: string;
  contractActive: boolean;
  requiredIds: string[];
  presentIds: string[];
  missingIds: string[];
  duplicateIds: string[];
  /** unpromised present ids + invalid ids + contract drift (all reported as conflicts) */
  conflictingBindings: string[];
  reasons: ContractReason[];
  verdict: "pass" | "fail";
  decision: ReconcileDecision;
  /** validation errors that forced a ROLLBACK (empty otherwise) */
  repairErrors: string[];
  /** ids that are still missing after the micro-repair attempt */
  unresolved: UnresolvedMissing[];
  budgetExhausted: boolean;
}

export interface ReconcileResult {
  scene: SceneSpec;
  report: SemanticContractReport;
}

/** Required ids = storyboard semanticObject ids + promised event targets (gate-identical). */
export function requiredSemanticIds(scene: SceneSpec): string[] {
  const objects = (scene.storyboard?.semanticObjects ?? [])
    .map((o) => o.id)
    .filter((id): id is string => Boolean(id));
  const targets = promisedEventSchedule(scene)
    .map((p) => p.target)
    .filter((t): t is string => Boolean(t));
  return [...new Set([...objects, ...targets])].sort();
}

const ID_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface ContractInspection {
  sceneId: string;
  contractActive: boolean;
  requiredIds: string[];
  presentIds: string[];
  missingIds: string[];
  duplicateIds: string[];
  conflictingBindings: string[];
  reasons: ContractReason[];
  verdict: "pass" | "fail";
}

/**
 * Deterministic contract inspection (pure). `authority` is the authoritative storyboard;
 * when it differs from the scene's embedded copy the drift itself is a contract failure
 * (a scene can never silently redefine what it is judged against).
 */
export function inspectSemanticContract(
  scene: SceneSpec,
  authority: Storyboard | undefined = scene.storyboard,
): ContractInspection {
  const required = requiredSemanticIds({ ...scene, storyboard: authority });
  const bindings: string[] = [];
  for (const el of scene.elements ?? []) {
    const id = (el as { semanticId?: string }).semanticId;
    if (typeof id === "string" && id) bindings.push(id);
  }
  if (scene.headline?.semanticId) bindings.push(scene.headline.semanticId);

  const present = [...new Set(bindings)].sort();
  const missing = required.filter((id) => !present.includes(id));
  const duplicates = present.filter((id) => bindings.filter((b) => b === id).length > 1);
  const invalid = present.filter((id) => !ID_RE.test(id));
  const unpromised = required.length > 0 ? present.filter((id) => !required.includes(id)) : [];
  const contractChanged =
    JSON.stringify(scene.storyboard ?? null) !== JSON.stringify(authority ?? null);

  const reasons: ContractReason[] = [
    ...missing.map((id) => ({ code: "missing_semantic_id" as const, id })),
    ...duplicates.map((id) => ({ code: "duplicate_semantic_id" as const, id })),
    ...invalid.map((id) => ({ code: "invalid_semantic_id" as const, id })),
    ...unpromised.map((id) => ({ code: "unpromised_semantic_id" as const, id })),
    ...(contractChanged
      ? [{ code: "authoritative_contract_changed" as const, id: "storyboard" }]
      : []),
  ];
  const contractActive = required.length > 0;
  return {
    sceneId: scene.sceneId,
    contractActive,
    requiredIds: required,
    presentIds: present,
    missingIds: missing,
    duplicateIds: duplicates,
    conflictingBindings: [...new Set([...invalid, ...unpromised, ...(contractChanged ? ["storyboard"] : [])])],
    reasons,
    verdict: reasons.length === 0 ? "pass" : "fail",
  };
}

/**
 * Headline-binding eligibility (the ONLY deterministic micro-repair):
 *   - exactly one missing id that names a headline (`headline`, `headline_01`, ...),
 *   - the authoritative storyboard has a motion beat targeting that id whose action
 *     explicitly mentions the headline (the beat proves the id IS the scene headline,
 *     not merely that the name looks similar),
 *   - the scene HAS a headline and it is not already bound,
 *   - no duplicates / conflicts / contract drift (anything ambiguous -> explicit failure).
 */
export function headlineBindingTarget(
  scene: SceneSpec,
  authority: Storyboard | undefined,
  missing: string[],
): string | null {
  const candidates = missing.filter(
    (id) =>
      /^headline(?:_|$)/i.test(id) &&
      Boolean(
        authority?.motionBeats.some(
          (b) => b.target === id && /\bheadline\b/i.test(b.action ?? ""),
        ),
      ),
  );
  if (candidates.length !== 1) return null;
  if (!scene.headline || scene.headline.semanticId) return null;
  return candidates[0];
}

/**
 * Reconcile one scene against its authoritative storyboard. Deterministic and pure:
 * the same inputs always produce the same scene + report, and the input scene is never
 * mutated (the candidate is a fresh object, discarded on any validation failure).
 */
export function reconcileSemanticContract(
  scene: SceneSpec,
  authority: Storyboard | undefined = scene.storyboard,
  budgetExhausted = false,
): ReconcileResult {
  const before = inspectSemanticContract(scene, authority);
  if (before.verdict === "pass") {
    return { scene, report: report(before, "UNCHANGED", [], [], budgetExhausted) };
  }

  const bindId = before.missingIds.length > 0 ? headlineBindingTarget(scene, authority, before.missingIds) : null;
  // structural contract failures (duplicates / drift) block the repair entirely
  const structural = before.reasons.some(
    (r) => r.code !== "missing_semantic_id" && r.code !== "unpromised_semantic_id",
  );

  if (bindId && !structural) {
    const candidate: SceneSpec = {
      ...scene,
      headline: { ...scene.headline!, semanticId: bindId },
    };
    const validation = validateScene(candidate, scene.sceneId);
    if (validation.success) {
      const after = inspectSemanticContract(candidate, authority);
      return {
        scene: candidate,
        report: report(after, "KEEP", [], after.missingIds.map((id) => unresolved(id, budgetExhausted)), budgetExhausted),
      };
    }
    // ROLLBACK: the original scene object is returned untouched
    return {
      scene,
      report: report(before, "ROLLBACK", validation.errors, before.missingIds.map((id) => unresolved(id, budgetExhausted)), budgetExhausted),
    };
  }

  const decision: ReconcileDecision = budgetExhausted ? "SKIPPED_BUDGET" : "UNRESOLVED";
  return {
    scene,
    report: report(before, decision, [], before.missingIds.map((id) => unresolved(id, budgetExhausted)), budgetExhausted),
  };
}

const unresolved = (id: string, budgetExhausted: boolean): UnresolvedMissing => ({
  id,
  code: budgetExhausted ? "budget_exhausted" : "no_unambiguous_existing_binding",
});

function report(
  inspection: ContractInspection,
  decision: ReconcileDecision,
  repairErrors: string[],
  unresolved: UnresolvedMissing[],
  budgetExhausted: boolean,
): SemanticContractReport {
  return {
    schema: "semantic-contract/1",
    sceneId: inspection.sceneId,
    contractActive: inspection.contractActive,
    requiredIds: inspection.requiredIds,
    presentIds: inspection.presentIds,
    missingIds: inspection.missingIds,
    duplicateIds: inspection.duplicateIds,
    conflictingBindings: inspection.conflictingBindings,
    reasons: inspection.reasons,
    verdict: inspection.verdict,
    decision,
    repairErrors,
    unresolved,
    budgetExhausted,
  };
}

/** Batch-level rollup written to qa/semantic-contract.json. */
export interface ProjectContractReport {
  schema: "semantic-contract/1";
  ok: boolean;
  scenes: SemanticContractReport[];
  /** required(pipeline) âŠ‡ present, scene by scene - the Batch F superset invariant */
  supersetHolds: boolean;
}

export function summarizeContract(results: ReconcileResult[]): ProjectContractReport {
  const scenes = results.map((r) => r.report);
  return {
    schema: "semantic-contract/1",
    ok: scenes.every((s) => s.verdict === "pass"),
    scenes,
    supersetHolds: scenes.every(
      (s) => s.contractActive === false || s.presentIds.every((id) => s.requiredIds.includes(id)),
    ),
  };
}
