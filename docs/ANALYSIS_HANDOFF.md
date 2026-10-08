# MOTION-VIDEO STUDIO — ARCHITECTURE & CURRENT-STATE HANDOFF

> Purpose: full technical handoff for an external analysis AI. Covers architecture, data flow,
> heuristics, failure history, current quality scores, and open problems. Repo root:
> `C:\Users\Administrator\Documents\project\motion-video`. Source of truth: `MASTER_SPEC.md`,
> rules: `AGENTS.md`.

---

## 1. WHAT THIS SYSTEM IS

AI-driven motion-design studio: `SCRIPT + VO → semantic beats → visual concepts → validated
SCENE JSON → deterministic Remotion render → multi-judge QA → local repair loop → MP4`.
LLMs never emit JSX/code; they emit structured JSON validated by Zod against a primitive
registry. Output: 1080×1920, 30fps, H.264+AAC.

Primary model: `oc/mimo-v2.6-flash-free` via OpenAI-compatible endpoint
(`router-asli` provider in `~/.config/opencode/opencode.jsonc`, resolved at runtime by
`src/agents/llm.ts:resolveLlmConfig`). Model is a **reasoning model** (hidden thinking tokens
count against `max_tokens`) — this drives several failure modes below.

---

## 2. REPOSITORY MAP

```
design-system/          # machine-readable design language (V2 = reference-derived)
  colors.json           # bg #0B1313 (teal-black), text #F4F2ED, accents teal/gold/orange/red
  typography.json       # Archivo 900 headline 96px@1080, LEFT align default, tier scale
  composition.json      # 11 grammars + referenceShares (leftTextRightObject 0.30 ...), safeArea 8/10/14%
  motion.json           # vocab fade/reveal/slide/scale/draw/stagger..., measured frame-diff 0.0112
  primitives.json       # 38 primitives + per-param specs (enums!) — DRIVES VALIDATION
  forbidden-patterns.json  # 16 slop pattern ids for the Slop Critic
  PROVENANCE.md         # token→source→confidence ledger (reference-derived; no fabricated values)
  MASTER_DESIGN_BIBLE.md
reference/
  reference.mp4         # 118.7s, 1024×576, 30fps (landscape!), ONE-TIME design source, never runtime
  analysis/             # deterministic extraction output (see §5)
src/
  core/
    output.ts           # OUTPUT {1080,1920,30,h264,aac}, QA_THRESHOLDS{overall>=8, slop<=6, novelty<=70}, PIPELINE{repairRoundsMax:2, llmAttemptsMax:2}
    errors.ts           # StudioError{stage, projectId, sceneId, recoverable, explanation}
    timing.ts           # phrase-level VO timing fallback (never fake word precision)
    designSystem.ts     # typed accessors over design-system JSON
    projectStore.ts     # projects/<id>/ manifest, stage marks, scene IO, global memory (novelty)
  validation/
    schema.ts           # sceneSchema (Zod) built from primitives.json + hard layout rules (§7)
    validate.ts         # validateScene / validateScenes / validateProjectTimeline
  primitives/           # 38 deterministic components
    registry.ts         # name → component; unknown name = hard fail
    typography.tsx      # Headline, Subheadline, Label, Caption, WordReveal, CharacterReveal,
                        # HighlightWord, CounterText, Quote
    objects.tsx         # Clock, Calendar, ProfileCard, GenericCard, Target, ProgressBar,
                        # Checkbox, Arrow, Line, Circle, Stack, Grid, Indicator, Number, Badge
                        # (fs() helper: text never below label.min=26px)
    diagrams.tsx        # Timeline, Comparison, BeforeAfter, Flow, Branch, Relationship,
                        # Progress, Sequence (same fs() floor)
    atmospheric.tsx     # GradientGlow, SoftOrb, Grain, GridBackground, LightSweep
    motion.ts           # elementMotionStyle: entrance/emphasis/exit from motion.json, deterministic
    sceneClock.tsx      # per-scene React context (time/frame)
  scenes/
    layout.ts           # PURE layout math: anchor(), headlinePositionFor(), maxWidthFor(),
                        # wrapLines(charW=0.70em measured), horizontalTextBoxFor (incl. overflow
                        # of long single words), textBoxFor, overlapArea
    SceneRenderer.tsx   # groups elements by anchor → flex column, gap 44, justify start/center/end;
                        # scene.headline joins its anchor group (z90); same-anchor = NEVER overlaps
    ProjectRenderer.tsx # Sequence per scene + <Audio staticFile> + font loader (bundled woff2)
  render/
    Root.tsx            # Composition "Project" w/ calculateMetadata from props.scenes
    renderProject.ts    # bundle cache keyed by mtime(src+design-system+public), 404-/public/→
                        # rebundle+retry-once guard, renderMedia h264/aac, extractSceneFrames,
                        # probeRender (ffprobe ground truth)
  agents/
    llm.ts              # provider resolve, serial queue (concurrency 1, 0.9-1.6s jitter gap),
                        # chatRaw retry ladder (§8), completeJson (structured +1 re-ask),
                        # extractJson (balanced scan + trailing-comma + truncation detection),
                        # chatVision (base64 mime sniff jpeg/png)
    context.ts          # designBiblePrompt (full ~11KB), designBibleCompactPrompt (~2KB, QA),
                        # sceneRulesPrompt (HARD layout rules shared by generate/repair),
                        # primitiveSpecs()/primitiveSpecsFor(subset), memoryPrompt (novelty history)
    scriptAnalyst.ts    # analysis (meaning/keywords) + semantic beats (3-9, meaning units)
    voTiming.ts         # ffprobe duration → (timestamps.json | whisper attempt | phrase fallback)
                        # fitBeatDurations: min 1.8s/beat, scaled to audio length, source tagged
    concepts.ts         # candidates 3-5/beat w/ REQUIRED semanticMechanism + whyViewerUnderstandsIt;
                        # artDirectBeat 7-criteria scoring + rejection rules (generic/decorative/
                        # literal/undocumented mechanism => scriptRelevance<=4)
    motionPlanner.ts    # runSceneGeneration: 1 scene/beat, validated + collision-gated (soft-accept
                        # after1 re-ask), partial regeneration via ctx.only (resume = invalidate only
                        # bad scenes); regenerateScene (UI, hard gates)
    novelty.ts          # deterministic similarity (metaphor/objects/composition/primitives/motion/
                        # structure weights 30/15/10/20/15/10), verdict accept<50/revise<70/reject
    qa.ts               # technicalQa (ffprobe), visionQa (3 evaluators A/B/C different lens+temp
                        # 0.2/0.4/0.6 → per-dim MEDIANS + mean/variance/confidence; issues call
                        # only for flagged scenes, surgical images), slopCritic (forbidden patterns),
                        # aggregateQa (scene-level first; adds conformance), collectFrames/shrinkFrames
    slop/repair/…       # see §7
    repair.ts           # root-cause report {issue, rootCause, scope:minimal|conceptReplacement,
                        # changesMade, preserve, expectedEffect, scene}; conceptChanged() guard;
                        # collision gate (soft-accept on 2nd attempt); findings from vision+slop+
                        # novelty+conformance(COLLISION or overall<6)
    pipeline.ts         # orchestrator (§3), --resume stage caching, non-fatal repair skips,
                        # frameMap→runConformance per round, qa-summary.json persisted
  reference/
    extract.ts          # ffmpeg: probe, scene cuts (threshold 0.006, min1.5s, max26), 96 frames
                        # (start/mid/end + transition-adjacent), contact-sheet, 48×27 pixel color
                        # sampling (bg/text/accent buckets), motion diff (5 frames × 7 scenes, 64×36)
    analyze.ts          # 5 MiMo vision analysts (identity/typography/color/composition/motion),
                        # cached findings-*.json, confidence + lowConfidenceNotes
    conformance.ts      # DETERMINISTIC "same language, different content" scorer:
                        #   typography (layout-aware line estimate), color (accents/glows),
                        #   composition (+ referenceShares) — textCollisions() with GROUP-FLOW
                        #   layout model (anchor flex stack, gap44, offsets in %canvas, charW=0.70em
                        #   measured from pixels, long-word overflow ≤1.8×col, thin items h≤14 need
                        #   ratio>0.6 else >0.2), density, negative space, visual style
                        # + frameStats (ffmpeg raw 48×27: luma, text share thr100, accent share)
  server/server.ts      # local API :8787 (projects, voice b64 upload, generate jobs, status poll,
                        # scenes PUT-regenerate, render, qa, Range-streamed mp4, MIME map for UI)
  cli/                  # generate (--resume), render, reference (extract/analyze)
ui/                     # Vite React: script input, VO upload, generate+stage progress, scene grid,
                        # Player preview, regen notes, QA display (median/confidence/conformance)
tests/                  # 76 tests: schema negatives, registry consistency, timing, novelty,
                        # qa/aggregate+repair-plan, golden visual (5 scenes → stills + frameStats +
                        # conformance≥8 + motion diff), render probe, phase2 (stats/collision/
                        # repair-guard/candidate schema)
```

---

## 3. PIPELINE FLOW (orchestrator: `src/agents/pipeline.ts generateProject`)

```
input: projects/<id>/input/script.md (+voice.*; optional timestamps.json)
│
├─ analysis   script-analysis.json       LLM 1 call   (meaning, not sentence split)
├─ beats      beats.json                 LLM 1 call   (3-9 semantic beats, ids b1..bN)
├─ timing     timestamps.json            ffprobe+phrase; source word|phrase|estimated
│             beats.json += timing       (min1.8s/beat, sum scaled to audio)
├─ concepts   candidates.json            LLM 2×N calls (3-5/beat, semanticMechanism REQUIRED,
│             selected.json               diversity check, art-director rejects w/ criteria;
│                                         rejection → 1 alternatives round, budget fallback)
├─ scenes     scenes/scene-NNN.json      LLM N calls; each: Zod schema + validateScene
│                                        + collision gate (1 re-ask, then soft-accept+warn)
│             RESUME: keep valid stored scenes, regenerate ONLY invalid (ctx.only)
├─ novelty    qa/novelty.json            deterministic gate; rejects → repairPass (best-effort)
├─ render     renders/preview.mp4        bundle(mtime-cached) → selectComposition → renderMedia
├─ conformance qa/conformance.json       structural + frameStats per scene; COLLISION evidence
├─ vision QA  qa/visual-qa.json          3 evaluators (compact bible prompt, maxTokens4000,
│             qa/evaluator-{1..3}.json    ~30-90s each, serialized via queue) → medians +
│             qa/visual-qa-raw.json        mean/variance/confidence; flagged scenes only →
│                                         issues call (surgical images, maxTokens8000, ≤180ch/issue)
├─ slop       qa/slop-qa.json            forbidden-pattern ids, severity, verdict
│
├─ aggregate  qa/qa-summary.json         overall = mean(scene quality means, mean-of-means,
│                                        10-aiSlop, 10-slopSeverity, conformance)
│                                        status: fail(technical) | needs_repair(reasons) | pass
│                                        reasons: overall<8, slop>6, novelty reject,
│                                        conformance<6, confidence<0.5, per-scene tech fail,
│                                        relevance/clarity ONLY IF scene median<6.5 (variance guard),
│                                        critical readability issues from issues[]
│
├─ repair loop (max 2 rounds per run; repairs are BEST-EFFORT — any LLM failure → skip scene,
│               never kills the run; plan = buildRepairPlan(medians + issues + slop≥5 +
│               novelty≠accept + conformance COLLISION|<6); each repair = root-cause report +
│               scene JSON, gated by: schema, conceptChanged(minimal), collision (1 re-ask))
│   → re-render → re-conformance → re-vision(3) → re-slop → aggregate
│
└─ finalize: copy preview→final.mp4, append memory (dedup by project/scene), manifest complete
             (completes with status complete EVEN IF qa=needs_repair — retry budget exhausted;
             qa-summary.json keeps the honest result)
```

Resume (`--resume`) caches: analysis, beats+timing, candidates/selected, valid scenes — only
QA+downstream re-run when only QA failed (Phase2 §16).

---

## 4. SCENE JSON CONTRACT (hard-fail validations, `src/validation/schema.ts`)

Structural: unknown primitive (registry), duration (0,15], purpose/visualConcept length,
composition enum (11 grammars), elements 1..4 (negative space), strict element params
(per-primitive from primitives.json: enums/ranges/types), motion vocabulary enums, timing
within duration, duplicate sceneId.

Layout hard rules (added during Phase 2 after real render failures):
1. **Duplicate headline** (scene.headline == element text) → fail.
2. **Narrow-anchor char budget**: left/right anchor (via headlinePositionFor(composition))
   headline ≤34 chars (reference left-column headlines ~29); wide ≤60. Elements same rule.
3. **Layout-aware line estimate**: wrapLines(explicit \n segments, 96px, availPx) >4 → fail
   ("no \n, renderer wraps").
4. **Safe-margin offset guard**: offsets are % of full canvas; outward offsets on edge anchors
   (left→ox<0, right→ox>0, top→oy<0, bottom→oy>0) → fail (root cause of twice-failing
   scene_02 "clipped pill").
5. accentWords ≤2, maxElements 4.

Soft gates (generation/repair-time, 1 corrective re-ask then accept-with-warn so a stubborn
model can't kill the run):
- **textCollisions()**: group-flow AABB of text (headline/labels/…) + objects (22 prim sizes),
  same-anchor pairs skipped (renderer stacks them), offsets applied, charW=0.70em (measured:
  Archivo caps ≈66px@96px), long single word overflows to ≤1.8×column, thin (h≤14) ratio>0.6
  else >0.2. Threshold env `COLLISION_RATIO` (default0.2). Flagged pairs → repair plan.

Calibration evidence: frame-verified against rendered stills — e.g. muwt0aze scene_02 clean
(vision "no overlap") vs scene_06/08 flagged (vision "ring cuts PENGARUHNYA") — detector and
vision agreed after 3 calibration rounds (initial FPs from missing group-flow/offsets fixed).

---

## 5. REFERENCE-DNA PIPELINE (Phase 2 §2-6)

```
npm run reference:extract   # pure ffmpeg+local pixel math, NO vision API
npm run reference:analyze   # 5 focused MiMo calls, cached (findings-*.json)
```

Extract results (actual): 26 scenes (cut threshold 0.006 — reference has smooth fades, cut
scores p50=0.0001 p99=0.0098), 96 frames, contact sheet, 30 color samples,
motion global diff **0.0112** (restrained), avg frame luma 24.8 (all dark).

Analyzed findings (confidence): bg `#0b1313` (0.90), text `#f4f2ed` (0.85), accents mint
`#7fd1bd` (0.75)/gold `#f5c54d`(0.70)/pink-red `#e8475f`(0.65); typography grotesque bold,
uppercase-preferred, LEFT-aligned blocks (0.75); composition shares leftTextRightObject .30 /
centered .20 / top-bottom .30 / typo-asym .20; motion: staged sequential reveals, ease-out,
static camera, cut/dissolve transitions (0.60-0.65).

These tokens REPLACED the provisional V1 values in design-system/*.json with
`provenance: {source, confidence}` per token (`design-system/PROVENANCE.md` ledger). Notable
V2 deltas vs V1: bg `#0A0B0D→#0B1313` (teal-black), teal `#2FD6A9→#7FD1BD` (mint),
headline default align `center→left`, maxElements `5→4`, slidePx `56/140→40/90`.

**Design DNA ≠ scene template**: reference contains clocks/avatars; `primitives.json` remains
the full 38-item content inventory chosen per script meaning. Runtime never reads `reference/`.

---

## 6. QA SYSTEM (Phase 2 §11-13)

- **Scene-level first.** 3 independent evaluators (A script-communication t=0.2, B design-craft
  t=0.4, C cold-viewer skeptic t=0.6), scores-only JSON (8 dims incl aiSlopSeverity lower=better),
  compact design brief (~2KB — critical: full brief caused HTTP 524 gateway timeouts).
- Aggregation: per-dim **median** across evaluators; per-scene stats {mean, median, variance,
  confidence=1−variance/6}; project confidence from overall stats. Raw kept in
  `qa/visual-qa-raw.json`.
- Issues detail call runs ONLY for flagged scenes (their frames only), ≤180 chars/issue.
- **Variance guard**: relevance/clarity reasons require scene median <6.5 (cross-session judge
  swings on identical frames measured — see §9).
- Slop: forbidden-pattern ids, severity, verdict (<4 / 4-6 / >6).
- Conformance: reference-derived structural score (typography/color/composition/motion/density/
  negativeSpace/style) + frame luma/text/accent stats; overall added to quality mean; <6 → reason.
- Technical: ffprobe dims/fps/codec/duration/audio — hard fail path.
- Novelty: deterministic weighted similarity vs global `projects/_memory/history.json` (dedup on
  re-commit) + same-project earlier scenes; accept<50/revise<70/reject>70.

---

## 7. LLM TRANSPORT (failure modes + adaptations — READ CAREFULLY)

Endpoint is a free-tier gateway: **HTTP 524 (100s generation timeout)** and **429 FreeUsageLimit**
are frequent; model is reasoning-heavy.

`executeChat` retry ladder (per queued call, serial queue = concurrency1 + 0.9–1.6s jitter gap):
- 524: attempt1 keeps full budget; consecutive ≥2 → halve `max_tokens` floor **4000**; backoff 2s+jitter.
- 429/5xx/400-upstream: exponential backoff 15/30/45/60s + jitter, up to **5 transient attempts**.
- `finish_reason=length` OR empty content: reasoning ate the budget → **double** `max_tokens`
  (≤16000) and retry (inverse of the 524 squeeze).
- `extractJson`: balanced-bracket scan (string-aware) + trailing-comma tolerant; on failure emits
  "TRUNCATED" diagnosis so the corrective re-ask tells the model to output SHORTER JSON.
- `completeJson`: structured parse → on fail, one corrective re-ask w/ Zod errors (repair sets
  `attempts:3`). Prompt-size tiers: generation ~11KB full bible; QA/repair compact ~2-6KB.

Known unfixed transport issue: **reasoning runaway on heavy repair prompts** — some scenes
(scene_03/06/08) repeatedly produce `finish_reason=length` even at 8000→16000 (thinking consumes
the whole budget). Mitigations applied: brevity nudge, compact bible+scoped primitive specs,
maxTokens16000 for repair, attempts3. Still the #1 repair skip cause.

---

## 8. CURRENT STATE (as of 2026-10-07 06:20 local)

Quality trajectory of USER test project `proj_muwt0aze` (script+VO from UI tests, 8 scenes,
TTS Indonesian VO ~55s... actual: phrase timing):

| run | overall | conformance | slop | notes |
|---|---|---|---|---|
| 1 (pre-Phase2) | — | — | — | render 404 (stale bundle public/ cache) → fixed |
| resume | 6.5 | — | 8 | first full QA |
| 4 | 6.91 | 8.8 | 7-8 | +3 scenes regenerated under new offset guard |
| 5 | (crashed) | — | — | issues JSON truncation @4000 → now 8000+brief |
| 6 | 6.96 | 8.7 | 8 | light repair prompt (11KB→5KB), issues surgical |
| 7 | 6.88 | 9.0 | 8 | collision detector v1 live |
| 8 | **7.03** | 9.0 | 8 | all scenes tech=pass; collision gates live |
| 9 | 6.96 | 8.9 | 8 | judge cross-session swing observed |
| 10 | ~7.0 (in flight) | ~9 | 7 | overflow-word hint; label floor 26px; variance gate |

Other projects: `proj_ref_demo` (my E2E "Fewer Excuses", 6 scenes): final **6.82**, conformance
8.7, blockers scene_03 (weak metaphor) — completed earlier. `proj_e2e8` (Phase1): 6.34→complete.
`proj_muwsgfuc` (user's first UI test): failed at vision QA (VISION_UNAVAILABLE), **not yet
resumed** after mime-sniff + retry fixes.

Test status: `npm run verify` green — typecheck clean, **76 tests** (golden visual + render probe
included; 72 in fast set).

Server: `:8787` API+UI (MIME fixed: html served as text/html not octet-stream).

### Open problems (honest list for the analyst)
1. **QA ceiling ~7.0 vs target ≥8.** Scene medians cluster 6.3-7.7; slop stuck at 7-8.
2. **scene_06 stubborn collision** (ring×"PENGARUHNYA"): root cause = long word overflows 46%
   side column into object band; repairs repeatedly die on truncation/524 before applying the
   (now-added) composition-change hint. Same class: scene_08 grid×last line.
3. **Reasoning-model truncation** (`finish_reason=length`) on repair prompts — even 16000
   tokens occasionally insufficient; chatRaw oscillates length↔524.
4. **Judge cross-session variance**: identical frames scored rel 7-8 one session, 2-4 next
   (eval1 lens t=0.2 outliers). Median-of-3 fixes within-session only; variance guard added but
   between-run instability remains (could store rolling per-dim history).
5. Free-tier 524/429 dominate wall-clock: a QA round ≈8-12 min, a repair scene ≈1-15 min.
6. Conformance is structural (approx. sizes for OBJECT_BOX); thin-line thresholds heuristic —
   calibrated but not pixel-perfect (scene_06 at 0.22-0.45 depending on charW).
7. `proj_muwsgfuc` + `proj_ref_demo` unfinished passes (see §3 resume).

### Recent code deltas (last ~3h, all tested green)
- `layout.ts`: charW 0.62→**0.70** (pixel-measured), long-word overflow box, wrapLines export.
- `conformance.ts`: group-flow collision model (offsets, gap44, justify), thin threshold 0.6,
  COLLISION_RATIO env (0.2), OBJECT_BOX 22 sizes + Line/Arrow orientation.
- `schema.ts`: narrow-char budget, layout line estimate, outward-offset guard.
- `context.ts`: sceneRulesPrompt shared by generate+repair; overflow-word hint.
- `schemas.ts`: normalizeScenes strips stray element keys from scene.headline (model keeps
  emitting position/delay inside headline → strict schema rejected repairs).
- `repair.ts`: attempts:3, maxTokens16000, brevity nudge, collision gate w/ soft-accept,
  conformance findings wired (COLLISION evidence reaches repair even when overall ≥6).
- `qa.ts`: issues call 4000→8000 + ≤180ch/issue brevity; VISION_UNAVAILABLE retry-with-feedback
  (was hard-fail); relevance gate `scene median <6.5`.
- `llm.ts`: mime sniff (jpeg was sent as image/png → provider dropped images → model honestly
  said VISION_UNAVAILABLE), finish_reason=length detection, transient attempts 4→5, attempts
  override on completeJson.
- `primitives/*`: fs() text floor label.min=26px; Line neutral color hairline→muted (invisible
  on near-black was a real bug).
- `renderProject`: bundle key includes public/ mtimes + 404→rebundle-once guard (stale bundle
  served voice.mp3 →404 when UI re-rendered then generated new project in same server process).
- pipeline: partial scene regeneration on resume; repair skips non-fatal; progress slice 140→500.

### Post-script (run10 final, 06:40 local)
overall 6.98 | conformance 8.9 | confidence 1.0 | **slop 6 (at threshold, was 8)** |
scene_06 collision RESOLVED (7.14 tech pass) via overflow-word composition hint.
Remaining: scene_05 (metaphor lines never render), scene_08 (headline renders 6 lines over
grid � estimate/render mismatch), scene_04 tech fail. Full detail: ANALYSIS_HANDOFF_FULL.md.