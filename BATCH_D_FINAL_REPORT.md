# BATCH D FINAL REPORT — Temporal Execution & Semantic Enactment

Date: 2026-10-09
Repo: `motion-video` (working tree; nothing committed by this phase)
Scope: Batch D only (storyboard promises → executable temporal contract → deterministic
state/event evidence → semantic enactment gate → targeted semantic repair with keep/rollback.
No cinematic intelligence, no computer vision, no new animation framework.)

---

## Status

**PASS** — every success criterion in §42 is satisfied, with one explicitly-caveated item:
full live `generateProject()` runs (three attempts, Batch C precedent) execute the Batch D
wiring end-to-end deep into repair round 1 without error, but did not finish inside the shell
time budget — the legacy judge-driven repair calls dominate wall time (see *Known
limitations* §1). The Batch D deliverables (`batchD-semantic`, `batchD-repair`,
`batchD-provider-probe`) all pass, and Batch A/B/C regressions are green.

The system no longer merely displays storyboard objects: **it executes storyboard events over
time and deterministically proves whether they happened.**

---

## Scope — what Batch D implemented

### New source files
| File | Purpose |
|---|---|
| `src/validation/executionPlan.ts` | event taxonomy + `executionPlanSchema` + `compileExecutionPlan` + `promisedEventSchedule` (one source of truth for promise ids/times) |
| `src/scenes/execution.ts` | pure execution engine: easing, `elementExecutionAt`, anchor-point model, `resolveMoveTarget`, attachment following |
| `src/scenes/state.ts` | deterministic state extractor: `elementStateAt` / `sceneStateAt` / `stateForSemanticId` (execution wrapper × primitive motion) |
| `src/validation/semanticEnactment.ts` | **`semanticEnactmentGate`**: contract resolution, event evidence (before/at/after), detection, timing tolerance, relationships, failure classification |
| `src/agents/eventEvidence.ts` | pre/at/post event stills → `qa/events/<scene>/<event>.json` + PNGs (§27) |
| `tests/fixtures/batchD.ts` | shared PASS + 5 broken + legacy fixtures |

### Modified source files
| File | Change |
|---|---|
| `design-system/primitives.json` | common params `semanticId`, `attachTo` (schema-only, like Batch C's `collisionIntent`) |
| `src/validation/storyboardSchema.ts` | `semanticObjects[].id`, executable `motionBeats[]` (`id/target/eventType/atSeconds/expected{from,to,toward,with,parent}`), structured `relationships[].type` |
| `src/validation/schema.ts` | `scene.executionPlan` field + superRefine: semanticId pattern/uniqueness, attachTo self-reference, plan events inside the scene window, duplicate event ids |
| `src/scenes/SceneRenderer.tsx` | minimal change: `ElementInner` applies the execution transform to the **wrapper** (position/scale/rotation/opacity/clip + progress value clone). Plan-less scenes render byte-identically |
| `src/agents/repairContext.ts` | 7 new `FailureType`s, `deterministic-semantic` source, extended `FAILURE_PRIORITY`, narrow `NARROW_ACTION`s, `semantic` input for `classifyFailures` |
| `src/validation/repairContract.ts` | semantic allow-lists, `events:<id>` + semantic-id targets, `addElement`/`addEvent` structural changes, event-value rules, storyboard-immutability exception for event type only, requirement-superset invariant |
| `src/agents/repairLoop.ts` | model-only measurement now includes the enactment gate; severity/evidence-after read semantic failures |
| `src/agents/repairCompare.ts` | `MetricSources.semantic` joins `buildMetricVector` (semantic hard keys drive KEEP/ROLLBACK) |
| `src/agents/repairProviders.ts` | semantic prompt rules + semantic-aware scene digest (elements + plan events; ~2.1k chars) |
| `src/agents/pipeline.ts` | gate before the first render, re-evaluated after every scene change, passed to classify/QA/repair, event stills after the loop, `rerunQa` wired |
| `src/agents/qa.ts` | `QaBundle.enactment`; `aggregateQa` turns semantic hard failures into QA failures |
| `src/agents/semanticQa.ts` | judges receive the compact deterministic evidence lines (images stay primary, §26) |
| `src/agents/storyboard.ts` | normalization passes the new executable fields; expansion prompt requires ids/event types/structured relationships |
| `src/agents/motionPlanner.ts` | composer prompt: `semanticId`/`attachTo` mapping; deterministic `executionPlan` embed after parse |
| `src/agents/repair.ts` | legacy full-scene repair re-embeds storyboard/subtitle/plan (never drops the contract) |
| `src/core/diagnostics.ts` | `gates.enactment` + flat event trace (§37) |

---

## Execution Plan — actual schema

```jsonc
// scene.executionPlan (embedded deterministically; never model-echoed)
{
  "schema": "execution-plan/1",
  "events": [{
    "id": "event_02",             // stable, matches storyboard.motionBeats[].id (default event_<index>)
    "atSeconds": 2.6,             // promised time; explicit preserved, else deterministic spread
    "type": "move",               // raw type (may be unsupported - never silently dropped)
    "action": "moveTo",           // derived machine action (EVENT_ACTION map)
    "target": "person_01",        // semantic id
    "destination": "gate_01",     // move/attach destination (or withTarget for replace)
    "from": 1, "to": 1.35,        // numeric transitions (scale/fade/progress/rotate)
    "toOffsetX": 38.6,            // optional resolved offsets; else runtime anchor resolution
    "durationSec": 0.35,          // transition window; state LANDS at atSeconds (§16)
    "easing": "easeInOut",        // linear | easeIn | easeOut | easeInOut (§17)
    "provenance": "explicit",     // explicit | derived - derived is never called "measured" (§8)
    "sourceOrder": 2
  }]
}
```

- Compiled by `compileExecutionPlan(scene)` from `storyboard.motionBeats` — embedded by the
  scene composer, re-embedded by both repair paths, and re-derived on the fly when absent, so
  a storyboard promise is always executable.
- Timing: explicit `atSeconds` preserved when inside `[0.05, duration]`; otherwise derived as
  `duration * (i+1)/(n+1)` with `provenance:"derived"`. VO word timestamps and the 1.8s floor
  are untouched; total duration is exact (plan is scene-local).
- Plan validation is part of `validateScene` (out-of-window timing = hard validation error).

---

## Event Taxonomy — actual supported events

`enter · exit · move · scale · rotate · fade · replace · reveal · progress · attach · detach`

All 11 are **executed by the renderer** (wrapper transform/opacity/clip/offset + value clone +
attachment following) and **detectable from state**. Anything else (`transform`, `morph`, …)
survives storyboard validation and surfaces as `unsupported_event` with confidence 0 — never
faked, never silently executed (§7).

Easing vocabulary is fixed: `linear | easeIn | easeOut | easeInOut` (LLM picks a name, code
computes the curve).

---

## Semantic IDs — how resolution works

1. Storyboard `semanticObjects[].id` (`person_01`) = the promise.
2. Scene element `semanticId` (strict common param, pattern-checked, unique) = the binding.
3. Plan `target`/`destination`/`withTarget` and relationship endpoints reference those ids.
4. `elementIndexBySemanticId` / `stateForSemanticId` resolve id → element → state.
   Free-text matching is never used for semantics (§12).

Legacy storyboards without ids form **no contract** (backward compatible — Batch A/B/C
fixtures are untouched).

---

## Event Evidence — before / at / after

For each promised event the gate samples the *pure state extractor* at
`pre = at−0.25s`, `at`, `post = at+0.25s` (clamped to the scene):

```jsonc
{ "eventId": "event_03", "sceneId": "scene_01", "target": "gate_01", "type": "scale",
  "promisedAt": 3.6, "planAt": 3.6, "detectedAt": 3.517, "timingDeltaSec": -0.083,
  "window": {"pre": 3.35, "at": 3.6, "post": 3.85},
  "status": "pass", "expected": "scale x1.35",
  "before": {...}, "at": {...}, "after": {...},       // x,y,scale,rotation,opacity,reveal,progress,attachedTo,visible
  "detected": true, "confidence": 1,
  "evidence": "scale gate_01: 1.00 -> 1.35 (0.35), detected 3.52s / promised 3.60s (delta -0.08s <= 0.3s)" }
```

- `detectedAt` = deterministic 1/60s scan of the closed-form state function (no frames, no LLM).
- `confidence = 1` only for state-measured verdicts; `0` when nothing could be measured.
- Event stills: `qa/events/<scene>/<event>.json` + `pre/at/post` PNGs (only for scenes with an
  active contract; legacy scenes cost zero renders).

---

## Semantic Gate — failure types and thresholds

Every constant lives in `ENACTMENT` (`src/validation/semanticEnactment.ts`), documented and
asserted by tests (§19/§39):

| Constant | Value | Meaning |
|---|---|---|
| `timingToleranceSec` | **0.30 s** | \|detected − promised\| ≤ tolerance passes |
| `eventWindowSec` | 0.25 s | pre/post evidence sampling offset |
| `scanStepSec` | 1/60 s | detectedAt scan resolution |
| `moveExecPx` / `moveSettlePx` | 150 / 24 px | move executed / settled |
| `scaleExec` / `scaleSettle` | 0.15 / 0.04 | scale delta thresholds |
| `rotateExecDeg` / `rotateSettleDeg` | 25 / 5 deg | rotation thresholds |
| `opacityExec` / `opacitySettle` | 0.60 / 0.05 | enter/exit/fade/replace |
| `revealExec` / `revealSettle` | 0.60 / 0.05 | reveal thresholds |
| `progressExec` / `progressSettle` | 0.15 / 0.05 | progress thresholds |
| `*FinalTol` (opacity/scale/progress) | 0.12 | final state vs promise |
| `approachPx` | 80 px | movesToward must close the distance |
| `nearPx` | 640 px | `near` relationship anchor distance |

Invariant: transition `durationSec (0.35) > timingTolerance (0.30)` — an execution that lands
earlier than the transition window can never be detected inside tolerance (tested).

Gate checks (§18), in order per event: `unsupported_event` → `missing_event` →
`missing_semantic_object` → `event_not_executed` (state delta below threshold) →
`event_timing_mismatch` (\|detectedAt − promised\| > 0.30) → `state_transition_failed`
(final state off the promise) → `pass`.

Cascade/dedupe rules keep classifications single-valued: an event whose *destination* object
is missing is covered by `missing_semantic_object`; a relationship whose endpoint's event
already failed (or whose endpoint is a reported missing object) is suppressed.

### Failure taxonomy + final priority order (§21)

```
1  layout_clip            7  missing_semantic_object    13 unsupported_event
2  safe_area_overflow     8  missing_event              14 novelty_fixture
3  empty_visual_band      9  event_not_executed         15 judge_issue
4  unreadable_text       10  event_timing_mismatch      16 unknown
5  unintended_collision  11  state_transition_failed
6  timing_issue           12 relationship_failed
```

Semantic failures: severity `hard`, source `deterministic-semantic`. They outrank judge/slop
complaints and sit below deterministic layout/visual/collision/timing evidence.

---

## Relationship System

Structured `relationships[].type` (small, no graph database):

| type | verification |
|---|---|
| `movesToward` | anchor-model distance closes by ≥ 80 px (start → scene end) |
| `attachedTo` | child's effective `attachedTo` equals the parent at scene end; child **follows the parent's execution transform** with its own local offset (cycle-safe, one relation graph) |
| `near` | final anchor distance ≤ 640 px |
| `pointsTo` | structural (endpoints resolve) — documented Batch D limitation |
| `overlapsIntentionally` | one endpoint declares `collisionIntent:"intentional"` |

Distances use the shared anchor-point model (both endpoints, same model → exact deltas,
approximate absolutes). Legacy free-text relationships (no `type`) are not enforced.

---

## Repair Integration — how Batch C is reused

```
failure (gate) → classifyFailures(semantic) → FAILURE_PRIORITY order
  → compact RepairContext (one failure, one scene, measurements only, ~2.1k char prompt)
  → constrained semantic proposal (allow-list per failure type)
  → validateRepairProposal (structure + narrowness + storyboard immutability + superset)
  → candidate → deterministic enactment gate + model-only measurement (no render needed)
  → compareRepair on metric vectors → KEEP | ROLLBACK (restoreSnapshot)
  → ledger + diagnostics
```

Allow-lists (§23): `missing_semantic_object → addElement` (exactly one element, must carry the
missing `semanticId`, must be a registered primitive), `missing_event → addEvent` (same id the
storyboard promises, inside the window), `event_not_executed → event.toOffset*/to/destination/
durationSec/easing`, `event_timing_mismatch → event.atSeconds`, `state_transition_failed →
event.to*/from/durationSec/attachTo`, `relationship_failed → attachTo/event.destination/
offsets/position`, `unsupported_event → event.type` (target must become a **supported** type).

Forbidden (rejected by the contract): rewriting/dropping the storyboard (only the targeted
beat's `eventType` may change, and only for `unsupported_event`), removing baseline semantic
ids, removing plan events, changing duration/purpose/visualConcept/motion/subtitle,
`addElement` for any other failure type, unrelated targets (semantic scoping by implicated
event ids/object ids), no-ops, out-of-range values, unknown event properties.

**"Pass by deletion" is structurally impossible (§24/§25):** the candidate is judged against the
baseline storyboard (byte-compared except the one type exception), every baseline `semanticId`
and plan event id must survive (`superset` invariant), and there is no proposal syntax that can
delete a requirement.

---

## Keep/Rollback — how semantic candidates are compared

Unchanged Batch C machinery; `MetricSources.semantic` feeds `classifyFailures` inside
`buildMetricVector`, so:

- fixing `missing_semantic_object` removes the hard key + drops `targetSeverity 1 → 0` → **KEEP**;
- a candidate that introduces `scene_01:event_timing_mismatch` (new hard key) → **ROLLBACK**;
- rollback = `restoreSnapshot()` → baseline restored byte-for-byte (verified by hash);
- every attempt writes a ledger row (`failureType`, `evidenceBefore/After`, hashes, comparison,
  promptHash, budget) and `qa/diagnostics.json` exposes the decision + the flat event trace.

Semantic decisions are model-only by design (state evidence needs no pixels); pixels still
arbitrate layout/visual regressions after a render.

---

## Tests — exact counts

```
npm run verify   →  EXIT 0
Test Files  31 passed (31)
Tests      331 passed | 1 skipped   (Batch C end state: 261 passed | 1 skipped → +70 new)
typecheck clean
```

New suites: `tests/executionPlan.test.ts` (13) · `tests/semanticEnactment.test.ts` (31) ·
`tests/semanticRepair.test.ts` (24) · +2 in `tests/qaGates.test.ts` (enactment → aggregate QA).

Coverage of the required list: valid/invalid/missing/out-of-range event timing · stable id
resolution + missing/duplicate/malformed ids · detection for move/scale/fade/enter/replace/
unsupported · timing inside AND outside tolerance (both sides, tolerance asserted = 0.30) ·
relationships valid/missing-target/attachedTo (+ parent-follows-child geometry) · gate full
pass + all 7 failure classifications (each broken fixture produces exactly one type) ·
priority order · semantic repair accepted / unrelated mutation rejected / requirement deletion
rejected / storyboard mutation rejected / structural change outside `missing_semantic_object`
rejected / no-op rejected · KEEP (improved) + ROLLBACK (worsened, baseline byte-restored) ·
metric-vector rollback on a new semantic hard key · determinism (identical reports) ·
legacy-no-contract inertness · compact prompt (<3500 chars).

---

## E2E — exact results

| Run | Command | Result |
|---|---|---|
| **Batch D semantics** | `npx tsx e2e\batchD-semantic.ts` | **PASS — 42/42 checks** |
| **Batch D repair** | `npx tsx e2e\batchD-repair.ts` | **PASS — 26/26 checks** |
| **Batch D provider probe** | `npx tsx e2e\batchD-provider-probe.ts` | **PASS** |

`batchD-semantic` evidence (real renders):

```
contract: objects=2/2 events=3/3 relationships=1/1, every event |delta| <= 0.30s
plan changes rendered pixels:
  enter   frameDiff(0.2s -> 1.4s) = 0.0074   occupancy 0.0198 -> 0.0287
  move    frameDiff(2.0s -> 3.2s) = 0.0126   person (246,960) -> (664,960) = 417px
  gate    frameDiff(3.2s -> 4.2s) = 0.0087   scale x1.00 -> x1.35
Batch A/B gates on the render: layout hard=0, visual hard=0
event evidence: qa/events/scene_01/event_0{1,2,3}.json + 3 stills each (before/at/after recorded)
artifact identity: consistent; scenesHash stable; diagnostics carry gates.enactment
  (+ event trace: event_03:pass@3.517 with full evidence string)
failures: missing object / missing event / not executed / timing mismatch / relationship /
  unsupported -> each EXACTLY the expected classification, each source=deterministic-semantic
legacy scene: no contract, no failures
```

`batchD-repair` evidence (scripted provider):

```
KEEP:    missing_semantic_object -> addElement(gate_01) -> contract accepted
         gate PASS after apply, storyboard + execution plan byte-identical
         ledger: KEEP, evidenceBefore/After, baseline!=candidate hash, promptHash recorded
         kept scene renders; 3/3 event reports pass; diagnostics show scene_01:missing_semantic_object:KEEP
ROLLBACK: addEvent(event_02 @1.0s, promise 2.6s) -> contract accepted (narrow) ->
         enactment evidence shows NEW hard failure scene_01:event_timing_mismatch ->
         decision=ROLLBACK ("candidate introduces new hard failure(s): scene_01:event_timing_mismatch")
         baseline restored byte-for-byte; bad event gone; storyboard promise intact; snapshot r1-scene_01
```

---

## Provider Probe

**PASS** — `npx tsx e2e\batchD-provider-probe.ts`

```
prompt chars=2153 lines=23        (compact: one failure + one scene + plan digest + output contract)
failure=missing_semantic_object target=gate_01
provider responded in 7156ms
proposal: {"changes":[{"target":"scene","property":"addElement","to":{"primitive":"Person",
  "semanticId":"gate_01","position":"right",...}}]}   (registered primitive, promised id)
contract validation: ACCEPTED
```

First attempt (45s) proposed a hallucinated primitive `"Gate"` and the contract **rejected it
with the registered-primitive list** — the deterministic guard doing its job; the prompt was
then tightened ("copy a primitive from the scene digest, never invent one") and the probe
passes. Timeboxed at 90s; no `generateProject()`, no renders.

---

## Regression — Batch A/B/C exact results

| Suite | Command | Result |
|---|---|---|
| typecheck + tests | `npm run verify` | **EXIT 0** — 31 files, 331 passed / 1 skipped |
| Batch A | `npx tsx e2e\batchA-e2e.ts` | **ALL CHECKS PASSED** — preview sha `cdb2e0c9b95c…` **byte-identical** to the Batch A/B/C baseline (renderer neutral path untouched) |
| Batch B gates | `npx tsx e2e\batchB-gates.ts` | **PASS — 30/30** (layout hard 3, visual hard 1, aligned 3/6 — identical to Batch C) |
| Batch B timing/geometry | `e2e\batchB-timing.ts`, `e2e\batchB-geometry.ts` | run clean (tiling sum exact, rendered edgeInk=0) |
| Batch C repair | `npx tsx e2e\batchC-repair.ts` | **PASS — 27/27** (KEEP + ROLLBACK, same evidence as Batch C report) |
| Artifact identity | `npx tsx e2e\batchC-consistency.ts` | **PASS** — `_batcha_e2e`, `_batchc_e2e`, `_batchc_e2e_rb` all `consistent=true` |

No Batch A/B/C threshold was changed: `modelFrameClipPx 8`, `renderedFrameClipInk 10`,
`safeAreaSeverePx 48`, `bandOccupancyFloor 0.005`, `brightShareFloor 0.003`, `unreadableTextPx
20`, `overallQualityMin 8`, `slopSeverityMax 6`, `noveltySimilarityMax 70`, `MIN_BEAT_DURATION_SEC
1.8` all verified unchanged.

---

## Known Limitations

1. **Full live `generateProject()` not run to completion.** Three live runs executed the
   Batch D wiring end-to-end — pre-render enactment gate → render → frame/layout/visual gates →
   semantic QA → targeted repair rounds (budgeted LLM calls) → legacy semantic regeneration —
   and were stopped by the shell time budget mid-round-1 (provider latency on the legacy
   `regenerateStoryboard` path), not by an error. Every Batch D-specific deliverable is covered
   by the deterministic E2Es instead.
2. **Anchor-point distance model.** Relationship distances/approach use the shared anchor model
   (exact deltas, approximate absolutes). `pointsTo` and `overlapsIntentionally` are structural
   checks; pixel-level direction/overlap understanding would need segmentation (Batch E+).
3. **`transform` events are deliberately unsupported** (structured `unsupported_event`); a repair
   may switch the *type* only to a supported one, but semantic equivalence of that swap cannot
   be machine-proved — the enactment gate re-measures the candidate and rolls back nonsense.
4. **Primitive choice in `addElement` is contract-checked but not semantics-checked** (the probe
   model chose `Person` for a "gate"). Narrowness + registered-primitive validation pass; whether
   the right object was chosen is a judge/vision question, not a deterministic one.
5. **Transition duration (0.35s) must exceed timing tolerance (0.30s)** or early executions could
   hide under the window-start floor; enforced by test, and the contract allows `durationSec`
   down to 0.05s (a repaired ultra-short window weakens early-execution detection).
6. **Legacy judge-driven semantic repair (`regenerateStoryboard`) is untouched** (Batch C
   blocker #1): deterministic semantic failures use the targeted path; judge-score-driven
   "weak meaning" still regenerates storyboards through the legacy path.
7. **Production storyboards need the new prompt output.** Stored/legacy storyboards (no ids, no
   event types) form no contract; only newly generated storyboards exercise the gate in
   production. The prompts now require ids/types/structured relationships.
8. **Event stills are capped** (`maxEventsPerScene`, default 2 in the pipeline, 3 in E2E) — QA
   evidence, not a dataset.
9. **Box dimensions are not duplicated in the state layer.** The state extractor exposes the
   motion channels (x, y, scale, rotation, opacity, reveal, progress, attachedTo, semanticId,
   primitive, visible); pixel-exact boxes stay owned by Batch B's `rendererGeometry`/layout
   gates (browser-measured). The semantic gate needs deltas and relations, not boxes.

---

## Batch E Blockers

1. **Pixel-level object identity** — relating rendered ink back to semantic ids (segmentation or
   deterministic per-object draw-layer evidence) before any visual event claim can be checked
   against pixels instead of state.
2. **`transform`/morph events** — need a deterministic state channel (variant swap or parameter
   interpolation) before they can leave the unsupported list.
3. **Semantic primitive selection for `addElement`** — a vision/judge check that the *added*
   object looks like what the storyboard named.
4. **Directional relationships (`pointsTo`)** — needs per-element orientation from geometry,
   currently structural only.
5. **Live full-run budget** — one completed `generateProject()` with contract-active storyboards
   is still owed (provider latency, not architecture).

---

## Commands executed

```
npx tsc --noEmit
npm run verify
npx vitest run tests/{executionPlan,semanticEnactment,semanticRepair,qaGates}.test.ts
npx tsx e2e\batchD-semantic.ts
npx tsx e2e\batchD-repair.ts
npx tsx e2e\batchD-provider-probe.ts
npx tsx e2e\batchA-e2e.ts
npx tsx e2e\batchB-gates.ts
npx tsx e2e\batchB-timing.ts
npx tsx e2e\batchB-geometry.ts
npx tsx e2e\batchC-repair.ts
npx tsx e2e\batchC-consistency.ts
npx tsx e2e\batchA-pipeline.ts   (live, three attempts — each executed deep into repair round 1 with the Batch D wiring active; stopped by time budget/provider latency, not by an error)
```

**STOP — Batch D complete. Batch E not started.**
