# AUTONOMOUS AUDIT — motion-video (Phase: AUDIT ONLY, no implementation)

Date: 2026-10-08
Auditor: MiMo v2.6 Flash (lead engineering/research agent)
Scope: current implementation + current rendered output + benchmark research
Rule honored: **no production code was modified.** Analysis scripts added under `e2e/audit-*` (read-only,
excluded from `tsconfig.json` include and from vitest) — safe to keep for verification or delete.

---

## 1. Executive summary

The repository is a well-engineered *pipeline* with a weak *execution layer*. Structurally everything
works: 96/96 tests green, typecheck clean, strict Zod scene contracts, deterministic Remotion render,
multi-judge QA with variance/confidence, honest failure reporting. The video it produces is not good
enough, and the reasons are specific, measurable and mostly **deterministic** — not "the AI is dumb".

Five verified facts define this audit:

1. **Timing is synthetic.** Phrase timestamps are a uniform word-rate grid
   (`core/timing.ts:47-67`), not speech. Detected VO sentence boundaries are at
   ~4.72 / 8.22 / 11.00 / 16.05 / 20.81s; the system's scene boundaries are
   5.90 / 10.11 / 12.74 / 16.95 / 21.15s — **scene-to-sentence error up to 1.9s**.
   A scene stays on screen while the next sentence is already being spoken.
2. **There is no frame-bounds gate.** Scene 03's giant `WordReveal` (scale 2.2) is clipped by the
   right frame edge (measured: 408-411 ink px inside the last 12px column band, ASCII preview shows
   glyphs flush to column 89/90). The same scene scored **conformance 9.8/10 — the best score in the
   project.** Validation only checks offset *sign* (`schema.ts:254-276`), never rendered extent.
3. **Scene 04 is an empty scene that passed every gate.** 9 elements in JSON; measured ink in the
   object region = **0.17% (r3) / 0.52% (r7)** vs 12.9% in the headline band. The 8 `Line`
   primitives render as 3-4px hairlines (`objects.tsx:427-447`). No occupied-area or
   semantic-presence detector exists.
4. **The storyboard → scene layer collapses semantics.** Scene 05's storyboard objects
   (`AnswerLine`, `GateRow`, `CutFragment`, `BypassLine`) compiled into
   `Circle + 3 Labels + Badge`. Scene 02's storyboard `Line (the single axis/rail)` compiled into
   *nothing* — the rail is simply absent. Nothing checks that a storyboard object is enacted.
5. **`final.mp4` is stale.** `final.mp4` = 18:25, `preview.mp4` = 19:42; they differ at **every**
   sampled timestamp (824-15,173 px / 129,600). `qa-summary.json` (18:32) describes scenes from
   4 repair rounds earlier. "Final" and "QA of record" describe different videos.

The single most important architectural gap (task §7 of the brief) is **confirmed**:
the system has `storyboard → scene JSON → primitive list → renderer`, and is missing a
**visual execution plan** that survives compilation: ordered, timed, *enacted* state changes with
measured layout. The storyboard already contains the narrative (5 visualNarrative steps,
5 motionBeats) — but `motionBeats[].atSeconds` is **null in all 24 storyboards**, and the scene
schema can only express `entrance @delay + one emphasis pulse + scene-level exit`
(`motion.ts:71-167`). Consequence: every scene is "elements stagger in", which is exactly what the
judge scored as `visualStorytelling = 3.7 — scenes display instead of demonstrate`.

---

## 2. Current architecture (as documented)

```
SCRIPT + VO
 -> script analysis -> semantic beats -> VO timing
 -> VISUAL STORYBOARD DIRECTOR (candidates 3-5 -> Art Director -> expansion)
 -> SCENE COMPOSER (storyboard -> scene JSON)
 -> validation (Zod + validateScene + collision gate)
 -> novelty gate -> render preview
 -> QA: technical / conformance / vision 3-judge / slop / semantic
 -> REPAIR (semantic | layout | subtitle | typography | composition)
 -> finalize: final.mp4 + memory
```

Docs asserting this: `MASTER_SPEC.md` §19, `AGENTS.md`, `docs/STATUS_PHASE3.md`.

## 3. Actual runtime pipeline (verified in code)

| Step | Real implementation | Verified location |
|---|---|---|
| analysis | 1 LLM call | `src/agents/scriptAnalyst.ts` |
| beats | 1 LLM call, includes per-beat timing request | `scriptAnalyst.ts` |
| timing | ffprobe duration only; **phrases = uniform word grid**; whisper attempt falls back silently | `src/agents/voTiming.ts:160-183`, `src/core/timing.ts:47-67` |
| storyboard | per beat: candidates(1) + selection(1) + expansion(1); cached `scenes/storyboard-bN.json` | `src/agents/storyboard.ts:349-415` |
| scene generation | 1 call/beat, `reasoningEffort: none`, maxTokens 12000, **1 re-ask on collision then soft-accept** | `src/agents/motionPlanner.ts:104-209` |
| validation | Zod per-primitive strict schema + headline budget + subtitle window + offset-sign guard | `src/validation/schema.ts` |
| render | Remotion `renderProject` -> `out/` -> copy to `renders/preview.mp4` | `src/render/renderProject.ts` |
| QA | ffprobe; conformance (deterministic + frame stats); vision 3 judges + issues call; slop; semantic 2 judges | `src/agents/qa.ts`, `src/reference/conformance.ts`, `src/agents/semanticQa.ts` |
| repair | `repairScene` (writes immediately) OR `regenerateStoryboard + runSceneGeneration` | `src/agents/repair.ts:151`, `pipeline.ts:212-237` |
| finalize | `fs.copyFileSync(previewFile, final.mp4)` | `pipeline.ts:289-291` |

**Reality vs documentation deltas:**

- `docs/_inventory.txt` line counts are stale (e.g. conformance 507 vs actual 629, motionPlanner 190 vs 292).
- `src/agents/concepts.ts` (Phase-2 concept/art-direction stage, 9KB) is **dead code** — the pipeline
  imports `storyboard.ts`, never `concepts.ts`.
- `timingSource: "phrase"` in the manifest implies measured phrase timings. The code path that
  produces them is `estimateTimingsFromDuration` (word-count proportional) and is labeled
  `"phrase"` at `voTiming.ts:172`, although its own docstring says it should be `"estimated"`.
- `MASTER_SPEC`/`STATUS` claim "VO is the timing authority". Only the *total duration* comes from audio.
- Repair stage in `manifest.json` says `failed` (HTTP 524, 18:17) yet scenes continued changing until
  19:38 — those edits came from the semantic path / UI regeneration, which do **not** mark the
  `repair` stage. Stage bookkeeping does not describe what actually happened.

## 4. Current strengths (do not break these)

1. `npm run verify` green: **typecheck clean, 96 passed / 1 skipped** (measured this session).
2. Strict, actionable validation: unknown primitive, bad duration, bad offset, duplicate headline,
   subtitle window violations all fail with messages that tell the model what to do.
3. Deterministic rendering: `FontLoader` uses `delayRender` (`ProjectRenderer.tsx:36-64`), no
   `Math.random()` in the render path, pure `(scene, frame)` functions.
4. Honest QA: `VISION_UNAVAILABLE` refuses to fake scores; `source: deterministic-fallback`
   recorded; `qa-summary.json` says `status: fail` with the true reasons.
5. Multi-judge median with variance/confidence (`qa.ts:162-176`) — outlier-immune scoring.
6. Storyboard contract is genuinely good: `spokenMeaning`, `visualMechanism`, `visualNarrative`,
   `semanticObjects`, `relationships`, `forbiddenInterpretations`, `elementBudget`.
7. Reference-derived design tokens with provenance (`design-system/PROVENANCE.md`), conformance that
   explicitly avoids pixel similarity.
8. Novelty across 7 dimensions incl. mechanism; project memory with dedup.
9. Resume/caching of finished stages; per-scene regeneration entry points.

## 5. Current weaknesses (ordered)

| # | Weakness | Severity | Evidence |
|---|---|---|---|
| W1 | Scene/subtitle timing not derived from audio | P0 | silencedetect boundaries vs `beats.json` (§7 RC1) |
| W2 | No frame-bounds / safe-area gate; `scale()` grows past anchor | P0 | scene_03 right-edge ink 408-411; conformance 9.8 |
| W3 | No empty-scene detector; hairline primitives invisible | P0 | scene_04 object-region ink 0.17-0.52% |
| W4 | Storyboard semantics dropped at compile; no enactment check | P1 | scene_05/scene_02 object mapping (§7 RC4) |
| W5 | Motion model cannot express state progression | P1 | `motion.ts:71-167`; `atSeconds` null in 24/24 storyboards |
| W6 | Collision model inaccurate; gate is soft (1 re-ask, then accept) | P1 | scene_06 accepted w/ 24% + 100% overlaps; scene_02 68% |
| W7 | Artifact integrity: final/QA/render not bound; stale reports | P1 | final vs preview differ at every timestamp sampled |
| W8 | No repair rollback / best-of / before-after comparison | P1 | `repair.ts:151`; only 1 `repair-*.json` exists |
| W9 | QA judges 1 still per scene at 55% — cannot see motion | P2 | `renderProject.ts:122` |
| W10 | Fragile giant LLM calls (524, schema typos kill runs) | P2 | 3 failed projects in `projects/*/manifest.json` |
| W11 | Primitive vocabulary unused (17/39 never used); no overlap-capable layout | P2 | usage census (§10) |
| W12 | Headline/WordReveal force gold accent regardless of storyboard | P2 | `typography.tsx:50,108` |

## 6. Evidence from the rendered output

All measurements produced with `ffmpeg` (raw rgb24, 540x960 downscale) via `e2e/audit-frames.js`,
`e2e/audit-probe.js`, `e2e/audit-ascii.js`. Frame sets: `projects/proj_p3_demo/qa/frames/r1..r7`
(7 render rounds), plus both MP4s.

### 6.1 Artifact inventory (proj_p3_demo, the Phase 3 E2E)

| Artifact | Mtime (local) | Status |
|---|---|---|
| `scenes/scene_01.json` | 18:54 | current |
| `scenes/scene_02.json`, `scene_05.json` | 19:38 | current |
| `scenes/scene_03.json` | 17:55 | current |
| `scenes/scene_04.json` | 19:20 | current |
| `scenes/scene_06.json` | 18:24 | current |
| `renders/final.mp4` | **18:25** | **STALE (4 repair rounds behind)** |
| `qa/qa-summary.json` (overall **6.16**) | 18:32 | describes the stale render |
| `qa/conformance.json` (8.7) | 18:25 | stale; current scene_04 has an undetected subtitle collision (ratio 1.0) |
| `renders/preview.mp4` | 19:42 | current render (differs from final at t=2,3,8,11.5,14.5,19,23s) |
| `qa/frames/r7/*` | 19:45 | current frames |
| `qa/semantic-qa.json` (6.5 / 5.3 / 8.0) | 19:46 | current — **disagrees with the semantic block inside qa-summary (5.6 / 3.7 / 3.3)** |
| `manifest.status` | — | `complete` while `qa-summary.status = fail` |

The published numbers were re-verified **directly from `qa-summary.json`**:
overall **6.164**, conformance **8.7**, semantic relevance **5.6**, storytelling **3.7**,
coverage **3.3**, richness **10**, subtitle coverage **10**, slop **7** — all match the brief.
The *newest* semantic report is better (6.5/5.3/8.0) but was never folded into the summary.

### 6.2 Per-scene frame metrics (ink = pixels with luma>55, 540x960 space)

```
scn rnd  ink%  Redge  rightMid%  note
  1  r7  5.53    0        -       clean, no edge contact
  2  r1  5.96    0        -       pre-repair
  2  r3  3.74    0       2.02     merged component 68x159px = BLOB (QA-observed frame)
  2  r7  5.02    0       4.06     3 separate rings now; ring3 + foreign shape still merged (area 2201 vs 1035)
  3  r1  7.98    0        -       NOT clipped
  3  r7  6.35  411       5.53     CLIPPED — ink inside last 12px column band, glyphs reach col 89/90
  4  r3  3.98    0       0.172    EMPTY object region (QA-observed)
  4  r7  4.33    0       0.516    still effectively empty; headline band 12.9%
  5  r3  4.68  440       7.22     giant circle touches right edge
  5  r7  5.43    0       6.56     edge fixed by repair; mechanism still absent
  6  r3  3.32    0      12.15     headline glyphs sit on ring (see 6.3)
  6  r7  3.40    0      12.30     unchanged since r5
```

### 6.3 ASCII previews (90 cols, `e2e/audit-ascii.js`)

- **scene_03 (r7):** rows 18-27, columns 80-89 are solid `@` — the giant YES glyph cluster runs into
  the last column with no 8% margin. This is hard clipping, not "tight layout".
- **scene_04 (r7):** headline rows 8-19 (incl. a full-width gold accent line), then rows 20-62 are
  almost entirely blank with `.....`-level (luma 28-45) dashes at cols 62-89 — the 8 hairlines — and
  a faint teal mark at row 62. Confirms "frame nearly empty" and explains why: **the lines are
  rendered but below any readability threshold.**
- **scene_06 (r3/r7):** teal ring occupies cols 34-56, rows 22-37; headline gold words start at
  col 51, rows 34-36 → the ring's right edge and the headline overlap. Also visible: a stray arrow at
  cols 20-31 rows 53-56 pointing into nothing.
- **scene_02 (r3):** one tall merged teal shape 68x159px = two circles fused; no rail; headline sits
  in the middle-left (topBand ink = 0).
- **scene_05 (r3):** one circle spanning x53-98%, headline text running into it, no lines/stroke.
- **scene_02 (r7) / scene_05 (r7):** improved spacing after repair, but still 3 solid YES badges
  (2 teal + 1 gold) — the storyboard's `forbiddenInterpretations` explicitly forbid
  "three separate solid YES copies" and "a gold YES".

## 7. Root-cause chains

### RC1 — Scene/VO desync (affects every scene)

```
Viewer sees sentence N+1 over scene N
   <- scene boundaries 5.90/10.11/12.74/16.95/21.15 vs speech ~4.72/8.22/11.00/16.05/20.81
   <- fitBeatDurations() re-derives boundaries by cursor accumulation after adding
      an EQUAL extra slice to every beat (core/timing.ts + voTiming.ts:109-131)
   <- phrases are a uniform word-rate grid, not measured speech
      (core/timing.ts:47-67; timestamps.json = 14 x 1.690886s + remainder)
   <- whisper transcription returned null (no analysis/transcript-words.json exists)
   <- provider /audio/transcriptions unavailable; fallback silently labeled source="phrase"
ROOT CAUSE = VO timing is text math over a total duration. ffprobe is the only audio-derived input.
```

Direct measurement (ffmpeg `silencedetect`, -35dB, 0.25s):

```
actual speech segments:  0-2.59 | 3.09-4.21 | 5.22-7.71 | 8.74-10.48 | 11.52-15.55 | 16.55-20.30 | 21.32-23.97
system scene boundaries: 0 ---- 5.90 ---- 10.11 ---- 12.74 ---- 16.95 ---- 21.15 ---- 24.94
error at boundary:              +1.18s       +1.90s      +1.74s      +0.90s      +0.34s
```

Knock-on effects: subtitle phrases are sliced at scene windows -> orphan fragments
("mind are the ones", "others remember. Stop editing" in scene_04); `subtitleCoverage = 10` stays
maxed because it only measures *time covered*, never *phrase quality or alignment*.

### RC2 — scene_03 "YES" clipped at the right edge

```
Giant YES glyph cut by frame edge
   <- AnchorGroup right edge at x=993.6 (8% margin), ElementInner applies
      transform: translate(...) scale(2.2)  (SceneRenderer.tsx:130)
   <- CSS scale grows around the element's CENTRE; translate(-100%) compensates only the
      UNSCALED width -> visual box = 0.6 * width beyond the right edge (~200px overflow)
   <- scene JSON is legal: WordReveal scale 2.2 at position "right" (schema allows 0.2..3)
   <- sceneLayoutBoxes() computes the box from fontSize*scale but anchors it right-aligned
      INSIDE the frame -> model believes it fits (conformance: 0 collisions)
   <- validateScene has no frame-bounds check; only offset-sign guard (schema.ts:254-276)
   <- QA sees it only AFTER render, from a single vision still
ROOT CAUSE = anchor math and CSS transform math disagree; there is no safe-area/overflow gate
anywhere in validation, conformance or technical QA.
```

Why conformance scored it **9.8/10**: `textCollisions` never compares any box to the frame, and
`applyFrameStats` only looks at `meanLuma`/`textPixelShare`/`accentPixelShare` — edge contact is
invisible to it.

### RC3 — scene_04 nearly empty (and why repair did not save it)

```
Frame communicates almost nothing
   <- 8 of 9 elements are `Line` with no thicknessPct/lengthPct overrides
   <- Line renders: thickness = max(3, 4*s) px, length = 60% * 440px = 264px,
      colour = text.muted when accent="none" (objects.tsx:427-447)
   <- at scale 0.85 -> 224 x 3.4px hairline = 0.04% of the frame each;
      measured object-region ink 0.17% (r3) / 0.52% (r7)
   <- strike-lines are separate FLEX ITEMS (same anchor => stacked with gap 44),
      so a "strike across a line" can never overlay the line it strikes
   <- no readability floor: nothing rejects a 3px element or an element with ~0 ink
   <- SPARSE check only counts elements (9 >= 8 -> density 7, not flagged as empty)
   <- textPixelShare<0.005 would fire, but the frame has a headline+caption so it is ~0.04
ROOT CAUSE = (a) primitives have no minimum visual weight, (b) same-anchor flex stacking forbids
the intentional overlaps that visual metaphors need, (c) no occupied-area/semantic-presence
empty-scene detector.
```

Also verified: the repair for scene_04 was not a rollback-safe transaction. It recompiled the scene
via the semantic path at 19:20, produced `rightMid 0.516%`, and there is **no `repair-scene_04.json`
report at all** (only `repair-scene_02.json` exists) — so nobody can audit what changed.

### RC4 — scene_05 mechanism missing; scene_02 rail missing

```
Storyboard mechanism not enacted
   <- storyboard.semanticObjects = AnswerLine/GateRow/CutFragment/BypassLine
   <- scene.elements = Circle, Label, Arrow, Label, Badge, Label
   <- Scene Composer prompt asks for "3-10 primitives (role + purpose)" and tells it to
      prefer "common params and well-known shapes" (motionPlanner.ts:114)
   <- the composer is a single LLM call with reasoning_effort=none and 12k token budget;
      structural objects it cannot map to a registry primitive become TEXT LABELS
   <- nothing validates "every semanticObject/relationship has >=1 rendered element"
   <- evidenceCoverage() greps the JSON's own text (headings, purposes, storyboard prose) —
      it cannot detect a missing rail because the storyboard TEXT still mentions "rail"
ROOT CAUSE = storyboard -> scene compilation has no coverage contract; the only verifier is a
text matcher over the same JSON that is supposed to prove it.
```

Evidence per scene: `e2e/audit-sb-coverage.txt`.
scene_02 storyboard objects: `Block/Outline/Outline/Outline/**Line**/Headline` ->
elements `Circle/Badge/Circle/Badge/Circle/Badge/Label` — **rail Line: absent** (the vision judge
and both QA passes reported it; the JSON confirms it).

### RC5 — storytelling 3.7: the schema cannot express progression

```
"scenes display instead of demonstrate"
   <- element motion = {delay, entrance, emphasis, emphasisAt} + scene-level exit
      (schema.ts common params; motion.ts:71-167; exit starts at duration-0.55 for ALL elements)
   <- no keyframes, no property interpolation between two states, no element->element interaction,
      no per-element exit, no relative placement, no "X moves into Y"
   <- storyboard.motionBeats[].atSeconds = null in 24/24 storyboards (never populated)
   <- so the composer has only stagger delays; every scene degenerates to "things fade in"
   <- storyboard asks for 5 ordered steps of transformation ("YES lifts to slot II and squashes")
      which the renderer literally cannot execute
ROOT CAUSE = missing VISUAL EXECUTION PLAN layer + a motion model with one entrance and one pulse.
```

This is the §7 question of the brief, answered: **yes, the intermediate layer is missing, and the
storyboard's temporal content is discarded at compile time.**

### RC6 — scene_06 headline x ring

```
Reported by vision QA (24% ring, 100% arrow) and by the deterministic model
   <- composition rightTextLeftObject (0% reference share), headline anchored "right",
      objects anchored "left" but with large inward offsetX (ox ~ +28% -> +302px)
   <- both groups drift toward centre -> guaranteed meeting zone
   <- conformance DETECTED it (textCollisions: ratio 0.24 and 1.00) -> composition score 0
   <- but the gate is: 1 re-ask, then `console.warn("accepted with unresolved collisions")`
      (motionPlanner.ts:188-201, repair.ts:133-146)
   <- and repair rounds r4..r7 never changed scene_06 (frames identical r3==r4, r5==r6==r7)
ROOT CAUSE = soft gate + no deterministic layout resolver. Detection exists; enforcement does not.
```

Model accuracy problem in the same area (why repairs keep missing):
`objectHorizontal()` uses `wBase * scale` (visual size) while the renderer's flex layout reserves the
**unscaled** box and scales around centre (`conformance.ts:136-165` vs `SceneRenderer.tsx:127-139`).
Measured: `Line` modelled 756px wide, actually 264px layout / 317px visual; headline modelled as the
full 46%/70% column while real glyphs are ~300px. The model therefore both **over-reports**
(headline vs ring) and **misses** real problems (it never checks frame bounds, object-object pairs,
or same-anchor pairs shifted by offsets).

### RC7 — artifact integrity (why "the numbers" lie)

```
final.mp4 != current scenes != qa-summary
   <- final.mp4 is a copy of preview.mp4 taken at 18:25 (pipeline.ts:289-291)
   <- subsequent runs repaired scenes and re-rendered preview (19:42) but never re-copied final
      (the run died / was resumed outside the finalize path; UI regeneration marks no stage)
   <- qa-summary.json is written only after the repair loop ends (pipeline.ts:281)
   <- no hash binds a QA report to the mp4 it scored; manifest says "complete" while status=fail
ROOT CAUSE = no render/QA artifact binding and no single "commit" step for the final artifact.
```

### RC8 — repair loop has no rollback / best-of

```
Repair can only make things worse and nobody can prove otherwise
   <- repairScene writes the scene immediately (repair.ts:151) before any re-render
   <- the baseline render is overwritten each round (pipeline.ts:268 renders to the same path)
   <- no before/after QA comparison, no keep-if-worse, no scene snapshots per round
   <- only 1 of the repairs produced a report (`qa/repair-scene_02.json`);
      semantic-path repairs (the majority) write no repair report at all
   <- repairRoundsMax = 2 per invocation, but runs are resumed repeatedly -> r1..r7 with no ledger
   <- failed repairs are silently skipped ("best-effort"), so a scene can sit in the plan forever
      (scene_06 was in the plan with COLLISION evidence and never changed)
DESIRED: baseline -> repair -> render -> QA -> better? keep : rollback
ACTUAL:  repair -> write -> render -> QA -> next (no baseline, no comparison, no rollback)
```

### RC9 — QA observes one still per scene

`extractSceneFrames` renders frame `cursor + duration*0.55` (`renderProject.ts:122`).
Every judge (vision 3x, semantic 2x, slop) scores `motionQuality` / `visualStorytelling` /
"rotation is not depicted" from **one still**. Judges correctly say "not decodable from a single
frame" — then score it low anyway. `technicalQa` is ffprobe-only (dims/fps/codec/duration/audio).

### RC10 — MiMo-specific fragility

- ~85 LLM calls per 25s video (18 storyboard + 6 compile + 49 QA per round + repairs).
- Largest calls output an entire scene JSON (12-16k tokens) with `reasoningEffort: none` — and the
  *repair* call must echo the full scene back (16k max) after reading bible + specs + memory.
- Historic failures are all schema/length failures, not reasoning failures:
  `otionalFit` typo, 400-char overflow, missing `issue/rootCause/scope` keys, HTTP 524 timeouts
  (3 projects stuck in `failed` state).
- The QA prompts each attach 6 base64 images + design bible + scene specs + storyboard intents —
  large payloads through a proxy with a 100s Cloudflare limit.

## 8. Benchmark findings (summary; full detail in `docs/BENCHMARK_GAP_ANALYSIS.md`)

| Benchmark | The one thing it does better | Applicable? |
|---|---|---|
| `Samin12/remotion-broll-kit` | **word-level transcript -> single timing file -> beat map**; 14 craft rules incl. readability floors; half-scale draft + stills-at-beats QA loop; proven spoken-content -> visual-mechanism table | **Highest** |
| `NewTurn2017/make-awesome-video` | **builder != judge**: fresh critic scores the actual MP4 (frozen time, empty frames, text collisions, loudness) with a per-round ledger; stills before motion; deterministic measurement scripts | **Highest** |
| `farhan-syah/motion-video-skill` | local Whisper word timing; per-scene **linter + audit**; sound synthesized from on-screen motion | High |
| `ggq-eng/motion-video-skill` | `movie.json` single source; **explicit x/y/w/h per element**; `sync_timings.js` derives scene duration AND element start times from narration; `validate_movie.js` | High |
| `madebysaira/RemotionPlaybook` | render vs reference **contact sheets**; explicit 10-point rubric; two graders must both pass; learnings file | Medium-high |
| `lucasgrow/remotion-mastery` | rules files incl. **measuring-text / measuring-dom-nodes**; preview between scenes; reusable component set | Medium-high |
| `iart-ai/tiktok-video-skills` | word-timed karaoke captions with safe-area placement; hook/retention grammar | Medium |
| `remotion-dev/template-prompt-to-motion-graphics-saas` | **skill detection**: inject only relevant guidance + example snippets per request; constants-first; crossfade state transitions | Medium |
| `motion-canvas/motion-canvas` | generator timeline (`yield*`), signals, editor preview, VO sync by construction | Medium (as design reference only) |
| `docusphere/claude-skill-motion-graphics` | CSV beat sheet: VO length / clip duration / SHOT / MOTION / TEXT per beat; style locked once | Low-medium (AI-video, not our render path) |

## 9. Architecture gaps

1. **No visual execution plan** (see RC5). Needed: storyboard -> `executionPlan`
   (ordered beats with `atSeconds` from VO, per-step element states, target layout band, expected
   evidence) -> compiled scene. Today the plan is *prose* inside the storyboard and is dropped.
2. **No measured layout.** Everything is anchor + heuristic `charW = fontSize * 0.70`
   (`layout.ts:74-128`). No DOM measurement at build/validation time, no frame-bounds check.
3. **No layout freedom for intentional overlap.** Same-anchor = stacked, cross-anchor = collision
   error. There is no "overlay" semantic, so strike-throughs, badges-inside-rings and
   line-on-baseline are structurally impossible — which is why metaphors degrade to labels.
4. **No empty/dull scene detector** (occupied area, hierarchy, expected semantic objects present,
   frame-to-frame change).
5. **No artifact binding** (render hash <-> QA report <-> final) and no per-round scene snapshots.
6. **No keep/rollback** in the repair loop.
7. **QA cannot see time** (one still per scene; no motion sampling, no frozen-frame analysis).

## 10. Primitive system (census across all 44 scene JSONs)

```
Line 41  Label 40  (headline)37  Circle 27  WordReveal 13  Arrow 13  Badge 9
GradientGlow 8  ProgressBar 7  Indicator 6  Grid 4  Stack 4  Subheadline 3
GenericCard 3  SpeechBubble 3  Caption 2  Comparison 2  Person 2
Timeline 1  Sequence 1  Number 1  Target 1  LightSweep 1

NEVER USED (17/39): Headline(as element), CharacterReveal, HighlightWord, CounterText, Quote,
Clock, Calendar, ProfileCard, Checkbox, BeforeAfter, Flow, Branch, Relationship, Progress,
SoftOrb, Grain, GridBackground
Diagram primitives used: 4/8 (Comparison 2, Timeline 1, Sequence 1)
```

Conclusions for §10 of the brief:
- The problem is **not** vocabulary size. `Line`, `Label`, `Circle`, `Arrow` absorb ~70% of usage and
  are exactly the shapes that "cannot express important concepts" (rail, gate, decay, bypass).
- Underuse is structural: the relational diagrams (`Relationship`, `Flow`, `Branch`, `Comparison`,
  `BeforeAfter`) are never selected by the composer even when the storyboard declares relationships.
- Higher-level **composition behaviors** (accumulate, escalate, compress, compare, transform,
  cause->effect, before/after, isolate, overload, progress, collapse, repeat) are exactly what
  `design-system/mechanisms.json` (46 mechanisms) describes — the taxonomy exists, the *execution*
  does not.
- Recommendation (not implemented): add a small number of **stateful composition behaviors** that
  operate over existing primitives (e.g. `accumulate`, `morphInto`, `strikeOver`, `shrinkToStub`,
  `routeThrough`) rather than more low-level shapes; and make the composer's primitive choice a
  deterministic mapping from `visualMechanism`.

## 11. Timing investigation (§11 of the brief)

> "Is the system choreographing visuals around spoken meaning, or assigning a scene duration and
> animating inside it?"

**The latter.** Concrete evidence:
- `timestamps.json`: 15 phrases, every one exactly 1.690886s (uniform).
- Beat boundaries off speech by 0.34-1.90s (RC1).
- `storyboard.motionBeats[].atSeconds` null 24/24; the composer prompt says "emphasisAt ~ the
  beat's emphasis moment" with no timestamp given to it.
- Element `delay` values are LLM guesses (scene_01: 0.10, 0.15, 0.45, 1.15, 1.95, 2.75, 3.55).
- Subtitle band is the *only* VO-coupled element, and its phrase boundaries inherit the same grid.
- Scene cuts are hard cuts with no transition planning (`ProjectRenderer.tsx:74-95`).

## 12. Responsiveness / hardcoding (§12)

Target is fixed 1080x1920 — that is fine. The issue is **internal robustness to content variance**:

- `1080`/`1920` are hardcoded in `layout.ts`, `conformance.ts`, `SceneRenderer.tsx:130` (offsets),
  not read from `OUTPUT` — a resolution change would silently desynchronise layout maths from render.
- Text width is estimated (`charW 0.70`, `maxWidthFor` 46%/70%/90%, `maxWidth: 928px`) with
  **no measurement of the actual string**, so long words/short words both mis-size boxes.
- `Line` base is a fixed 440px, `Circle` 368px, headline 96px, subtitle 34px at fixed offsets
  (`bottom: 14.5%` in the renderer vs `14%` safe-area in the model — 10px drift by design).
- No `diameterPct`/`lengthPct`/`thicknessPx` is ever set by the composer, so element size variance
  is effectively uncontrolled: one `Circle` at `scale 1.3` fills x53-98% of the frame (scene_05 r3).
- No check for "too many elements for the available bands" beyond the count-10 hard max.

## 13. Collision detection (§13)

| Question | Answer | Where |
|---|---|---|
| What does it measure? | axis-aligned boxes per anchor group, cross-anchor pairs, text-involving only | `conformance.ts:172-272` |
| Text bounds realistic? | heuristic (`fontSize*0.70`, column width); headline = full column, not glyphs | `layout.ts:100-129` |
| Font metrics calibrated? | claimed calibrated in STATUS; no DOM measurement, no per-glyph | — |
| Groups measured as groups? | yes, flex stack with gap 44, but **scaled heights** (renderer uses unscaled) | `conformance.ts:221-245` |
| Off-screen detected? | **No** | — |
| Overlap checked before render? | yes, at generation (1 re-ask) and repair (1 re-ask) | `motionPlanner.ts:188` |
| Hard gate or soft? | **soft** — warns and accepts | `motionPlanner.ts:197-201` |
| Can repair reintroduce? | yes; only cross-anchor text pairs are re-checked after repair | `repair.ts:133-146` |
| object x object | never checked | `conformance.ts:259` |
| same anchor | skipped by assumption (offsets/scale can still collide) | `conformance.ts:258` |
| subtitle x content | checked (ratio>0.35 vs 110px band) | `conformance.ts:284-297` |
| content x safe area | **not checked** | — |

Measured false positives/negatives on the current scenes (`e2e/audit-layout.txt`):
- scene_02 headline x Circle **0.68** reported (real glyph overlap much smaller) — accepted anyway.
- scene_04 subtitle x Line **1.00** (real, and *not* in the shipped conformance.json — stale).
- scene_06 headline x Arrow **1.00** (model box, not glyph) — accepted anyway.
- scene_03 clipping: **not reported at all**.

## 14. Empty-scene detection (§14)

What exists:
- `SPARSE` if renderable element count < 3 (`conformance.ts:413`).
- `TEXT_ONLY` if no non-text visual element (`conformance.ts:446`).
- `frameStats.textPixelShare < 0.005` -> typography -3 (`conformance.ts:588`).

What does not exist: occupied-area by region, per-element ink contribution, presence of the
*expected* semantic objects, visual hierarchy, frame-to-frame delta (motion presence), minimum
stroke/readability floor. Scene 04 (0.17% object-region ink, 9 elements) passes all three existing
checks. **This detector must be built** (deterministic, ffmpeg-based, cheap).

## 15. What NOT to change (short form; full DO-NOT-DO list in `docs/IMPLEMENTATION_PLAN.md`)

Do not rewrite the architecture, do not add primitives speculatively, do not lower QA thresholds,
do not use the reference video's scenes as templates, do not chase scores with decorative elements.
Keep: Zod contracts, deterministic rendering, multi-judge median QA, provenance-backed design
tokens, the storyboard contract, novelty + memory, honest failure reporting.
