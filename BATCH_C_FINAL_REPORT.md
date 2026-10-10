# BATCH C FINAL REPORT — Evidence-Driven Repair Loop

Date: 2026-10-09
Repo: `motion-video` (working tree; nothing committed by this phase)
Scope: Batch C only (no Batch D semantic enactment, no execution-plan engine, no renderer rewrite)

---

## Status

**PASS** (with one explicitly-not-run item: the full `generateProject()` live integration run — see *Known limitations*).

All Batch C objectives were implemented, unit-tested, E2E-tested with a scripted provider, and
regression-tested against Batch A + Batch B.

---

## Files changed

### New source files (Batch C)
| File | Purpose |
|---|---|
| `src/agents/repairContext.ts` | formal `RepairContext` + deterministic failure classification (priority-ordered) + compact prompt block |
| `src/validation/repairContract.ts` | `repairProposalSchema`, per-failure **allow-list**, `validateRepairProposal`, `applyRepairProposal` |
| `src/agents/repairCompare.ts` | metric-vector construction + `compareRepair` (KEEP / ROLLBACK / REJECT) |
| `src/agents/repairProviders.ts` | `llmRepairProvider` (small prompt) + `scriptedRepairProvider` (test/E2E seam) |
| `src/agents/repairLoop.ts` | `runTargetedRepair`: snapshot → propose → validate → apply → measure → compare → keep/rollback, budget, ledger |
| `src/validation/preRenderGate.ts` | model-only gate that runs BEFORE the first render |
| `src/validation/collisionSemantics.ts` | intentional vs unintentional overlap classification |
| `src/validation/repairContract.ts` | structured repair contract (schema + allow-list + narrowness proof) |

> `repairContract` lives in `src/validation/` (it validates scene JSON like the other validators);
> `repairContext`, `repairCompare`, `repairProviders`, `repairLoop` live in `src/agents/`.

### Modified files
| File | Change |
|---|---|
| `design-system/primitives.json` | added common element param `collisionIntent: enum(none, intentional)` (schema-only; renderer ignores it) |
| `src/scenes/rendererGeometry.ts` | plumbs `collisionIntent` through flow items → item geometry |
| `src/agents/pipeline.ts` | `GenerateOptions.fixture` (novelty provenance); **pre-render gate + constrained repair before the first render**; deterministic targeted repair at the start of each repair round; shared `RepairBudgetTracker`; `maxRounds = min(PIPELINE.repairRoundsMax, REPAIR_BUDGET.maxRounds)`; plan skips scenes already repaired from measured evidence |
| `src/agents/novelty.ts` | `NoveltyOptions.excludeProjects` (fixture provenance only; thresholds/production comparisons untouched) |
| `src/core/diagnostics.ts` | `gates.preRender` + `repairs` (ledger rows: decision, hashes, evidence before/after, comparison, elapsed, budget) |
| `e2e/batchA-pipeline.ts` | passes `fixture: { copiedFrom }` (the fix for the observed >11 min novelty/repair stall) |

### New tests (7 files, 61 tests)
`tests/repairContext.test.ts` (10) · `tests/collisionSemantics.test.ts` (6) ·
`tests/preRenderGate.test.ts` (6) · `tests/repairContract.test.ts` (13) ·
`tests/repairCompare.test.ts` (12) · `tests/repairLoop.test.ts` (9) · `tests/noveltyFixture.test.ts` (5)

### New E2E scripts
`e2e/batchC-repair.ts` (lifecycle) · `e2e/batchC-provider-probe.ts` (live, timeboxed) ·
`e2e/batchC-consistency.ts` (artifact identity across all fixtures)

---

## Repair architecture

```
GENERATE
  └─ novelty gate (fixture provenance = skip only the copied-from project)
      ↓
PRE-GATE  evaluatePreRenderGate(scenes)          [model-only, measures real text first]
  ├─ hard? → classifyFailures → runTargetedRepair (scripted/llm provider, budgeted)
  │            snapshot → propose → contract-validate → apply → re-gate → KEEP/ROLLBACK
  ├─ record qa/pre-render-gate.json
  └─ proceed to render regardless (rendered pixels stay the final authority)
      ↓
SNAPSHOT   createSnapshotUnique(`round-N-baseline`) before any round mutates state
      ↓
RENDER     renderWithProgress → recordRender (sha256 + scenesHash)
      ↓
EVIDENCE   collectFrameEvidence (early/mid/late + metrics) → layout/visual/pre-render gates
      ↓
LLM QA/JUDGE when appropriate (vision 3-judge + issues + slop + semantic) — Batch A/B behaviour
      ↓
FAILURE CLASSIFICATION  classifyFailures (priority: layout > visual > collision > timing > judge > slop)
      ↓
TARGETED REPAIR (deterministic failures first, model-only measurement, shared call budget)
  + legacy full-scene repair for judge/semantic failures (Batch A/B path, unchanged)
      ↓
PRE-RENDER VALIDATION of the candidate (contract + gates) before anything is written permanently
      ↓
RENDER → QA → COMPARE (metric vectors) → KEEP or ROLLBACK (restoreSnapshot = exact baseline)
      ↓
ledger: qa/repair-ledger.json  +  diagnostics.repairs
```

**Who decides what:** AI proposes (`changes[]`) · code proves narrowness (`validateRepairProposal`) ·
evidence decides whether it worked (`compareRepair` on metric vectors) · rendered pixels stay
authoritative for clipping.

---

## Failure classification

Finite, explicit types (`FailureType`), priority-ordered (`FAILURE_PRIORITY`):

| # | type | source | severity rules |
|---|---|---|---|
| 1 | `layout_clip` | deterministic-layout | hard when model overflow ≥ **8px** or rendered edge-ink ≥ **10px** |
| 2 | `safe_area_overflow` | deterministic-layout | hard when ≥ **48px** (unchanged Batch B threshold), else warning |
| 3 | `empty_visual_band` | deterministic-visual | hard (needs pixel evidence — never predicted pre-render) |
| 4 | `unreadable_text` | deterministic-visual | hard (bright-share floor 0.3%, text painted < 20px) |
| 5 | `unintended_collision` | deterministic-collision | hard when ratio ≥ 0.5, else warning; **intentional overlaps never classified as failures** |
| 6 | `timing_issue` | deterministic-timing | hard |
| 7 | `novelty_fixture` | novelty | — |
| 8 | `judge_issue` | judge / slop | warning (never outranks deterministic evidence) |
| 9 | `unknown` | fallback | warning |

Each failure carries `sceneId`, `evidence` (measurements only), `target[]` (renderer ids),
`region[]`, `magnitude`. The prompt receives only the primary failure per scene
(`primaryFailurePerScene`) plus `allowedProperties`, `preserve` and the baseline snapshot id.

---

## Collision semantics

Detection = Batch B renderer-aware geometry (one model, no second approximation), threshold
calibrated on conformance (0.2; 0.6 for thin items).

| Case | Verdict | Rationale |
|---|---|---|
| either element declares `collisionIntent: "intentional"` | **INTENTIONAL** | explicit design intent |
| object × object (no text) | **INTENTIONAL** | layering is a design device, never harms text readability |
| text × object, cross-anchor | **UNINTENTIONAL** | readability risk |
| same-anchor paint overlap | **UNINTENTIONAL** | the renderer stacks same-anchor items, so overlap means a transform spilled into its neighbour |
| caption band overlap (existing 0.35 threshold) | **UNINTENTIONAL, hard** | objective caption readability |

Only UNINTENTIONAL collisions may become failures. **No "zero-overlap" universal rule was added.**
The renderer was not modified; `collisionIntent` is an optional schema param only.

---

## Repair budget (exact limits)

```ts
REPAIR_BUDGET = { maxAttemptsPerScene: 2, maxRounds: 3, maxCallsTotal: 6, callTimeoutMs: 120_000 }
```

- one shared `RepairBudgetTracker` per generation (pre-render phase + every repair round);
- pipeline rounds = `min(PIPELINE.repairRoundsMax=2, REPAIR_BUDGET.maxRounds=3)` → **2**;
- **no** second identical prompt (sha256 of prompt persisted in the ledger and seeded across runs);
- **no** retry after a decision on unchanged evidence;
- deterministic validation runs between every attempt;
- provider failures (timeout / malformed / contract violation) never corrupt the baseline;
- exhausting the budget produces a structured `SKIPPED` ledger row, not an infinite loop.

---

## Keep/Rollback policy

Metric vector compared (`compareRepair`), missing fields excluded from BOTH sides so a
pre-render candidate can never win by having no pixels:

`hardKeys · hardFailures · targetSeverity · safeAreaOverflowPx · frameEdgeInk ·
layoutDisagreements · visualGateFails · unintendedCollisions · timingViolations · artifactConsistent`

1. `!artifactConsistent` → **ROLLBACK**
2. new hard failure key, or hard count increased → **ROLLBACK**
3. target severity increased → **ROLLBACK**; unchanged → **REJECT**
4. unrelated numeric sum regressed → **ROLLBACK**
5. otherwise → **KEEP**

Rollback = `restoreSnapshot()` → exact baseline bytes restored (verified by hash in tests and E2E).

---

## Tests

```
npm run verify   →  EXIT 0
Test Files  28 passed (28)
Tests      261 passed | 1 skipped  (Batch B end state: 200 passed | 1 skipped  →  +61 new)
typecheck clean
```

Coverage of the required list: failure classification + priority · compact evidence (block < 900
chars, no JSON dump) · affected scene/object · allow-list accepted · forbidden property rejected ·
malformed rejected · unrelated element rejected · value range rejected · no-op rejected ·
duration/motion/storyboard changes rejected · new-hard-failure candidate rejected · intentional
overlap accepted · unintended overlap rejected · pre-render gate blocks clip / lets valid proceed /
never predicts pixel-only problems · KEEP / ROLLBACK(worse) / REJECT(unchanged) / ROLLBACK(new hard)
· per-scene attempt cap + total budget + no infinite retry + duplicate prompt refused + timeout
· fixture provenance skips only the source project while production still rejects copies
(threshold `noveltySimilarityMax = 70` asserted unchanged) · Batch A/B suites still green.

---

## E2E

| Run | Command | Result |
|---|---|---|
| Batch A regression | `npx tsx e2e\batchA-e2e.ts` | **PASS** — ALL CHECKS PASSED, render sha `cdb2e0c9b95c…` (byte-identical to Batch A/B: renderer untouched) |
| Batch B regression | `npx tsx e2e\batchB-gates.ts` | **PASS** — 30/30 checks (layout hard 3, visual hard 1, timing aligned 3/6) |
| **Batch C** | `npx tsx e2e\batchC-repair.ts` | **PASS — 27/27 checks, exit 0** |
| Artifact identity | `npx tsx e2e\batchC-consistency.ts` | **PASS** — `_batcha_e2e`, `_batchc_e2e`, `_batchc_e2e_rb` all `consistent=true` |

Batch C E2E evidence (real renders, scripted provider):

```
pre-render gate: BLOCK 4 hard / 2 warnings
classified: scene_03/layout_clip target=WordReveal[0]("YES...")
baseline snapshot c-keep-baseline (scenesHash d9d1387c47e3)
KEEP:  baseline scene_03 edgeInk=419 safeOvf=86
       candidate scene_03 edgeInk=0   safeOvf=32
comparison: baseline: hard=5 targetOverflow=38 edgeInk=419
            candidate: hard=1 targetOverflow=0 edgeInk=0
            decision: KEEP (improved: target 38 -> 0; hard 5 -> 1)
artifact identity consistent after KEEP; final.mp4 == candidate render (7b7545d96f2a)
diagnostics: scene_03:KEEP, evidenceBefore/After, pre-render gate hard=4, baseline restorable
ROLLBACK fixture: decision=ROLLBACK ("introduces new hard failure(s): scene_03:layout_clip, …")
                 baseline restored byte-for-byte, scale reverted 2.9 → 2.2, snapshot r1-scene_03
```

---

## Live provider probe

**PASS** — `npx tsx e2e\batchC-provider-probe.ts`

```
prompt chars=1923 lines=25          (compact: context + scene digest + output contract)
failure=layout_clip target=WordReveal[0]("YES...")
evidence=model overflow 38px past the right frame edge after transform
provider responded in 10437ms
proposal={"sceneId":"scene_03",...,"changes":[{"target":"elements:0","property":"scale","from":2.2,"to":1.9}],...}
contract validation: ACCEPTED
```

Timeboxed at 90s; the real provider accepted the compact prompt and the contract accepted the
proposal. (The model chose `1.9` rather than a fully-clearing value — the compare step, not the
model, is what would decide KEEP/ROLLBACK against pixel evidence.)

---

## Known limitations

1. **Full `generateProject()` live integration NOT RUN in Batch C.** The pre-render gate, targeted
   repair, budget and fixture provenance are wired into the pipeline and unit-tested, but one live
   end-to-end generation was not executed (bounded by the §20 rule: do not make Batch C depend on a
   long live provider run). Prior evidence: `repairScene` ≈ 59s/call, full run stalls >11 min.
2. **Legacy full-scene repair is outside `RepairBudgetTracker`.** It stays bounded by
   rounds ≤ 2 × plan ≤ 6 and does not recurse, but its calls are not counted by `maxCallsTotal`,
   and its prompts are not covered by the duplicate-prompt guard (they differ per round by
   construction — new QA evidence each round).
3. **High-ratio unintended collisions are model-only** until a render exists. The Batch B audit
   showed the model's headline ink box can be wider than the rendered glyphs, so scene_02-class
   findings may be model false positives; cost is bounded (budget) and pixels arbitrate after the
   render. A pixel-corrobed collision detector needs object-level segmentation (Batch D+).
4. **A partially-fixed target can KEEP while a residual violation remains** (the comparison
   requires *improvement*, not perfection); the residual stays in `hardKeys` and is visible in the
   ledger/`hard` count, so the next round re-attacks it.
5. **`OBJECT_BOX_APPROX` unchanged** (Clock/Calendar/Target/diagrams remain approximate) — per
  §18; repaired scenes with those primitives rely on the rendered-evidence cross-check.
6. **48px severe safe-area threshold unchanged** — per §19; the calibration test
   (`mild → warning`, `severe → hard`) exists in `tests/layoutGate.test.ts`, no new project data
   was gathered this batch.
7. **No thresholds lowered.** Verified unchanged: `modelFrameClipPx 8`, `renderedFrameClipInk 10`,
   `safeAreaSeverePx 48`, `bandOccupancyFloor 0.005`, `brightShareFloor 0.003`,
   `unreadableTextPx 20`, `overallQualityMin 8`, `slopSeverityMax 6`, `noveltySimilarityMax 70`.

---

## Batch D blockers

1. **Semantic/storyboard repair still uses the legacy full-scene path** (`regenerateStoryboard` +
   `runSceneGeneration`) — not evidence-classified, not budget-tracked, no keep/rollback. Batch D
   must route semantic failures through the same contract (or extend it) before enacting meaning.
2. **No per-step state model** — `motionBeats[].atSeconds` is still unused, so a failure can only
   be expressed as "the frame is wrong", not "step 3 never happened". The execution plan is a
   precondition for detecting enactment failures deterministically.
3. **Collision intent is declaration-only** — there is no layout primitive for *attachment*
   (`attachTo` / parent-child), so intentional overlaps must be declared rather than expressed.
   Needed before any relationship-aware collision work.
4. **Judge evidence is compact but unverified at scale** — the probe proved one call; no evidence
   that 3 evaluators + issues + slop tolerate the added block in a full run.
5. **Repair latency** (59s+/call) still caps how many rounds an autonomous loop can afford;
   prompt economy for the legacy path is untouched.

---

## Commands executed

```
npx tsc --noEmit
npm run verify
npx vitest run tests/{repairContext,collisionSemantics,preRenderGate,repairContract,repairCompare,repairLoop,noveltyFixture}.test.ts
npx tsx e2e\batchC-repair.ts
npx tsx e2e\batchC-provider-probe.ts
npx tsx e2e\batchC-consistency.ts
npx tsx e2e\batchA-e2e.ts
npx tsx e2e\batchB-gates.ts
```

**STOP — Batch C complete. Batch D not started.**
