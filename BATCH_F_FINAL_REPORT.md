# BATCH F FINAL REPORT — Semantic Contract Completion & Production Quality

Date: 2026-10-10
Repo: `motion-video` (working tree; nothing committed by this phase)
Scope: Batch F only. A deterministic semantic-contract reconciliation stage now runs between
scene composition and every stage that consumes the scenes; it repairs the exact live-run
defect (promised headline objects left unbound) with a binding-only micro-repair that never
spends a model call; the storyboard stage's resume path no longer re-pays validated
candidates+selection calls; and the two live-run root causes of the category-mismatch storm
(a placeholder `objectType` default and substring keyword matching) are fixed at the source.
No new primitives, no renderer redesign, no computer vision.

---

## 1. Status

**PASS** — every Phase requirement is satisfied.
The live integration criterion is met by a real `generateProject()` run on a **copy of the
Batch E live project** (`_batche_live` → `_batchf_live`): the two `headline_01` gaps that
hard-failed Batch E went **2 → 0**, the bindings persisted to disk, the run finalized
(`status=partial`, artifacts **consistent**, judges actually ran, `qa=fail` honestly) inside
its strict wall clock. Pipeline reliability, semantic-contract correctness, rendered visual
quality, latency and provider reliability are reported separately in §9.

---

## 2. Root causes confirmed from source code and evidence

| # | Symptom (live artifacts) | Root cause (source) | Fix |
|---|---|---|---|
| 1 | `missing_semantic_object headline_01` on `_batche_live` scene_01 + scene_04 (2 of 4 scenes hard-failed) | Storyboards promise `headline_01` as a semantic object and a motion beat targets it, but the composer renders the headline via `scene.headline`, whose schema (`headlineSchema`, `src/validation/schema.ts`) had **no `semanticId` field** — the binding was structurally impossible; `elementBySemanticId` only scanned `scene.elements` | `semanticId` added to `headlineSchema` (+ uniqueness seeded against element ids); `elementBySemanticId`/`stateForSemanticId`/`elementExecutionAt` resolve the bound headline; reconciliation stage binds it deterministically |
| 2 | 24 `category_mismatch` failures, every one reading `promised "person" ...` for slabs, drops, labels, stacks | `normalizeStoryboard` (src/agents/storyboard.ts) defaulted a missing `objectType` to **`"Actor"`**, and `"actor"` is a keyword in the `person` category — the expansion prompt never asked for `objectType`, so every object became a false person promise | Default changed to neutral `"object"` (maps to no category → honest `not_verified`); expansion prompt now requires a concrete physical `objectType` and forbids generic words |
| 3 | (latent, exposed by fix 2) `the disciplines must outlast` matched the `line` category via sub**string** | `matchCategory` (src/validation/semanticCategories.ts) used `t.includes(kw)` — `"disciplines".includes("line")` | Word-boundary matching; all pinned Batch E keyword verdicts (`castle gate`, `Time pressure`, `deadline`, `timeline`, `actor`) verified unchanged |
| 4 | Batch E attempts 1–4 died at `concepts`; every resume re-ran candidates+selection for the in-flight beat (3 calls/beat ≈ 2–4 min/beat) | `runStoryboardStage` persisted candidates/selections only at **stage end** (`concepts/storyboard-candidates.json`), so a mid-stage failure lost them | Per-beat validated-step cache (`concepts/beat-steps-<beatId>.json`) written immediately after each schema-valid step, keyed by an input hash |
| 5 | (design constraint) parallel beats could not help | Dependency analysis: beats ARE independent (each beat's storyboard depends only on analysis+beat+memory), **but** the global provider queue (`enqueueLlm`, src/agents/llm.ts) serializes every call (concurrency 1, 0.9–1.6 s gaps) — parallel dispatch cannot overlap HTTP and would only risk the 429/502 storms Batch E documented | Not implemented; documented with evidence (§6) |

The remaining live quality failures (thin content on scene_02, layout evidence disagreement on
scene_01, `event_not_executed` on tightly-packed scene_03/scene_04 beats) are composition
quality + budget-exhaustion effects already present in Batch E; they are **not** caused by the
semantic-ID layer and were not weakened or hidden (§10).

## 3. Exact files added and modified

### Added
| File | Purpose |
|---|---|
| `src/validation/semanticContract.ts` | Contract inspection + deterministic reconciliation (`inspectSemanticContract`, `headlineBindingTarget`, `reconcileSemanticContract`, `summarizeContract`, shared `requiredSemanticIds`) |
| `tests/semanticContract.test.ts` | 17 regressions: pass-without-model-call, missing detection, safe repair, unrelated elements untouched / never falsely bound, duplicates/invalid/unpromised/drift, rollback-without-corruption, superset, budget exhaustion, category-mismatch-still-fails |
| `tests/beatStepsCache.test.ts` | 11 regressions: beat-steps cache round-trip / stale-miss / direction rounds / corrupt-file miss; objectType neutral default + honest `not_verified`; person gate still fails Line (not weakened) |
| `e2e/batchF-semantic-contract.ts` | 37/37 — deterministic E2E with REAL still + project renders (reveal occupancy 0.0050→0.0287, frameDiff 0.0192) |
| `e2e/batchF-storyboard-latency.ts` | 6/6 — real-provider cold vs warm probe on the `_batche_live` 2-beat fixture with mechanical cache proof |
| `e2e/batchF-live-generation.ts` | 16/16 — bounded live `generateProject()` on a copy of `_batche_live` (deterministic pre-metric + full pipeline) |
| `e2e/batchF-live-attempts.json` | Cumulative live attempt ledger |
| `BATCH_F_FINAL_REPORT.md` | This report |

### Modified
| File | Change |
|---|---|
| `src/validation/schema.ts` | `headlineSchema.semanticId` (optional, ID regex); duplicate-id seed includes the headline binding |
| `src/scenes/execution.ts` | `headlineElementFor()` shared synthetic headline; `elementBySemanticId` resolves a bound headline; `elementExecutionAt` accepts `index === -1` (headline) so promised events execute on it |
| `src/scenes/state.ts` | `elementStateAt(-1)` / `stateForSemanticId` resolve the bound headline (state extraction mirrors the renderer) |
| `src/scenes/SceneRenderer.tsx` | Uses the shared `headlineElementFor`; isolation mode can isolate a headline-bound id; **unbound headlines render byte-identically** (Batch A sha unchanged) |
| `src/validation/semanticEnactment.ts` | `promisedIds` now built from the shared `requiredSemanticIds` — contract and gate can never disagree |
| `src/validation/repairContract.ts` | Semantic-mode superset check also requires the headline binding to survive a repair (requirement immutability extended) |
| `src/validation/semanticCategories.ts` | Word-boundary keyword matching (fixes `disciplines`→`line`; all pinned verdicts preserved) |
| `src/agents/pipeline.ts` | Reconciliation stage after scene composition (fresh **and** resume paths); writes `qa/semantic-contract.json`; persists KEEP repairs |
| `src/agents/legacyRepair.ts` | Reconciles recompiled candidates **before** validation, so a KEEP-worthy storyboard rewrite is not rolled back merely because the composer dropped the headline binding again |
| `src/agents/storyboard.ts` | Per-beat validated-step cache (`loadBeatSteps`/`saveBeatSteps`, input-hash keyed, rejected rounds cached); neutral `objectType` default; expansion prompt requires concrete `objectType` |
| `tests/fixtures/batchD.ts` | `headlineGapScene()` fixture (the live-run defect shape) |

## 4. Semantic-contract reconciliation design and safety guarantees

```
scene composition (fresh or resume)
  → reconcileSemanticContract(scene, authority=stage storyboard, budgetExhausted)
      1. required = storyboard semanticObject ids + promised event targets
         (SAME function the enactment gate uses — one source of truth)
      2. present  = element semanticIds + scene.headline.semanticId
      3. report   = missing / duplicates / invalid / unpromised / contract-drift,
                    machine-readable reasons, verdict
      4. if missing and eligible → ONE micro-repair:
         bind scene.headline.semanticId  (existing object, one field)
      5. re-validate candidate against the SAME schema
         KEEP | ROLLBACK (original bytes returned) | UNRESOLVED | SKIPPED_BUDGET
  → novelty → pre-render gates → render → QA (consumers see the completed scene)
```

**Headline-binding eligibility is triple-gated** — the missing id must (a) name a headline
(`/^headline(?:_|$)/i`), (b) be targeted by a promised motion beat whose action explicitly
mentions the headline, and (c) find exactly one candidate with an *unbound* existing
`scene.headline`, no duplicates, no conflicts, no contract drift. Anything ambiguous returns
`UNRESOLVED` with `code: no_unambiguous_existing_binding` — the stage never guesses.

Safety guarantees, each proven by a test in `tests/semanticContract.test.ts` or the E2E:
1. **No model call, ever.** The stage is pure and synchronous; a complete scene passes with
   `UNCHANGED` and zero budget interaction.
2. **No new visual object.** The repair only adds one field to the object that already exists
   (`scene.headline`); elements are byte-identical afterwards.
3. **No false assignment.** A missing `person_01` with an unrelated unbound element present is
   never bound to that element (`UNRESOLVED`, scene untouched).
4. **Authority preserved.** The storyboard bytes are never mutated; drift between the scene's
   embedded copy and the stage authority is itself a contract failure.
5. **Rollback without corruption.** A candidate failing re-validation returns the original
   scene byte-for-byte (`ROLLBACK`, errors recorded).
6. **No pass by attempt.** Verdict is recomputed from the post-repair contract; a remaining
   category mismatch still fails (`category_mismatch` after a KEEP is a tested case).
7. **Superset invariant.** `requiredIds ⊇ presentIds` is checked per scene and project-wide
   (`summarizeContract.supersetHolds`); unpromised bindings are conflicts, not silent extras.
8. **Budget honesty.** Exhaustion yields `SKIPPED_BUDGET` with `code: budget_exhausted` and
   the verdict stays `fail` — never upgraded.
9. **Downstream immutability.** The Batch C/D targeted-repair contract now also rejects any
   repair that drops the headline binding; legacy rewrites are reconciled *and* still must
   pass promise-preservation + no-new-semantic-failures before KEEP.

## 5. Before/after semantic-contract metrics (real comparable runs)

**Deterministic, on the REAL `_batche_live` scenes (no model call):**

| Metric | Before | After reconciliation |
|---|---|---|
| `missing_semantic_object` failures | 2 (`headline_01` on scene_01 + scene_04) | **0** |
| Scenes with contract verdict `pass` | 2/4 | **4/4** |
| `headline_01` bound on disk | 0 scenes | **2 scenes** (scene_01, scene_04) |
| Contract report `ok` / `supersetHolds` | n/a (stage did not exist) | **true / true** |

**Live pipeline (`_batchf_live`, real provider):** `qa/semantic-contract.json` decisions
`scene_01:KEEP scene_02:UNCHANGED scene_03:UNCHANGED scene_04:KEEP`; enactment after:
`missing_semantic_object` **2 → 0**; scene_01 events 7/10 → **8/10** (the bound reveal now
executes and passes: detected 1.05 s / promised 1.10 s), scene_04 events 2/8 → **3/8**.

**Rendered proof (deterministic E2E, real renders, not mocks):** with the binding in place
the promised `reveal headline_01` genuinely clips the headline in — pre-reveal occupancy
0.0050 → post-reveal 0.0287, frameDiff 0.0192, and the full deterministic contract passes
(enactment + layout + visual gates) on the repaired scene.

**Byte-identity guard:** Batch A render sha `cdb2e0c9b95c…` is **unchanged** — scenes without
a headline binding render identically; the execution path for an unbound headline still
returns `NEUTRAL_EXECUTION`.

## 6. Before/after latency (sample size and provider conditions)

**What was measured:** the resume path of the storyboard stage — the exact failure mode of
Batch E attempts 1–4 (die at `concepts`, resume, re-pay candidates+selection for the
in-flight beat). Fixture: the REAL `_batche_live` analysis + its first 2 beats (fixed input,
identical for both passes). Provider: `router-asli/oc/mimo-v2.6-flash-free`, live, n=1 per
condition, same session back-to-back.

| Pass | Provider calls | Calls/beat | Wall clock |
|---|---|---|---|
| COLD (empty cache) | 8 | 4.0 | 241.9 s |
| WARM (storyboard files deleted, beat-steps cache kept) | **4** | **2.0** | **151.0 s** |

- **Provider calls on the resume path halved (8 → 4, −50 %).** The candidates+selection
  calls were **mechanically proven skipped**: the cache files' mtime and round count are
  byte-unchanged between passes (asserted in the probe), so the warm pass spent its calls on
  expansion alone.
- Wall clock fell 37.6 % in the recorded pair. **Honest caveat:** an earlier probe pair under
  heavier provider load measured 447.6 s → 486.3 s (warm slower) with the same 8 → 4 call
  reduction — per-call latency on this free-tier provider ranges ~20–200 s, so wall-clock at
  n=1 is provider-variance-dominated. **The reliable, provider-independent metric is the call
  count: 4.0 → 2.0 calls/beat on resume.** Context from Batch E: storyboard stage ≈ 3
  calls/beat ≈ 2–4 min/beat; the `_batche_live` concepts stage ran 11:09:43 → 11:30:52
  (21.2 min for 4 beats).
- **Parallel beats: evaluated and rejected on evidence.** Beats are independent, but the
  global provider queue serializes every call (concurrency 1) — parallel dispatch cannot
  overlap HTTP and would only risk the 429/502 storms Batch E recorded. Smaller outputs were
  also evaluated: cutting `maxTokens` risks truncation retries that Batch E showed cost
  *more* (the 524/truncation handlers grow the cap back). Neither was implemented; the resume
  cache was the smallest option supported by the measured evidence.
- Cache safety: keyed by an input hash (beat id/text/why/emotion + analysis
  summary/nouns/verbs/concepts) — a different script or beat can never receive a stale hit
  (tested); only schema-validated steps are written; rejected rounds are cached too (same
  inputs deterministically reject again on resume).

## 7. Tests, typecheck, regression E2Es

```
npm run typecheck  →  EXIT 0 (clean)
npm run verify     →  EXIT 0
  Test Files  37 passed (37)
  Tests      409 passed | 1 skipped   (Batch E end state: 381 | 1 → +28 new)
```

New coverage (17 + 11): contract inspection determinism / gate-identical required set /
headline micro-repair KEEP / elements + storyboard byte-identical after repair / no false
binding of unrelated elements / headline-evidence and ambiguity refusals / duplicate +
invalid + unpromised + drift detection / ROLLBACK with bytes preserved / superset invariant /
budget exhaustion explicit / category mismatch still fails after repair / neutral objectType
default + `not_verified` / person gate still fails Line / cache round-trip + stale-miss +
corrupt-file miss + distinct-direction rounds.

**Regression E2E (all with real renders where they rendered before):**

| Run | Result |
|---|---|
| **Batch F `batchF-semantic-contract.ts`** | **PASS 37/37** (real stills + real project render) |
| **Batch F `batchF-storyboard-latency.ts`** | **PASS 6/6** (real provider, mechanical cache proof) |
| **Batch F `batchF-live-generation.ts`** | **PASS 16/16** (status=partial, headline gaps 2 → 0) |
| Batch A `batchA-e2e.ts` | **ALL CHECKS PASSED** — render sha `cdb2e0c9b95c…` **byte-identical** to the Batch A–E baseline |
| Batch B `batchB-gates.ts` | **PASS 30/30** |
| Batch C `batchC-repair.ts` | **PASS 27/27** (KEEP + ROLLBACK) |
| Batch C `batchC-consistency.ts` | **PASS** — `7b7545d96f2a` unchanged |
| Batch D `batchD-semantic.ts` | **PASS 42/42** (sha `1219c0d46ce3` unchanged) |
| Batch D `batchD-repair.ts` | **PASS 26/26** |
| Batch D provider probe | **PASS** — provider answered in 8610 ms, contract ACCEPTED |
| Batch E `batchE-visual-semantic.ts` | **PASS 36/36** (state/pixel/identity separation intact) |

## 8. Live generation status

One attempt on `_batchf_live` (a fresh copy of `_batche_live`; Batch E evidence untouched;
same fixed script + `e2e/demo-voice.wav`; budget 18 min; resume reusing cached analysis,
beats, storyboards and scenes):

| Field | Value |
|---|---|
| Status | **partial** (finalized: consistent artifacts, judges ran, QA verdict unchanged) |
| Elapsed | 1105.3 s / 1080 s budget (+ finalization slack) |
| Attempts | 1 (recorded in `e2e/batchF-live-attempts.json`) |
| Provider | 16 calls, 1022.7 s total (avg 63.9 s), 1 timeout, 1 budget refusal |
| Reconciliation | pre-pipeline deterministic metric: scene_01 KEEP, scene_04 KEEP; pipeline: 2 KEEP, 2 UNCHANGED; `qa/semantic-contract.json` ok=true, supersetHolds=true |
| Semantic gate | `missing_semantic_object` **2 → 0**; bindings persisted on disk |
| Final QA verdict | **fail** (honest — thin content on scene_02, layout-evidence disagreement on scene_01, category mismatches from the *stored* pre-fix storyboards, budget cut repair rounds) |
| Artifact consistency | **consistent** (render `53cd38de33be`, QA bound to it, final copied) |
| Repair | targeted 5 calls (kept none within budget); legacy storyboard/scene repairs ERROR → SKIPPED_BUDGET → structured stop before re-render |

**Bounded execution vs quality, reported separately:** the run demonstrates *pipeline
reliability* (bounded, structured, consistent, honest `qa=fail`) and *semantic-contract
correctness* (2 → 0, superset holds) — it does **not** claim the video is good, and the
`qa=fail` verdict was never upgraded by skipping work.

## 9. The five concepts, separated

- **Pipeline reliability:** PASS — every path bounded (wall clock, call cap, retry cap,
  legacy cap); exhaustion yields structured `partial`/`failed` with full timelines; artifact
  consistency held in every run (deterministic E2E, latency probe, live run, all regressions).
- **Semantic contract correctness:** PASS — the contract/gate share one required-id source;
  the live-run defect (2 unbound headlines) is repaired deterministically with rollback,
  superset and no-false-pass guarantees; 17 unit + 37 E2E checks green.
- **Rendered visual quality:** UNCHANGED where it was and honestly `fail` on the live run —
  Batch A render sha byte-identical; the new binding produces *real* pixel change (measured
  reveal); remaining live quality failures are the pre-existing composition issues (thin
  content, layout disagreements, category mismatches on stored pre-fix storyboards), not
  regressions and not hidden.
- **Latency/performance:** resume-path storyboard cost halved (4.0 → 2.0 provider
  calls/beat, mechanically proven); wall clock improved in the recorded pair but is
  provider-variance-dominated at n=1 — no wall-clock speedup is claimed as reliable.
- **Provider reliability:** outside our control; the run survived 1 timeout + 1 stall with
  bounded retries and honest artifacts. An environment incident was also found and fixed:
  the global `opencode.jsonc` had acquired a UTF-8 BOM that made `JSON.parse` (and therefore
  LLM resolution) fail — the BOM was stripped, resolution re-verified, and the provider probe
  re-run PASS. The user-requested model `bansos/cx/gpt-6.1-sol` is registered under
  `router-asli` (restart opencode to load it).

## 10. Remaining failures and limitations

1. **`_batchf_live` final QA verdict is `fail`** (thin content scene_02, layout-evidence
   disagreement scene_01, category mismatches, `event_not_executed` on tightly-packed
   scene_03/04 beats) — the same composition-quality ceiling Batch E reported; the repair
   rounds were cut by the wall clock. Not weakened, not hidden.
2. **Stored pre-fix storyboards keep `objectType: "Actor"`** — reconciliation never rewrites
   the authoritative contract, so those objects still honestly fail the category gate
   (`Actor`→person). The neutral default + prompt fix applies to **new** generations; the
   live run's remaining category mismatches are stored-data artifacts, correctly surfaced.
3. **The deterministic micro-repair handles exactly one shape** (unbound scene.headline with
   headline-beat evidence). Other missing-id shapes stay `UNRESOLVED` and fall through to the
   existing budgeted `missing_semantic_object → addElement` repair — by design (never guess).
4. **Keyword matching is word-boundary, still English-keyword-based** — new primitives still
   need `semantic-categories.json` entries (enforced by `semanticCategoryErrors()`).
5. **Beat-steps cache lives only within a project** (`concepts/beat-steps-<beatId>.json`) and
   is invalidated by any input change; it does not shorten a *fresh* run (3 calls/beat remain
   there) — its win is the resume path, which is where Batch E actually bled.
6. **Latency wall clock at n=1 is not a reliable claim** — provider per-call latency varied
   20–200 s across passes; only the call-count reduction is asserted as reliable.
7. **No concurrency was added** — the global provider queue makes parallel beats
   wall-clock-neutral by construction; changing it was rejected on provider-stability
   evidence (Batch E 429/502 history).
8. **`transform`/morph events remain unsupported** (Batch D decision, unchanged).

## 11. Commands actually executed (exit codes)

```
npx tsc --noEmit                                   EXIT 0 (clean, re-run after every change)
npm run verify                                     EXIT 0 (37 files, 409 passed | 1 skipped)
npx vitest run tests/semanticContract.test.ts      EXIT 0 (17)
npx vitest run tests/beatStepsCache.test.ts        EXIT 0 (11)
npx tsx e2e/batchF-semantic-contract.ts            EXIT 0 (37/37, real renders)
npx tsx e2e/batchF-storyboard-latency.ts           EXIT 0 (6/6, real provider; 1 earlier run EXIT 1 — assertion fixed, see §6)
npx tsx e2e/batchF-live-generation.ts              EXIT 0 (16/16, status=partial)
npx tsx e2e/batchA-e2e.ts                          EXIT 0 (sha cdb2e0c9b95c… unchanged)
npx tsx e2e/batchB-gates.ts                        EXIT 0 (30/30)
npx tsx e2e/batchC-repair.ts                       EXIT 0 (27/27)
npx tsx e2e/batchC-consistency.ts                  EXIT 0 (consistent, 7b7545d96f2a)
npx tsx e2e/batchD-semantic.ts                     EXIT 0 (42/42)
npx tsx e2e/batchD-repair.ts                       EXIT 0 (26/26)
npx tsx e2e/batchD-provider-probe.ts               EXIT 0 (PASS after BOM fix; first run EXIT 1 — BOM in opencode.jsonc)
npx tsx e2e/batchE-visual-semantic.ts              EXIT 0 (36/36)
```

## NOT RUN (explicitly)

- `e2e/batchA-pipeline.ts` — full fresh `generateProject()` with all stages; superseded by
  `batchF-live-generation.ts`, which exercises the identical pipeline path (analysis → … →
  QA) on a real provider with a stricter, better-instrumented contract.
- `e2e/batchE-live-generation.ts` — deliberately **not** re-run: it resumes `_batche_live`
  itself and would mutate Batch E's evidence project. `batchF-live-generation.ts` runs the
  same pipeline on a **copy** (`_batchf_live`), preserving the Batch E artifacts byte-for-byte.
- No second latency sample (n>1 per condition) — provider call budget; the call-count metric
  is deterministic and does not need repeats, and the wall-clock caveat is documented (§6).

**STOP — Batch F complete. Batch G not started.**
