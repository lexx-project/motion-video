# IMPLEMENTATION PLAN — motion-video (next phase)

Prepared: 2026-10-08. Input: `docs/AUTONOMOUS_AUDIT.md`, `docs/BENCHMARK_GAP_ANALYSIS.md`.
This document is a blueprint. **Do not start until you have re-read AUDIT §6 (rendered evidence)
and §7 (root causes).**

Priority key: **P0 = output-breaking**, P1 = major quality, P2 = important quality, P3 = polish.

Verification tools already in the repo (read-only, added by this audit, safe to use or delete):
`e2e/audit-frames.js` (ink/edge metrics), `e2e/audit-ascii.js` (visual preview as text),
`e2e/audit-probe.js` + `e2e/audit-summarize.js` (regions/components), `e2e/audit-layout.ts`
(deterministic layout boxes + collisions), `e2e/audit-storyboard-coverage.ts` (storyboard->element
mapping). None are included in `tsconfig.json` or vitest.

---

## P0 — output-breaking

### P0-1 Derive VO timing from the actual audio (word + silence alignment)

- **Problem:** Phrase timestamps are a uniform word-rate grid; scene boundaries are up to 1.9s away
  from real sentence boundaries, so a scene stays on screen while the next sentence is spoken, and
  subtitle phrases are sliced into orphan fragments.
- **Evidence:** `analysis/timestamps.json` = 15 x 1.690886s; ffmpeg `silencedetect` speech segments
  `0-2.59 | 3.09-4.21 | 5.22-7.71 | 8.74-10.48 | 11.52-15.55 | 16.55-20.30 | 21.32-23.97` vs
  `beats.json` boundaries `5.90 / 10.11 / 12.74 / 16.95 / 21.15` (error +1.18 / +1.90 / +1.74 /
  +0.90 / +0.34s). Code: `src/core/timing.ts:47-67` (`estimateTimingsFromDuration`),
  `src/agents/voTiming.ts:162-173` (silent fallback labeled `"phrase"`),
  `voTiming.ts:109-131` (`fitBeatDurations` adds an equal slice to every beat).
- **Files likely affected:** `src/core/timing.ts`, `src/agents/voTiming.ts`
  (new `src/core/audioAlign.ts`), `src/agents/motionPlanner.ts` (subtitle window),
  `tests/timing.test.ts`.
- **Expected result:**
  1. Speech segments from `ffmpeg silencedetect` become the primary structure (deterministic, free).
  2. Word-level transcript if available (API path already exists `voTiming.ts:60-87`;
     add optional **local** whisper CLI path as in farhan-syah/broll-kit); allocate words
     *inside* each speech segment instead of globally.
  3. Beat boundaries snap to speech-segment boundaries (within 0.25s), never inside a gap.
  4. `timingSource` becomes honest: `word` | `silence+proportional` | `estimated`.
  5. Subtitle phrases are grouped so a phrase never crosses a silence gap and never yields a
     fragment that starts mid-sentence.
- **How to test:** unit tests on a fixture WAV with known gaps: assert every beat boundary lies
  within 0.25s of a detected gap; assert phrase text chunks align to segments; assert
  `sum(durations) == audioDuration` (existing invariant).
- **How to verify visually:** extract frames at each scene boundary +/-0.4s from the rendered MP4;
  the caption text at `boundary+0.4s` must belong to the sentence that is *currently* spoken
  (compare against `silencedetect` segments / transcript). Expect zero "scene N shows while
  sentence N+1 speaks".
- **Risk:** medium. TTS voices can have soft gaps; tune the dB/duration thresholds per project and
  fall back to word-rate-within-segment if no gaps are found.
- **Dependencies:** none. Highest leverage single task in this plan.

### P0-2 Frame-bounds / safe-area HARD gate (fixes scene_03 clipping)

- **Problem:** Large-scale text is clipped by the frame; the model believes it fits; conformance
  gave the clipped scene its highest score (9.8).
- **Evidence:** right-edge ink 408-411px in the last 12px band for scene_03 r3..r7; ASCII preview
  shows glyphs flush to column 89/90; `SceneRenderer.tsx:130` applies
  `translate(...) scale(s)` (scale grows around centre after the anchor translate);
  `sceneLayoutBoxes` (`conformance.ts:172-247`) never compares to the frame; validation only
  checks offset sign (`schema.ts:254-276`).
- **Files likely affected:** `src/scenes/layout.ts`, `src/reference/conformance.ts`,
  `src/validation/schema.ts` (or new `src/validation/layoutGate.ts`), `src/agents/motionPlanner.ts`,
  `src/agents/repair.ts` (both collision re-ask loops), `tests/schema.test.ts`, `tests/phase2.test.ts`.
- **Expected result:** a single `layoutGate(scene)` that returns `clipping[]`, `collisions[]`,
  `subtitleCollisions[]` using a corrected box model:
  - visual box = layout box scaled about its centre (mirror `ElementInner` exactly),
  - rotation included (AABB of rotated box),
  - offsets applied as the renderer applies them,
  - every box must sit inside the safe area (8%/10%/14%) — anything outside is a **hard failure**,
  - called by `validateScene` (generation + repair + regeneration) and by `runConformance`.
  Also fix known model errors: `Line` box (model 756px vs actual 264/317px), headline box =
  glyph extent not full column width.
- **How to test:** fixture reproducing scene_03 (`WordReveal` scale 2.2 at `right`) must fail with
  an actionable message naming the element and the overflow amount in px; a scale-1 scene passes.
- **How to verify visually:** `node e2e/audit-frames.js <frames>` -> `edgeInk.right == 0` for every
  scene in the new render; ASCII preview shows an empty right margin band.
- **Risk:** low-medium. A too-strict gate will bounce scenes repeatedly — keep one corrective
  re-ask, then apply a **deterministic** fix (reduce scale / move to a wider anchor / shorten text)
  instead of accepting.
- **Dependencies:** none; do this before touching repair (otherwise repairs reintroduce clipping).

### P0-3 Readability floors + empty-scene detector (fixes scene_04)

- **Problem:** A scene with 9 elements renders as an almost-empty frame: hairlines below any
  readability threshold; nothing detected it.
- **Evidence:** object-region ink 0.17% (r3) / 0.52% (r7) vs 12.9% headline band;
  `objects.tsx:427-447` (`thickness = max(3, 4*s)`, `lengthPct` default 60 -> 264px at 0.85 scale);
  existing gates: `SPARSE` element-count only (`conformance.ts:413`) and global
  `textPixelShare<0.005` (`conformance.ts:588`).
- **Files likely affected:** `src/primitives/objects.tsx`, `design-system/primitives.json`,
  `src/reference/conformance.ts` (new `frameOccupancy`), `src/agents/qa.ts`, `src/agents/motionPlanner.ts`
  (prompt floors), `src/agents/repair.ts`, `tests/phase2.test.ts`, `tests/golden.test.ts`.
- **Expected result:**
  1. **Floors (deterministic, enforced in schema/conformance):** minimum stroke thickness for a
     `Line`/`Circle`/`Arrow` that carries `role:"semantic"` (>= 6px at scale 1, i.e. raise the
     default `thicknessPx` 3 -> 6 and require explicit values in prompts); minimum font size for
     readable labels (>= 28px effective after scale); minimum opacity 0.7 for anything not
     decorative; effective ink box of a semantic element must exceed a minimum area.
  2. **Empty-scene detector:** per-frame region ink (headline band / object bands / subtitle band)
     from the sampled stills + `semantic presence` (see P0-4). Hard-fail when the object band ink
     < threshold (calibrate on the reference frames: reference object bands measure in the 1-6%
     range; our scene_04 is 0.17-0.52%).
  3. Composer prompt: "every structural element must set size/thickness explicitly".
- **How to test:** scene_04 JSON fixture must fail the new detector; a scene with an explicit
  `thicknessPx: 8` line passes. Golden test updated with calibrated thresholds.
- **How to verify visually:** new scene_04-equivalent render shows a visible baseline/strike
  system; `audit-ascii.js` shows `+`/`#` level strokes rather than `.`/blank; object-band ink
  lands inside the reference range.
- **Risk:** medium — thresholds must be calibrated against `reference/analysis/frames`, not guessed.
  Do not "fix" by adding decorative mass (see DO-NOT-DO #4).
- **Dependencies:** P0-4 (needs sampled frames).

### P0-4 Deterministic multi-still + pixel metrics BEFORE any LLM judge

- **Problem:** QA inspects one still per scene at 55% of the scene and cannot see motion,
  emptiness, clipping or collisions deterministically.
- **Evidence:** `renderProject.ts:122` (`mid = cursor + duration*0.55`); all five judge prompts
  receive those stills; `technicalQa` is ffprobe-only.
- **Files likely affected:** `src/render/renderProject.ts`, `src/agents/qa.ts`,
  `src/reference/conformance.ts`, `src/agents/semanticQa.ts`, `src/core/output.ts`
  (thresholds), `tests/qa.test.ts`.
- **Expected result:**
  1. Extract **5 stills per scene** (t = 0.15/0.35/0.55/0.75/0.9 of scene duration).
  2. Compute per still: edge ink (4 sides), region ink, bbox, accent share, connected-component
     summary, subtitle-band collision (actual pixels, not model).
  3. Compute per scene: **motion presence** (mean abs pixel delta between consecutive sampled
     stills) -> flag static scenes; **semantic presence** (see P0-5).
  4. Emit `qa/frame-metrics.json`, feed the numbers into every judge prompt as ground truth
     ("object band ink = 0.2% — judge whether the frame communicates the beat"), and use them as
     hard gates in `aggregateQa`.
- **How to test:** unit test on a synthetic scene: static fixture flagged, moving fixture passes;
  clipped fixture produces `edgeInk>0`.
- **How to verify visually:** the report must show non-zero motion presence for every scene and
  zero edge ink; a human spot-checks 2 scenes against `audit-ascii.js`.
- **Risk:** low. Cost: 5x stills per scene per round (remotion `renderStill`, ~0.4s each measured)
  — acceptable.
- **Dependencies:** none; feeds P0-3 and P1-5.

### P0-5 Storyboard enactment coverage gate (fixes scene_02 rail, scene_05 mechanism)

- **Problem:** The composer silently drops structural storyboard objects and replaces them with
  text labels; the only verifier greps the same JSON text.
- **Evidence:** `e2e/audit-sb-coverage.txt` — scene_02 `Line (the single axis)` -> no element;
  scene_05 `AnswerLine/GateRow/CutFragment/BypassLine` -> `Circle + 3 Labels + Badge`;
  `semanticQa.evidenceCoverage()` searches `scene.storyboard` prose (`semanticQa.ts:104-154`),
  so a missing rail still "matches".
- **Files likely affected:** `src/agents/motionPlanner.ts` (compile + gate), `src/agents/repair.ts`,
  `src/agents/semanticQa.ts` (replace text-grep coverage), `src/validation/schema.ts`,
  `tests/phase3.test.ts`.
- **Expected result:** deterministic `enactmentCheck(storyboard, scene)`:
  - every `semanticObjects` entry with `importance >= 4` must map to >= 1 rendered element
    (by explicit `storyboardObject` reference on the element, **not** by fuzzy text match), or be
    provably carried by headline/subtitle;
  - every `relationships` entry must map to a declared layout relation (P1-3) or to an
    explicitly exempt mechanism;
  - `visualEvidence[]` entries must each be checkable against `qa/frame-metrics.json` or marked
    `requiresMotion` (checked by P0-4 delta).
  Missing coverage = hard failure with the exact missing object name (one corrective re-ask,
  then deterministic fallback: instantiate the object).
- **How to test:** scene_02 and scene_05 JSON fixtures fail with "rail Line not enacted";
  after a fix they pass.
- **How to verify visually:** new renders contain the rail line (scene_02) and the gate/bypass
  strokes (scene_05); semantic storytelling judge score should move first here.
- **Risk:** medium — mapping must be explicit in the contract (add `element.semanticObjectRef`),
  otherwise the gate degenerates into the same fuzzy matching it replaces.
- **Dependencies:** P1-3 for relationship enactment (start with object coverage).

### P0-6 Artifact integrity + repair rollback (keep/compare/rollback)

- **Problem:** `final.mp4` is 4 repair rounds stale, `qa-summary.json` describes a different video,
  repairs write immediately with no baseline and no comparison; a failed repair for scene_06 was
  silently skipped for 4 rounds.
- **Evidence:** AUDIT §6.1 (mtimes, byte-diffs at 7 timestamps), `repair.ts:151` (write on success),
  `pipeline.ts:268` (same output path each round), only `qa/repair-scene_02.json` exists,
  manifest `complete` while `qa-summary.status = fail`.
- **Files likely affected:** `src/agents/pipeline.ts`, `src/agents/repair.ts`,
  `src/core/projectStore.ts`, `src/agents/qa.ts`, `tests/project.test.ts`.
- **Expected result:**
  1. **Per-round snapshot:** `scenes/history/round-N/*.json` + `renders/round-N.mp4` +
     `qa/metrics-round-N.json` before each repair round.
  2. **Metric vector per round** (ink, edge, collisions, empty, motion, judge scores) -> keep the
     scene only if its vector improves on the dimensions that triggered the repair; otherwise
     restore the snapshot (rollback) and record `reverted` in the ledger.
  3. **Ledger:** `qa/repair-ledger.jsonl` — one row per attempted repair: scene, category,
     reason, before/after metrics, outcome (kept|reverted|failed|skipped), round.
  4. **Commit step:** after the final render, compute `sha256(render)`; write
     `qa/qa-summary.json` with `{renderHash, scenesHash}`; `final.mp4` is only copied from the
     render that matches that hash; `manifest.status = complete` requires
     `qa-summary.renderHash == sha256(final.mp4)`.
  5. A failed/skipped repair must surface in `aggregateQa` reasons (no silent skips).
- **How to test:** unit test that a deliberately-worsening repair is reverted; integration test
  that `final.mp4` hash equals `qa-summary.renderHash`; test that a stale summary is detected.
- **How to verify visually:** after the run, `final.mp4` and `preview.mp4` must be byte-identical,
  and `audit-frames.js` on frames extracted from `final.mp4` must match `qa/frame-metrics.json`.
- **Risk:** low-medium (some plumbing). This is what makes every other improvement auditable.
- **Dependencies:** P0-4 (metric vector).

---

## P1 — major quality

### P1-1 Visual execution plan + stateful motion model (the architectural gap)

- **Problem:** `storyboard.visualNarrative` (5 steps) and `motionBeats` (atSeconds **null 24/24**)
  are discarded at compile; element motion is `entrance@delay + 1 pulse + scene-level exit`
  (`motion.ts:71-167`), so every scene is "staggered appearance" -> `visualStorytelling 3.7`.
- **Evidence:** AUDIT RC5; `storyboardSchema.ts` `motionBeat.atSeconds` optional and never set;
  judge notes: "not decodable from a single frame", "returns a static diagram".
- **Files likely affected:** `src/validation/storyboardSchema.ts`, `src/validation/schema.ts`
  (element `states`), `src/primitives/motion.ts` (interpolate states), `src/agents/storyboard.ts`
  (require atSeconds from beat timing), `src/agents/motionPlanner.ts` (compile plan),
  `src/reference/conformance.ts` (richness now counts *rendered* states), tests.
- **Expected result:**
  1. Storyboard `motionBeats[].atSeconds` **required** and filled from VO beat timing
     (deterministic — derived in `runStoryboardStage` from `beatsWithTiming`, not invented).
  2. Scene element gains a deterministic state track, e.g.
     `states: [{at: 1.2, prop:"x|scale|opacity|text|...", value: ...}]` interpolated with the
     existing easing helpers — still a pure function of `(scene, frame)`.
  3. New `executionPlan` (either a scene field or derived at compile time) with ordered steps
     `{atSeconds, targets[], from, to, evidence}`; the compiler must emit states for every step.
  4. Conformance/semantic richness scores *rendered* state changes (frame delta between sampled
     stills around each `atSeconds`) instead of counting JSON fields.
- **How to test:** a fixture scene with two states produces different pixel metrics before/after
  `atSeconds`; a scene whose plan steps have no corresponding states fails validation.
- **How to verify visually:** scene_02 "YES moves down the rail and changes shape",
  scene_04 "three lines strike then dissolve", scene_05 "line shortens at gates, bypass passes" —
  visible in a 3-still strip per scene (start/mid/end).
- **Risk:** high (this is the real feature). Ship behind the existing schema with defaults so old
  scenes still validate; extend incrementally (one behavior at a time).
- **Dependencies:** P0-1 (needs real `atSeconds`), P0-4 (needs multi-still evidence).

### P1-2 Overlay / relationship layout semantics

- **Problem:** same-anchor elements are flex-stacked, cross-anchor overlap is an error, so
  intentional overlaps (strike-over-line, badge-in-circle, line-on-baseline) are impossible;
  metaphors degrade to adjacent labels.
- **Evidence:** `SceneRenderer.tsx:141-170` (AnchorGroup stacking), `conformance.ts:258-259`.
- **Files likely affected:** `src/scenes/SceneRenderer.tsx`, `src/scenes/layout.ts`,
  `src/validation/schema.ts` (`attachTo` / `layer`), `src/reference/conformance.ts`,
  `src/agents/motionPlanner.ts` prompt, tests.
- **Expected result:** an element may declare `attachTo: <elementIndex>` + offsets and render
  inside that element's positioned wrapper (deterministic); the collision model treats an attached
  element as part of its parent (no false positive) and checks it against *other* groups.
- **How to test:** strike line attached to an answer line renders overlapping and passes the gate;
  an unattached overlap still fails.
- **How to verify visually:** scene_04 strike lines visibly cross their answer lines; scene_02
  badges sit inside their circles.
- **Risk:** medium — must not become a loophole for random overlaps (limit: one attachment level,
  offsets bounded, still subject to frame bounds).
- **Dependencies:** P0-2 (gate must understand attachments).

### P1-3 Collision gate: accurate boxes + deterministic fixer

- **Problem:** model mismatches renderer (scaled vs unscaled boxes, headline = column width,
  `Line` 756 vs 264/317); object-object and same-anchor-offset collisions never checked; gate is
  soft (1 re-ask then accept) so scene_06 shipped with 24%/100% overlaps.
- **Evidence:** `e2e/audit-layout.txt`; `motionPlanner.ts:188-201`; `repair.ts:133-146`;
  scene_02 headline×Circle 0.68 accepted; scene_04 subtitle×Line 1.0 accepted (and undetected in
  the stale report).
- **Files likely affected:** `src/reference/conformance.ts`, `src/scenes/layout.ts`,
  `src/agents/motionPlanner.ts`, `src/agents/repair.ts`, `tests/phase2.test.ts`.
- **Expected result:** unified box function shared by renderer layout and validation
  (single source of truth); checks: cross-anchor text+object, object-object, same-anchor with
  offsets/rotation/scale, subtitle band vs measured content, frame bounds. After one re-ask,
  apply a **deterministic** fix (move the offending object to a free band / share the anchor)
  rather than accepting.
- **How to test:** fixtures for each collision class; assert the deterministic fixer produces a
  passing scene without an LLM call.
- **How to verify visually:** zero `COLLISION`/`SUBTITLE_COLLISION` in `conformance.json` **and**
  zero measured pixel overlaps in `frame-metrics.json`.
- **Risk:** medium (false positives cause churn) — calibrate on the reference frames as the current
  code already does.
- **Dependencies:** P0-2.

### P1-4 Independent critic on the final MP4 + round ledger

- **Problem:** all judges see the same single still and the same scene JSON; nobody grades the
  finished artifact; no record of what each round changed.
- **Evidence:** AUDIT RC7/RC9; benchmarks (make-awesome-video "builder never grades its own work";
  RemotionPlaybook two-grader rubric).
- **Files likely affected:** `src/agents/qa.ts`, `src/agents/pipeline.ts`, `src/agents/semanticQa.ts`.
- **Expected result:** a `finalCritic` pass that receives **only** the sampled stills + transcript
  (no scene JSON, no storyboard) and answers a fixed checklist: clipping, collision, empty frame,
  static frame, caption/VO alignment, mechanism readable?; its failures are hard reasons. Write
  `qa/critic-ledger.jsonl` per round.
- **How to test:** a fixture render with a known defect is caught by the critic checklist.
- **How to verify visually:** ledger rows exist for every round; final critic reports zero
  checklist failures before `complete`.
- **Risk:** low-medium (LLM cost); keep the checklist small and evidence-anchored to
  `frame-metrics.json` so the model verifies rather than opines.
- **Dependencies:** P0-4, P0-6.

### P1-5 Subtitle quality beyond coverage

- **Problem:** `subtitleCoverage = 10` is time-coverage only; phrases are sliced into fragments
  ("mind are the ones"); band collision is model-only; renderer bottom `14.5%` vs token `14%`.
- **Evidence:** `semanticQa.ts:157-168`; scene_04 phrase list; `SceneRenderer.tsx:63` vs
  `composition.safeArea.marginBottomPercent = 14`.
- **Files likely affected:** `src/agents/motionPlanner.ts` (`buildSubtitle`),
  `src/scenes/SceneRenderer.tsx`, `src/agents/semanticQa.ts`, `src/validation/schema.ts`.
- **Expected result:** phrases never cross silence gaps (P0-1); no fragment < 3 words that starts
  mid-sentence; band geometry shared as one constant with the safe-area token; measured pixel
  collision with content = hard fail; coverage metric splits into `timeCoverage` + `phraseQuality`.
- **How to test:** fixture with a mid-sentence split fails; band constant single-sourced.
- **How to verify visually:** captions read as complete phrases; no caption overlaps content.
- **Risk:** low. **Dependencies:** P0-1, P0-4.

### P1-6 Make the mechanism taxonomy executable

- **Problem:** `design-system/mechanisms.json` (46 mechanisms) is prose for the model; the composer
  picks generic `Line/Label/Circle/Arrow` (~70% of all elements across 44 scenes).
- **Evidence:** primitive census (AUDIT §10); 17/39 primitives never used; diagram primitives 4/8.
- **Files likely affected:** `design-system/mechanisms.json` (add per-mechanism *recipes*),
  `src/agents/motionPlanner.ts`, `src/agents/context.ts`, `src/reference/conformance.ts`.
- **Expected result:** each mechanism carries a deterministic recipe:
  `{requiredElements[], layoutPattern, stateSequence[]}` (the benchmark "mapping table" from
  broll-kit, adapted to our registry). The composer must instantiate the recipe; conformance
  verifies it. This is the cheapest route from "taxonomy exists" to "mechanism is enacted".
- **How to test:** `accumulation` recipe produces >= 2 growing elements with increasing count/scale
  across sampled stills.
- **How to verify visually:** mechanism-specific still strips change measurably across the scene.
- **Risk:** medium — recipes must stay optional enough to preserve novelty (they constrain
  *how*, not *what*).
- **Dependencies:** P1-1 (state sequences).

---

## P2 — important quality

### P2-1 Prompt economy for MiMo (skill detection + example snippets)

- **Problem:** ~85 LLM calls per 25s video; biggest calls echo a full scene JSON (12-16k tokens)
  through a 100s proxy; 3 projects died on schema/length errors.
- **Evidence:** failed manifests (`otionalFit`, 400-char overflow, missing repair keys, HTTP 524);
  `llm.ts:187-218` (12 transient attempts, 85s abort).
- **Files:** `src/agents/context.ts`, `src/agents/llm.ts`, `src/agents/repair.ts`,
  `src/agents/motionPlanner.ts`.
- **Result:** (a) inject only the primitive specs the mechanism recipe needs (already subset-capable
  via `primitiveSpecsFor`); (b) add 1-2 worked example snippets per high-frequency mechanism
  (remotion-dev skill-detection pattern); (c) repair prompt sends **diff-shaped** input (only the
  offending elements + constraints) instead of the whole scene; (d) keep
  `response_format`/`reasoning_effort` handling, add explicit token-budget guards.
- **Test/verify:** measure prompt sizes and 524 rate over one E2E run; repair success rate up.
- **Risk:** low. **Dependencies:** none.

### P2-2 Text measurement (replace `charW 0.70` heuristics)

- **Problem:** all text boxes are heuristics; both false positives and misses follow from it.
- **Files:** `src/scenes/layout.ts`, new `src/render/measureText.ts`, `src/validation/schema.ts`.
- **Result:** measure real glyph widths once per run using the already-available headless browser
  (bundle + `page.evaluate` with the actual `Archivo`/`Inter` faces) and cache to
  `design-system/fontMetrics.json`; validation/collision use measured widths.
- **Test/verify:** measured vs heuristic delta report; scene_03-class overflow caught pre-render.
- **Risk:** low-medium (needs a browser session; cache aggressively). **Dependencies:** P0-2.

### P2-3 Lessons memory (learnings file)

- **Files:** new `projects/_memory/lessons.md` + write hook in `aggregateQa`.
- **Result:** every failed QA round appends a one-line lesson (`scene_04: hairlines < 6px render
  invisible`) which is injected into generation/repair prompts (benchmark: learnings/gotchas files).
- **Risk:** low. **Dependencies:** P0-6 ledger.

### P2-4 Resolution-safe constants

- **Files:** `src/scenes/layout.ts`, `src/reference/conformance.ts`, `src/scenes/SceneRenderer.tsx`.
- **Result:** every `1080/1920` literal derived from `OUTPUT.width/height`; subtitle band bottom
  derived from `composition.safeArea.marginBottomPercent`; `Line`/`Circle` base sizes from tokens.
- **Risk:** low. **Dependencies:** none.

### P2-5 Semantic icon/SVG set + revive diagram primitives

- **Files:** `src/primitives/`, `design-system/primitives.json`, composer prompt.
- **Result:** small curated set (rail, gate, bracket, strike, arrowhead, check/cross — inline SVG,
  no network, no emoji per broll-kit rule 11) so the composer stops using bare `Label` for
  structure; make `Relationship`/`BeforeAfter`/`Comparison`/`Flow` reachable via recipes (P1-6).
- **Risk:** low-medium (primitive explosion risk — see DO-NOT-DO #2; cap at ~6 new glyphs, all
  recipe-driven). **Dependencies:** P1-6.

### P2-6 Accent discipline in typography primitives

- **Problem:** `Headline`/`WordReveal` fall back to **gold** when `accent === "none"`
  (`typography.tsx:50,108`), silently overriding storyboard intent (scene_04 wanted teal on
  `REMEMBERED`, scene_03 echoes became gold).
- **Files:** `src/primitives/typography.tsx`, `src/scenes/SceneRenderer.tsx` (headline element),
  `src/validation/schema.ts`.
- **Result:** headline accent derives from the scene's declared dominant accent; conformance
  counts the *rendered* accent pixels per scene, not just element fields.
- **Risk:** low. **Dependencies:** P0-4 (accent share already computed).

---

## P3 — polish

1. **Caption karaoke styling** (iart-ai word highlight) once P0-1 gives word times.
2. **Scene crossfades** for non-hard-cut beats (remotion-dev crossfade pattern) — style decision,
   keep hard cuts as default (reference language).
3. **Audio layer:** impact SFX synthesized from motion (farhan-syah) — only if it stays
   non-distracting for VO.
4. **Human-readable beat table** (`docs/BEATS.md` / UI) with VO length vs clip length (docusphere).
5. **`doctor` command** for environment checks (ffmpeg/whisper/browser/fonts).
6. **Delete dead code** (`src/agents/concepts.ts`) or restore it — currently neither.
7. **Reference before/after:** resume `proj_ref_demo` / `proj_e2e8` with the new pipeline to
   demonstrate improvement on earlier projects.

---

# DO NOT DO LIST (binding for the implementation phase)

1. **Do not rewrite the architecture.** Keep: scene JSON as the only scene representation,
   Zod validation, deterministic Remotion primitives, multi-judge median QA, provenance-backed
   design tokens, novelty + memory, honest failure reporting.
2. **Do not explode the primitive vocabulary.** Do not add 10+ new primitives "for richness".
   Add at most ~6 recipe-driven glyphs (P2-5) and prefer higher-level composition behaviors
   (P1-1/P1-6) over new low-level shapes.
3. **Do not add new agents/speculators.** Prefer deterministic tools and small structured calls.
   New *stages* are fine only when they are deterministic gates (layout gate, frame metrics,
   enactment check, commit step).
4. **Do not chase scores with decoration.** No extra objects, no random SVGs, no element-count
   padding, no decorative noise, no stuffing text. Empty-scene fixes must come from *legibility*
   and *enacted meaning*, not mass.
5. **Do not lower QA thresholds, widen tolerances, or "adjust" metrics to pass.** If a threshold
   blocks, fix the output or calibrate the threshold *against reference frames with evidence
   recorded in `PROVENANCE`-style notes* — never to make a scene pass.
6. **Do not hide defects:** no cropping/blurring to hide clipping, no disabling checks, no
   accepting broken repairs silently (P0-6 exists precisely for this).
7. **Do not hardcode scene-specific hacks.** No "if sceneId === scene_04" logic anywhere.
8. **Do not make every scene the same composition.** Preserve reference grammar distribution and
   novelty; a deterministic fixer must move objects, not homogenize scenes.
9. **Do not use the reference video's scenes or `reference/analysis/frames` as templates** — they
   are calibration data for thresholds and design tokens only (AGENTS rule 4).
10. **Do not blindly copy benchmark repos.** Adopt patterns (word timing, measurement gates,
    stills-at-beats, builder!=judge, ledgers); do not import their code, licensing, or their
    code-generation-from-prompt approach (AGENTS rule 1 forbids arbitrary JSX/Remotion code).
11. **Do not replace the vision judges with a single model's opinion**, and do not remove the
    median/variance/confidence machinery.
12. **Do not implement everything at once.** Land P0-1..P0-6 first, run one E2E, measure, then P1.
13. **Do not edit `MASTER_SPEC.md` thresholds** to reflect reality; fix reality to match them
    (overall >= 8, storytelling >= 8, slop <= 6).
14. **Do not fabricate word timestamps.** If no transcript is available, use silence-aligned
    proportional timing and label the source honestly (`silence+proportional`), never `word`.

---

# SUCCESS CRITERIA (proven by an actual E2E render, not by code review)

Run `npm run generate -- --script e2e/p3-script.md --voice e2e/p3-voice.wav --id proj_p3_e2e2
--resume`-equivalent fresh project, then verify **all** of:

**Hard (must be zero):**
- [ ] `edgeInk == 0` on all 4 sides for every sampled still (no clipping).
- [ ] Zero `COLLISION` / `SUBTITLE_COLLISION` in `conformance.json` **and** zero measured pixel
      overlaps in `qa/frame-metrics.json`.
- [ ] No scene with object-band ink below the calibrated floor (no empty scenes); scene_04-class
      failures must be caught pre-render.
- [ ] Every storyboard `semanticObject` with importance >= 4 is enacted (gate report green).
- [ ] Every scene has non-zero motion presence across sampled stills (no static scenes).
- [ ] Scene boundary within 0.25s of a detected speech gap; captions read as whole phrases.
- [ ] `qa-summary.renderHash == sha256(final.mp4) == sha256(preview.mp4)`; `manifest.complete`
      only when `qa-summary.status == pass`.
- [ ] `npm run verify` green (typecheck + tests).

**Quality (targets — do not fake them):**
- [ ] overall quality >= 8 (currently 6.16)
- [ ] semantic relevance >= 8 (currently 5.6)
- [ ] visual storytelling >= 8 (currently 3.7) — verified by 3-still strips showing state change
- [ ] evidence coverage >= 5 (currently 3.3), computed from **frames**, not JSON text
- [ ] slop <= 6 (currently 7)
- [ ] reference conformance >= 8 without any scene scoring 0 on composition (currently scene_06 = 0)

**Human visual inspection (mandatory before claiming success):**
- [ ] `e2e/audit-ascii.js` (or a human eye) confirms per scene: mechanism readable without audio,
      no orphan labels, headline clear of objects, captions legible, accents disciplined (one
      dominant accent), scene variety across the 6 beats.
- [ ] Side-by-side still strips (start/mid/end) for all 6 scenes reviewed.

**If a target cannot be reached, document the blocker per scene with numbers.** Never claim
completion on "code looks cleaner" — the rendered video is the truth.
