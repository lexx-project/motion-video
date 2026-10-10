# BENCHMARK GAP ANALYSIS — motion-video

Date: 2026-10-08. Method: read public repository READMEs and primary skill documents
(SKILL.md / playbook) on 2026-10-08; compared against the **verified** state of this repo
(`docs/AUTONOMOUS_AUDIT.md`). No benchmark was copied; ideas are mapped to our actual
bottlenecks (RC1-RC10).

Legend — Applicability: **Direct** (adopt the pattern), **Adapt** (adopt the idea, re-architect the
form), **Reference only** (do not adopt), **N/A**.

---

## 1. farhan-syah/motion-video-skill

- **Purpose:** Agent skill that turns a one-line brief into a directed motion-graphics MP4.
  HTML/CSS/SVG per scene, rendered frame-exact with headless Chromium + ffmpeg; audio SFX
  synthesized from on-screen motion.
- **Relevant ideas:**
  1. **Local Whisper word timing** (models on disk, `speak`/`transcribe` commands) — captions and
     scenes both follow real speech with zero provider dependency.
  2. **Per-scene linter + `audit`** — deterministic static checks on each scene before render.
  3. `references/craft.md` = explicit **craft thresholds** as data, not prose.
  4. Sound effects derived from the motion itself ("every hit lands on its frame").
  5. `doctor` command: environment truth before starting.
- **Architecture:** `SKILL.md` workflow -> `direction.md` -> one HTML file per scene -> lint ->
  render -> `out/video.mp4`. Kit of UI parts, 1854 icons, fonts, canvas/WebGL/GSAP/Lottie.
- **What they do better:** environment determinism, pre-render linting, word-level VO sync,
  audio as a first-class output.
- **Our equivalent:** `validateScene` (Zod) + `textCollisions`; `voTiming.ts` (API whisper only);
  no lint/audit stage; no audio beyond the VO track.
- **Our gap:** no pre-render *visual* lint (bounds, weight, density); our transcription is
  provider-gated and silently degrades (RC1).
- **Applicability:** Direct (local whisper, scene linter, craft thresholds as data).
- **Priority:** P0 for word timing; P1 for lint/audit.

## 2. Samin12/remotion-broll-kit

- **Purpose:** Word-synced motion-graphics B-roll for vertical reels; complete method + template +
  full annotated source of a 43.9s reference video.
- **Relevant ideas:**
  1. **Word-level transcript -> one timing file** (`src/lib/constants.ts`): scene boundaries as
     absolute frames, beats relative to scene start, each beat commented with the spoken word and
     its timestamp. "Timing comes from a word-level transcript, never from guessing."
  2. **14 non-negotiable craft rules**, including: readability floors (min 36px display, min 0.7
     opacity for anything still readable), continuous motion / idle layers, clamp every
     interpolate, deterministic only, fill the canvas, draw don't embed.
  3. **Proven spoken-content -> visual-mechanism table** (12 rows: big number -> rolling counter;
     negation -> red stamp slam; list -> checklist slot-machine; process -> node pipeline ...).
  4. **One canvas concept per scene**; related beats share ONE component with *phased states*
     instead of rebuilding the same cards.
  5. **QA loop:** half-scale draft render -> still at every key beat -> checklist (squint test,
     overlap, opacity, canvas fullness, impact lands ON the beat frame, no parked half-states)
     -> fix -> cheap still re-render -> watch with audio once.
  6. Beat-map quality checks: no scene < 60 frames, no scene > ~370 frames without internal beats,
     first beat within 20 frames.
- **Architecture:** `constants.ts` (timing) + `theme.ts` (tokens) + `ui.tsx` (design-system API:
  `slam`, `ease`, `riseIn`, `countValue`) + one file per scene mounted via `<Sequence>`.
- **What they do better:** **every movement lands on a spoken word**; explicit readability floors;
  a QA loop that inspects *the beats*, not one mid-scene still.
- **Our equivalent:** `subtitle` phrases (grid-derived), `elementMotionStyle` entrances,
  `conformance` density rules.
- **Our gap:** no word timing (RC1); no readability floor (RC3); QA samples 1 still/scene (RC9);
  no per-beat still inspection; no mapping table from spoken content to mechanism.
- **Applicability:** Direct — this is the closest structural analogue to our problem.
- **Priority:** P0 (timing), P0 (readability floor), P0 (beats-still QA).

## 3. madebysaira/RemotionPlaybook

- **Purpose:** Recreate the motion language of an admired brand video with agents, then rebrand it.
- **Relevant ideas:**
  1. Reference video -> segments -> **contact sheets** (models that cannot watch video can still
     read motion) -> Gemini writes a scene spec per segment -> Claude builds in Remotion ->
     **compares its render against the ground-truth frames** -> iterates.
  2. Explicit **10-point grading rubric** (the reference video only said "it knows what good
     looks like").
  3. **Two graders** with different failure modes must both pass; only 9/10+ moves on.
  4. **Learnings file** so run five is better than run one.
  5. PySceneDetect pre-pass instead of arbitrary 5s cuts.
- **Architecture:** scripts (ffmpeg/Python) + prompts (scene reader, executor brief, rubric) +
  `playbook.md` + learnings.
- **What they do better:** render-vs-ground-truth comparison, rubric-driven acceptance, memory of
  mistakes.
- **Our equivalent:** reference conformance (structure + frame stats, explicitly *not* pixel
  similarity — by design, correct for us), 3-judge vision median, `projects/_memory/history.json`.
- **Our gap:** we never compare our render against *anything* measurable per beat; our rubric is
  numeric but not item-verified; memory stores novelty inputs, not lessons.
- **Applicability:** Adapt (keep "no pixel similarity vs reference" rule; adopt render-vs-expectation
  checks and a learnings ledger).
- **Priority:** P1.

## 4. lucasgrow/remotion-mastery

- **Purpose:** Idea/reference -> rendered .mp4 via three chained Claude Code skills.
- **Relevant ideas:**
  1. `/remotion-video-toolkit`: **29 rule files** covering the Remotion API — including
     `measuring-text` and `measuring-dom-nodes`, `captions`, `transitions`, `timing`.
  2. `/video-director` 6-phase pipeline with **preview between scenes** and one-question-at-a-time
     discovery.
  3. `/reels-playbook`: deconstruct a reference into `PLAYBOOK.md` (composition, overlays,
     transitions, palette, audio sync) that feeds the director.
- **Architecture:** skills chain, each with a narrow output contract.
- **What they do better:** measuring text/DOM as a first-class rule (we never measure); per-scene
  preview checkpoints.
- **Our equivalent:** `wrapLines`/`horizontalTextBoxFor` heuristics; render-only preview.
- **Our gap:** no measurement (RC2/RC6); no per-scene preview gate.
- **Applicability:** Adapt (measurement rules -> our validation layer).
- **Priority:** P0 (measurement feeds the frame-bounds gate).

## 5. motion-canvas/motion-canvas

- **Purpose:** TypeScript library + editor for programming animations; "designed to create
  informative vector animations and synchronize them with voice-overs" (19.3k stars).
- **Relevant ideas:** generator-based timeline (`yield*` sequential choreography), signals/vars for
  state, real-time editor preview, audio track sync built in, scene/segment structure.
- **Architecture:** monorepo `2d`/`core`/`ui`/`player`/`docs`; animations are *code*, authored by
  humans, previewed live.
- **What they do better:** temporal authoring model — animations are sequences of *states*, not
  staggered entrances; VO sync is a primitive.
- **Our equivalent:** `delay/emphasis/emphasisAt` + hard cuts.
- **Our gap:** exactly RC5 (no state progression, no timeline language).
- **Applicability:** Reference only — we must not abandon scene-JSON determinism (AGENTS rule 1);
  adopt the *concept* (beats as ordered state transitions), not the runtime.
- **Priority:** P1 (conceptual source for the visual execution plan).

## 6. remotion-dev/template-prompt-to-motion-graphics-saas

- **Purpose:** Official Remotion template: natural-language prompt -> Remotion code, live preview.
- **Relevant ideas:**
  1. **Validation before expensive calls** (cheap classifier rejects non-visual prompts).
  2. **Skill detection:** modular *guidance skills* (charts, typography, transitions, sequencing,
     spring-physics, social-media safe zones) + *example skills* (complete working snippets)
     injected only when relevant — "keeps the base prompt lightweight".
  3. Constants-first output; crossfade state transitions (no layout jumps); spring physics.
- **Architecture:** prompt -> sanitize -> Babel-compile in browser -> Remotion Preview.
- **What they do better:** token-efficient prompt assembly; safe zones as a skill; state
  transitions without layout jumps.
- **Our equivalent:** `primitiveSpecsFor(subset)` (already subset-scoped for repair) +
  `designBibleCompactPrompt()`.
- **Our gap:** our composer gets the full compact bible + full storyboard every time; no
  mechanism-keyed "example" snippets (we have no examples at all).
- **Applicability:** Adapt — inject *example snippets keyed by `visualMechanism`* into the composer.
- **Priority:** P2.

## 7. ggq-eng/motion-video-skill (motion-video-maker)

- **Purpose:** Structured explainer-animation videos from text/Markdown; Web preview then mp4.
- **Relevant ideas:**
  1. `movie.json` = single source of truth; **never edit the HTML** (mirrors our "never bypass
     scene JSON" rule — validates our direction).
  2. `scripts/sync_timings.js`: **scene duration AND element start times are derived from
     `scene.narration`** — "must be derived from narration, never evenly divided by feel".
  3. **Every element declares explicit `x, y, w, h`** — deterministic layout, no anchor guessing.
  4. `validate_movie.js` structural validation; `references/animation-rules.md` maps text semantics
     -> layout + animation templates (e.g. "definition sentence -> big title + emph sub + fade-up").
  5. Timing rules: scene must cover its narration + buffer; split scenes rather than compress
     animation; `itemStaggerMs` scales with narration length.
- **Architecture:** schema -> validate -> sync timings -> preview -> confirm -> export.
- **What they do better:** narration-derived timing (deterministic, no LLM), explicit boxes,
  text->template mapping table, validator.
- **Our equivalent:** `buildSubtitle()` (VO-injected) + anchor groups.
- **Our gap:** RC1 (timing), RC6 (no explicit boxes / no measured layout).
- **Applicability:** Direct for timing derivation; Adapt for boxes (we can keep anchors if we
  measure the resulting box).
- **Priority:** P0 (timing), P1 (boxes).

## 8. iart-ai/tiktok-video-skills

- **Purpose:** Skill pack for vertical video craft: hook/retention grammar, karaoke captions,
  countdowns, lower thirds.
- **Relevant ideas:**
  1. `caption-animation`: **word-timed, karaoke-style captions with safe-area placement**
     (per-word pop, active-word highlight).
  2. `short-form-video`: hook -> retention -> loop grammar, pattern interrupts, pacing.
- **Architecture:** small independent skills, each with one contract.
- **What they do better:** caption quality as a dedicated craft; retention structure.
- **Our equivalent:** phrase-level caption band with gold emphasis words.
- **Our gap:** our captions are phrase-grid slices with orphan fragments (RC1); no safe-area
  verification against real content (subtitle collision only in the model).
- **Applicability:** Adapt (word timing first; karaoke styling optional/later).
- **Priority:** P1 (after word timing exists).

## 9. NewTurn2017/make-awesome-video

- **Purpose:** Direct pro motion-graphics launch videos with an agent instead of one-shot prompts.
- **Relevant ideas (the richest set for us):**
  1. **"The builder never grades its own work."** A fresh sub-agent knowing only the brief and
     references judges the **actual MP4**: frozen time, loudness, **empty frames**, **text
     collisions**, transitions. Each revision is verified item-by-item by another fresh critic, and
     every round goes into a **ledger**.
  2. **Still frames before motion** — one hero frame per scene; fixing a storyboard takes seconds,
     fixing a render means rendering again.
  3. **3 storyboard variants that each take a different direction**, then 4 human gates
     (references, storyboard, stills, notes).
  4. **Deterministic measurement scripts:** `frozen_time.sh` (exit 1 on hold > 0.6s),
     `frame_pops.py`, `loudness.sh`, `contact_sheet.sh`, `loop_seam.py`, `analyze_ref.sh`.
  5. **Motion kit** of seek-safe helpers: `fitWidth`, `typeOn`, `maskRise`, `slam`, `panelWipe`,
     `wordWall`+`gridStagger`, `noiseField`, beat `snap`.
  6. `references/motion-grammar.md` (scene-to-scene rules, mechanism catalog),
     `quality-bar.md` (measured targets + "reads as cheap" checklist),
     `critic-loop.md` (builder != judge), `gotchas.md` (verified pitfalls).
- **Architecture:** SKILL.md with 4 gates; mode detection; reference decomposition -> shot list.
- **What they do better:** independent critic on the real artifact; ledger; deterministic
  render-quality scripts; stills-first iteration.
- **Our equivalent:** 3-judge vision QA (but same pipeline, no independence guarantee, one still),
  novelty memory, `docs/STATUS_PHASE3.md` bug log (ad hoc).
- **Our gap:** RC7/RC8/RC9 — no independent critic on the final MP4, no ledger, no empty-frame /
  frozen-time / collision measurement scripts.
- **Applicability:** Direct.
- **Priority:** P0 (deterministic frame QA) + P1 (critic ledger).

## 10. docusphere/claude-skill-motion-graphics

- **Purpose:** Beat-sheet CSV -> asset/VO/music generation (Higgsfield) -> Remotion assembly.
- **Relevant ideas:** CSV beat sheet columns are a usable storyboard shape: `Scene, Beat Label,
  VO Script, VO Length, Clip Duration, SHOT, MOTION, TEXT ON SCREEN, AUDIO, Source, Status`;
  **style locked once** then reused; phase-jumpable commands; guided iteration for known defects.
- **Architecture:** CSV -> scaffold -> generate per scene -> assemble -> iterate.
- **What they do better:** a flat, human-editable beat table with VO length per beat; style lock.
- **Our equivalent:** `analysis/beats.json` + `storyboard-bN.json` (richer, but machine-only).
- **Our gap:** our beat table is not reviewable/editable by a human in one place; VO Length vs
  Clip Duration distinction we handle implicitly.
- **Applicability:** Adapt (a readable beat table in the UI / a `docs/` report).
- **Priority:** P3.

---

# CAPABILITY MATRIX

`CAPABILITY | OUR PROJECT | BENCHMARK | GAP | SEVERITY | RECOMMENDATION`

| Capability | Ours (verified) | Best benchmark | Gap | Sev | Recommendation |
|---|---|---|---|---|---|
| Semantic visual storytelling | storyboard prose rich; rendered scenes "display" (storytelling 3.7) | broll-kit mechanism table + phased states | No enactment path | P0 | Add execution plan + mechanism->behavior mapping |
| Visual concept generation | 3-5 mechanism-differentiated candidates + 13-criteria selection | make-awesome-video 3 divergent variants | Ours is strong | — | Keep |
| Storyboard representation | Excellent contract (narrative/objects/relationships/forbidden) | comparable | None | — | Keep; require `motionBeats.atSeconds` |
| Visual execution plan | **Absent** (dropped at compile) | motion-canvas sequences; ggq sync_timings | Missing layer | P0 | New `executionPlan` stage, deterministic compile |
| Object relationships | Declared in JSON; not rendered | broll-kit "one canvas concept, phased states" | Not visualized | P0 | Overlay/relationship layout semantics |
| Semantic object richness | richness=10 (structural, always max) | — | Metric is vacuous | P1 | Replace with rendered-evidence richness |
| Composition | 11 grammars, reference shares | reference shares (ours) | off-grammar accepted (scene_06) | P1 | Reject/off-grammar needs explicit justification |
| Deterministic layout | anchor groups + gap 44 | ggq explicit x/y/w/h | No measurement | P0 | Measure boxes (DOM or calibrated metrics) |
| Responsive layout | %-based anchors, px internals | — | Internal robustness only | P2 | Derive all px from OUTPUT + measure |
| Safe areas | 8/10/14% tokens; offset-sign guard only | iart captions safe-area; broll `SAFE_X` | **No bounds gate** | P0 | Frame-bounds validation + hard fail |
| Typography | strong tokens; forced-gold accent; no min-size floor | broll rule 9 readability floors | floors missing | P0 | Min font/opacity/weight rules |
| Subtitle timing | phrase grid (uniform), injected deterministically | broll/ggq word-level | Not VO-derived | P0 | Local/API word transcript + silence-aware phrases |
| Word/phrase sync | none (no word data) | broll-kit, farhan-syah, iart | Missing | P0 | Word timestamps -> beats + captions |
| VO synchronization | scene error 0.34-1.90s | broll constant file w/ word comments | Material desync | P0 | Silence-detect + word alignment |
| Motion choreography | entrance + 1 pulse + scene exit | motion-canvas sequences; broll slam/ease | Cannot express states | P1 | Per-beat state keyframes in plan |
| Transitions | hard cuts | crossfade patterns (remotion template) | OK for our style | P3 | Optional crossfade later |
| Asset usage | none (pure primitives) | farhan-syah kit of parts | Low impact | P3 | Only if semantically needed |
| SVG/icon usage | inline SVG in primitives; no icon set | farhan 1854 icons; broll inline SVG | Icons unavailable to composer | P2 | Small curated semantic icon set |
| Visual metaphor | mechanisms taxonomy (46) exists | broll mapping table | Taxonomy not executable | P1 | Make mechanisms executable |
| Scene diversity | novelty 7-dim + memory | make-awesome-video reference decomp | OK | P2 | Keep; add composition-diversity metric |
| Novelty | implemented, all accept | — | Thresholds loose (35 max seen) | P3 | Keep |
| Renderer fidelity | deterministic, fonts delayRender | — | Strong | — | Keep |
| Collision prevention | model exists, **soft gate**, inaccurate boxes | ggq explicit boxes | Detection w/o enforcement | P0 | Hard gate + accurate boxes |
| Clipping prevention | **absent** | broll SAFE_X, iart safe areas | Critical | P0 | Frame-bounds hard fail |
| Empty-scene prevention | SPARSE count + textPixelShare | make-awesome-video empty-frame script | Not detected | P0 | Region-ink + semantic-presence detector |
| Render inspection | 1 still @55% per scene | broll stills at every beat; MAV contact sheets | Blind to motion | P0 | Multi-still per scene + motion delta |
| Semantic QA | 2 judges + text-grep coverage | MAV fresh critic on MP4 | Text-grep is weak | P1 | Frame-derived evidence checks |
| Visual QA | 3 judges, median/variance | rubric + dual graders | Good method, weak input | P1 | Feed better evidence |
| Technical QA | ffprobe only | MAV frozen_time/frame_pops/loudness | Shallow | P1 | Add pixel/motion checks |
| Repair loop | routed, per-scene, best-effort | MAV ledger + verify per item | No verification of repairs | P1 | Verify + keep/rollback |
| Rollback | **absent** | implied by ledger/compare | Critical | P0 | Snapshot per round, keep-if-worse |
| Iteration | resumed runs, no ledger | MAV critic rounds, learnings file | Untracked | P1 | Round ledger |
| Project memory | novelty memory + dedup | learnings/gotchas files | No lessons stored | P2 | Add `projects/_memory/lessons.md` |
| Failure recovery | resume/caching, stage invalidation | `doctor`/setup checks | Good | P2 | Keep; add artifact-integrity check |

---

## Cross-cutting conclusions

1. **Every high-value benchmark independently converges on word-level transcript as the timing
   source.** We are the only one using a uniform grid. This is our single largest deviation from
   mature practice (RC1).
2. **Every mature system inspects the actual artifact with deterministic measurements** (contact
   sheets, frozen-time, empty-frame, collision scripts) *before* any LLM judge. We start with LLMs.
3. **The "builder != judge" principle is universal** in the stronger projects; our judges are
   independent *models* but not independent *evidence* — they all see the same single still.
4. Nobody else uses a primitive-registry scene schema, and that is our differentiator — but all of
   them have either explicit boxes or measurement. We have neither.
5. Not applicable from benchmarks: reference-video segment cloning (would violate our rules),
   arbitrary code generation from prompts (violates AGENTS rule 1), AI-video/asset generation
   pipelines (out of scope for our deterministic renderer).
