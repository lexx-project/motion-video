# MOTION-VIDEO STUDIO — FULL TECHNICAL HANDOFF (EVERY SECTION)

> Companion to `ANALYSIS_HANDOFF.md` (summary). This file contains EVERY part of the system in
> detail: data models, algorithms, prompts, formulas, endpoints, tests, incident chronology,
> scores, and open problems. Repo: `C:\Users\Administrator\Documents\project\motion-video`.
> Timestamp of state: 2026-10-07 ~06:30 local (UTC+7).

---

# 0. EXECUTIVE SNAPSHOT

- **Purpose**: virtual motion-design studio. `SCRIPT + VO → semantic beats → visual concepts →
  validated scene JSON → deterministic Remotion render → multi-judge QA → local repair → MP4`.
- **Hard invariants**: LLM never emits code; scene JSON must pass Zod+registry validation;
  every project passes Technical/Vision/Slop/Novelty QA; failures repair locally (max 2 rounds
  per run); reference video is one-time design source, never a runtime template; design tokens
  live only in `design-system/` with provenance+confidence.
- **Stack**: Node 24, TypeScript 5.7, Remotion 4.0.533, React 18.3, Zod 3.25, Vitest 2.1,
  Vite 5.4, tsx runner, ffmpeg/ffprobe (system), Windows.
- **Model**: `oc/mimo-v2.6-flash-free` (reasoning model) through an OpenAI-compatible gateway
  (free tier: HTTP 524 generation timeouts + 429 FreeUsageLimit are routine).
- **Quality today**: best full-project QA = **7.03/10** (target ≥8), conformance **9.0**,
  judge confidence 0.99, all scenes technical-pass. Score trajectory across 10 repair runs:
  6.5 → 6.8 → 6.91 → 6.96 → 6.88 → **7.03** → 6.96 → ~7.0 (run10 finalizing).
- **Tests**: `npm run verify` = typecheck + **76 tests green** (incl. real render probe + golden
  visual tests).
- **Live services**: API+UI on `:8787`; one generation process (proj_muwt0aze run10 QA3) in flight.

---

# 1. ENVIRONMENT, SCRIPTS, DEPENDENCIES

## 1.1 npm scripts
```
studio             remotion studio src/index.ts
render:composition remotion render
generate           tsx src/cli/generate.ts     [--script f] [--voice f] [--id X] [--title t] [--resume]
render             tsx src/cli/render.ts       [--id X] [--out name]      (re-render from stored scenes)
reference:extract  tsx src/cli/reference.ts    [path]   (ffmpeg preprocessing, no API)
reference:analyze  tsx src/cli/reference-analyze.ts [dir] (5 MiMo vision analysts, cached)
serve              tsx src/server/server.ts    (STUDIO_PORT, default 8787)
ui                 vite --config ui/vite.config.ts      (dev :5173, proxies /api /renders)
ui:build           vite build → dist-ui/               (served statically by server)
typecheck          tsc --noEmit
test               vitest run
verify             npm run typecheck && npm run test
```

## 1.2 Dependencies
Runtime: `remotion`, `@remotion/{bundler,cli,player,renderer}` ^4.0.393 (installed 4.0.533),
`react`/`react-dom` 18.3, `zod` ^3.24 (installed 3.25.76), `@fontsource/archivo`,
`@fontsource/inter` (woff2 copied to `public/fonts/` — no network at render time).
Dev: `typescript` 5.7, `vitest` 2.1, `vite` 5.4, `@vitejs/plugin-react`, `tsx`, `@types/*`.

System tools: `ffmpeg`/`ffprobe` (winget), Windows SAPI TTS (used to synthesize test VO).

## 1.3 Configuration resolution (LLM)
`src/agents/llm.ts:resolveLlmConfig()` precedence:
1. env `STUDIO_LLM_BASE_URL`+`STUDIO_LLM_API_KEY`+`STUDIO_LLM_MODEL` (all three) → use directly;
2. else model id from project `opencode.json` (`"router-asli/oc/mimo-v2.6-flash-free"`),
   fallback global `~/.config/opencode/opencode.jsonc` top-level model;
3. parse model id `providerId/rest` → look up provider options (baseURL/apiKey) in global config
   providers map; fallback: unique provider declaring that model key.
Failure → `stageError("llm", ...)` non-recoverable. Config cached per process.

Other config: `STUDIO_PORT` (server). `COLLISION_RATIO` env overrides collision threshold
(default "0.2").

---

# 2. SPEC HIERARCHY & NON-NEGOTIABLE RULES (`AGENTS.md`)

`MASTER_SPEC.md → AGENTS.md → existing architecture → implementation decisions`.

1. Never bypass scene JSON (no LLM-emitted JSX).
2. Never bypass validation (unknown primitive/duration/position/motion/timing = hard fail).
3. Never bypass QA (technical/vision/slop/novelty; failures → repair loop).
4. Never hardcode reference scenes; reference is design-DNA only (`design-system/`).
5. Deterministic rendering: primitives are pure functions of (scene JSON, frame); no randomness,
   no network inside components.
6. Design language only in `design-system/` data files; values regenerated via
   `npm run reference:extract && npm run reference:analyze`; never fabricate tokens/confidence.
7. VO is timing authority when timestamps exist; phrase-level fallback otherwise.
8. Run `npm run verify` after changes; render a representative scene when touching primitives.
9. QA decisions are median-of-3-evaluators with variance/confidence recorded; never repair on a
   single judge outlier. Conformance = "same design language, different content" (never pixel
   similarity).

---

# 3. COMPLETE FILE INVENTORY (line counts)

```
src/agents/concepts.ts        203  candidates + art director + alternatives loop
src/agents/context.ts         182  prompt builders (full/compact bible, sceneRules, primitiveSpecs)
src/agents/llm.ts             395  provider, queue, retry ladder, structured JSON, vision
src/agents/motionPlanner.ts   190  scene generation (validated+gated), partial regen, UI regen
src/agents/novelty.ts         181  deterministic similarity + project memory
src/agents/pipeline.ts        398  orchestrator, resume, repair loop, finalize
src/agents/qa.ts              489  technical/3-evaluator vision/slop/aggregate/frames
src/agents/repair.ts          226  root-cause repair, gates, repair-plan builder
src/agents/schemas.ts         312  all Zod schemas for LLM outputs + normalizers
src/agents/scriptAnalyst.ts    81  analysis + beats (2 LLM calls)
src/agents/voTiming.ts        208  ffprobe/whisper-attempt/phrase fallback + fitBeatDurations
src/cli/{generate,render,reference,reference-analyze}.ts  34/42/30/30
src/core/config.ts             16  PATHS (node-only; never import from render bundle)
src/core/designSystem.ts       69  typed accessors for design-system JSON
src/core/errors.ts             79  StudioError {stage, projectId, sceneId, recoverable, explanation}
src/core/output.ts             25  OUTPUT/QA_THRESHOLDS/PIPELINE constants (browser-safe)
src/core/projectStore.ts      215  manifest/stages/scenes/memory IO
src/core/timing.ts            116  phrase splitting, estimation, beat assignment, word→phrase
src/primitives/atmospheric.tsx 157 GradientGlow, SoftOrb, Grain, GridBackground, LightSweep
src/primitives/diagrams.tsx   566  8 diagram primitives (fs() text floor inside)
src/primitives/motion.ts      178  elementMotionStyle + easings + accent helpers + sizeScale
src/primitives/objects.tsx    696  15 object primitives (fs() text floor inside)
src/primitives/registry.ts    117  name→component map + registryConsistencyErrors()
src/primitives/sceneClock.tsx  14  React context {time,frame,fps,durationSec,durationFrames}
src/primitives/types.ts        33  PrimitiveProps/RegistryEntry
src/primitives/typography.tsx 316  9 typography primitives + renderAccented()
src/reference/analyze.ts      346  5 vision analysts + caching + scoped visionJson
src/reference/conformance.ts  507  conformance scorer + textCollisions + frameStats
src/reference/extract.ts      421  ffmpeg extraction (scenes/frames/colors/motion/contact sheet)
src/render/renderProject.ts   219  bundle cache, renderMedia, stills, ffprobe technical QA
src/render/Root.tsx            33  Composition "Project" + calculateMetadata
src/render/testProject.ts      59  hand-authored deterministic test scenes (not reference-derived)
src/scenes/layout.ts          169  pure layout math (anchors/wrap/text boxes/overlap)
src/scenes/ProjectRenderer.tsx 97 sequences + Audio + FontLoader (delayRender)
src/scenes/SceneRenderer.tsx  180  anchor-group renderer
src/server/server.ts          321  HTTP API + static + Range streaming + MIME
src/validation/schema.ts      288  scene schema + hard layout rules
src/validation/validate.ts     89  validateScene/timeline/totalDuration
src/index.ts                    4  registerRoot

tests/golden.test.ts    186  5 golden scenes → real stills → pixel/conformance/motion assertions
tests/novelty.test.ts   111  similarity weights/thresholds
tests/phase2.test.ts    193  statsOf, conformance, conceptChanged, repair schema, candidate schema
tests/project.test.ts    50  fixture validation + OUTPUT constants (+ opt-in RUN_E2E e2e)
tests/qa.test.ts        158  aggregateQa thresholds + buildRepairPlan
tests/registry.test.ts   61  registry↔primitives.json consistency + design invariants
tests/render.test.ts     42  real renderMedia → ffprobe asserts 1080×1920/30/h264 + duration
tests/schema.test.ts    156  all hard-fail validation cases
tests/timing.test.ts     77  phrase/beat timing math

design-system/*.json + MASTER_DESIGN_BIBLE.md + PROVENANCE.md
reference/reference.mp4 + reference/analysis/* (metadata, scenes, frames-index, sampled-colors,
  contact-sheet, findings-{identity,typography,color,composition,motion}.json, all-scores.txt)
ui/{index.html, vite.config.ts, src/{main.tsx, App.tsx (436 lines), styles.css}}
.opencode/agents/*.md (9 agent definitions)
docs/{ANALYSIS_HANDOFF.md, ANALYSIS_HANDOFF_FULL.md (this)}
```

---

# 4. DATA MODELS

## 4.1 Project folder (per MASTER_SPEC §13)
```
projects/<id>/
  input/script.md, voice.<mp3|wav|...>       (optional input/timestamps.json = word timestamps)
  analysis/script-analysis.json, beats.json (with .timing merged), timestamps.json, transcript-words.json?
  concepts/candidates.json {perBeat:[...]}, selected.json {selections:[...]}
  scenes/scene-NN.json                        (one file per beat; sceneId scene_01..NN)
  qa/evaluator-{1,2,3}.json, visual-qa.json, visual-qa-raw.json, slop-qa.json, novelty.json,
     conformance.json, qa-summary.json, repair-scene_XX.json, frames/{r1,r2,...}/*.png+*.jpg
  renders/preview.mp4, final.mp4
  manifest.json
public/<id>/voice.*                           (copied for staticFile; bundle snapshot source)
projects/_memory/history.json                 (global memory entries, dedup project/sceneId)
```

## 4.2 Manifest
```ts
{ projectId, createdAt, updatedAt, status: created|analyzing|directing|generating|validating|
  rendering|qa|repairing|complete|failed, title?, scriptPreview, hasAudio, audioDurationSec?,
  timingSource?: word|phrase|estimated, sceneIds[], stages: {name: {status, startedAt?,
  finishedAt?, error?}}, lastError? }
```
Stage marks used: analysis, beats, timing, concepts, sceneGeneration, validation, novelty, render,
visionQa, slop, conformance, repair, final.

## 4.3 Scene JSON (the contract)
```ts
{
  sceneId: "scene_01"           // ^[a-zA-Z0-9_-]+$, unique per project
  duration: number              // (0,15] seconds; cross-check [1.8, 9] in pipeline
  purpose: string               // 3..300 chars — what this scene communicates
  visualConcept: string         // 2..160 chars — short concept name
  composition: enum(11)         // centered|leftTextRightObject|rightTextLeftObject|objectDominant|
                                // typographyDominant|asymmetric|split|topTextBottomObject|
                                // bottomTextTopObject|dualObject|fullFrameSymbolic
  headline?: { text: string, accentWords?: string[≤2], align: left(default)|center|right }
  elements: Element[1..4]       // strict per-primitive params + common params (below)
  motion: { entrance: fade|reveal|slide|scale|draw|stagger,
            emphasis: subtleScale|positionShift|highlight|glow|counterChange|controlledReveal,
            exit: fade|slide|dissolve|maskedTransition }
  timing?: { entranceAt: 0..60, emphasisAt?: ≤duration, exitAt?: ≤duration }
  metadata?: Record<string, unknown>
}
```

**Common element params** (from `primitives.json.common`, all strict-reject unknown keys):
`position`(9 anchors enum, default center), `offsetX/offsetY` (-50..50 % of FULL canvas),
`scale` 0.2..3, `opacity` 0..1, `rotation` -360..360, `accent` none|teal|gold|orange|red,
`size` sm|md|lg|xl (scale 0.7/1/1.35/1.8), `variant` string≤32 (per-primitive often re-enum'd),
`delay` 0..60 s, `entrance/emphasis/exit` optional overrides (vocab enums), `emphasisAt` 0..60,
`density` 0..1.

**Scene-level hard validation** (Zod + superRefine; every message actionable):
| Rule | Fail example |
|---|---|
| duration ≤0 or >15 | "duration must be > 0" |
| elements 0 or >4 | "max 4 elements per scene (negative space rule)" |
| unknown primitive | `Unknown primitive "Hologram3D". Registered primitives: ...` |
| strict element params (per-primitive enums/types/ranges) | `variant: Invalid enum value. Expected 'cards'\|'bars'\|'coins', received 'bridge'` |
| motion vocabulary | `entrance: Invalid enum value... 'shake'` |
| timing beyond duration | "emphasisAt exceeds scene duration" |
| duplicate headline (scene.headline == Headline/WordReveal/CharacterReveal/HighlightWord element text, normalized) | "duplicates scene.headline (would render the same text twice...)" |
| accentWords >2 | "max 2 accent words per headline (semantic accent rule)" |
| narrow anchor headline >34 chars (anchor = headlinePositionFor(composition); left/right) | `headline is 41 chars but the "left" anchor only fits ~34...` |
| wide anchor headline >60 chars | same pattern |
| layout line estimate >4 (wrapLines per explicit-\n segment, 96px, availPx−40) | `headline renders ~6 lines... do not use line breaks (\n)` |
| outward offset on edge anchor (left→ox<−0.5, right→ox>0.5, top→oy<−0.5, bottom→oy>0.5) | `offsetX -14 pushes a left-anchored element past the left safe margin... use offsetX >= 0` |
| headline-family element text over its anchor budget | same as headline rules |
| scene with no renderable content | "scene has no renderable content" |

**Soft gates at generation/repair (recoverable → 1 corrective re-ask → accept with console.warn):**
- `textCollisions()` non-empty (see §9). Repair gate message: "The repaired scene still has
  layout collisions: ... Move the colliding items to different bands or the SAME anchor".
- `conceptChanged()` (composition AND primitives AND visualConcept all changed while
  scope="minimal") → rejected, must set scope="conceptReplacement".

## 4.4 LLM-output schemas (`src/agents/schemas.ts`)
- analysisSchema: summary/themes/emotions/keyNouns/keyVerbs/abstractConcepts/importantPhrases/
  emphasisCandidates/visualOpportunities (strict).
- beatsSchema: `{beats:[{id ^b\d+$, text, why, emotion, metaphorHints[], abstractMeaning,
  visualPriority|typographyPriority: high|medium|low, important:bool, emphasisPhrase?}]}` 1..14.
- candidateSchema: id, concept(≤160), metaphor(10..400),
  **semanticMechanism(10..400, required)**, **whyViewerUnderstandsIt(10..400, required)**,
  composition enum, objects[1..6], typographyStrategy, motionOpportunity, whyItWorks,
  complexity low|medium|high, primitiveSketch[2..5] (must be registry names).
- selectionSchema: beatId, selectedCandidateId? XOR rejected+rejectionReasons,
  directionForAlternatives?, scores{7 dims 0..10 strict}, selectionRationale.
  Rejection loop: up to 2 rounds; if still rejected → fallback to first candidate with note.
- evaluatorResultSchema: `{scenes:[{sceneId, scores{8 dims}}], overall{8 dims}}`.
- qaIssuesSchema: `{scenes:[{sceneId, technicalCorrectness pass|fail, issues[≤12, ≤400ch],
  recommendedRepair[≤8, ≤300ch]}]}`.
- visualQaSchema (aggregated): evaluatorCount, projectStatus, overall{8 dims+technicalCorrectness+
  stats{mean,median,variance,confidence}}, scenes[{sceneId, scores(8), stats, technicalCorrectness,
  issues, recommendedRepair}].
- slopQaSchema: projectSeverity 0..10, verdict acceptable|needs_repair|severe, findings[{sceneId,
  type (forbidden pattern id), evidence, severity}].
- repairReportSchema: issue(5..500), rootCause(5..500), scope minimal|conceptReplacement,
  changesMade[1..12 items ≤400ch], preserve[1..10 ≤300ch], expectedEffect, scene(full SceneSpec).
- Normalizers (envelope tolerance only): array→wrapper, single-object→wrapper,
  strip comment keys, **scene.headline whitelist {text, accentWords, align}** (models kept
  injecting element keys → strict schema rejected repairs), selection single→array + first-only.

## 4.5 Memory / novelty data
MemoryEntry: `{projectId, sceneId, visualConcept, metaphor, composition, dominantObjects[],
  primitiveCombination[], motionPattern "entrance/emphasis/exit", semanticPurpose}`.
Appended on project completion (dedup by projectId/sceneId). Compare: Jaccard of token sets
(words>3 chars) for metaphor (≥0.6 = same), objects Jaccard ≥0.7, composition equality,
primitives Jaccard ≥0.8, motion equality; structure = composition+motion.
Verdicts: accept <50 ≤ revise ≤70 < reject. Pool = global history (other projects) + earlier
scenes of same project; worst match wins.

---

# 5. DESIGN SYSTEM (V2 — reference-derived, full values)

## 5.1 colors.json
```
background.base #0B1313   (ref pixel sampling: #0a1212×10, #0b1212×5 of30 frames; conf .90)
background.deep #070D0D (derived .70)   elevated #141E1D (.65)   hairline #1F2C2A (.60)
background.warmVariant #17110B (brown-graded ref frames; conf .50)
text.primary #F4F2ED (vision; pixel samples diluted; .85)   secondary #B5B1A7 (.70)
muted #7A776F (derived .50)
accents: teal #7FD1BD (mint, .75)  gold #F5C54D (.70)  orange #E07A3F (spec-only, .40)
         red #E8475F (pink-red, ±10 hue/sat, .65)
rules: maxAccentWordsPerHeadline 2, oneDominantAccentPerScene true, maxGlowsPerScene 1,
       primaryContrast ≥7, accentContrast ≥3, backgroundHasRadialVignette true
provenance: per-token {source, confidence} map (exact text in file)
```

## 5.2 typography.json
```
display: Archivo (bundled woff2 400/700/800/900), css "Archivo, Arial, sans-serif" (grotesque, ref conf .65)
body:    Inter (bundled 400/600/700)
scale (px@1080×1920):
  headline    default 96, min64, max128, weight900, lineHeight1.08, ls −0.02em, UPPERCASE, align left
  subheadline 52/40/64, w700, lh1.2, ls −0.01, align left
  label       34/26/40, w700, lh1.2, ls +0.12, UPPERCASE, align center
  caption     30/24/36, w400, lh1.35, align left
  quote       64/48/84, w800, lh1.2, align left
  counter     140/88/200, w900, lh1, ls −0.03, align left
rules: maxHeadlineLines 4, maxHeadlineChars 60, maxAccentWords 2, defaultAlign left,
  accentEmphasis "color shift plus weight" (.75), textAnimation "sequential word-by-word
  reveal, quick fade, L→R" (.65) → WordReveal primitive
NOTE documented deviations: ref tiers subline ~3% and label ~1.5% of frame height were RAISED
(52/34px) for phone readability (conf .60, rationale in PROVENANCE.md).
```

## 5.3 composition.json
grammars (11) + referenceShares {leftTextRightObject .30(.85), centered .20(.80),
topTextBottomObject .15(.70), bottomTextTopObject .15(.70), typographyDominant .10(.60),
asymmetric .10(.60)}; elementPositions (9); safeArea marginX8% marginTop10% marginBottom14%
(ref ~8/12; bottom14% = platform UI clearance, documented deviation); maxElementsPerScene **4**
(ref: one text block + one object, 60-70% empty, conf .85); maxSimultaneousMotionSystems 2;
spacingPatterns {textBlock 40-55%, object 20-30%, gap 15-20%, labelGap 4%h, tightLeading 1.1,
subtitleGap×2}; negativeSpaceRules {breathing 48px, sparse allowed, fill empty forbidden}.

## 5.4 motion.json
vocabulary as in §4.3. durations: entrance .3/.55/1.0, emphasis .2/.4/.8, exit .25/.45/.8,
staggerStep .06/.09/.16, scene 1.8/4.0/9.0 (s). easings: entrance cubic-bezier(.22,1,.36,1)
(ease-out quint), exit (.4,0,1,1), emphasis (.33,1,.68,1), counting linear.
amplitudes (V2 reduced vs V1 for "subtle settles"): slidePx 20/**40**/90 (was 24/56/140),
scaleFrom .96/.98/1, emphasisScaleDelta .02/.04/.06.
preferred: entrances [fade,reveal,stagger], exits [fade,dissolve],
emphasis [highlight,counterChange,controlledReveal,subtleScale].
referenceMeasurement: globalFrameDiff **0.0112**, density restrained, camera static (conf .75).
rules: no random motion/shake/zoom/glitch/transition-for-own-sake; max 2 simultaneous systems;
max 6 element animations/scene.

## 5.5 forbidden-patterns.json (16 ids used by Slop Critic)
excessive-particles(8), random-camera-shake(9), gratuitous-zoom(7), unnecessary-glow(6),
random-glitch(9), flashy-transitions(7), rainbow-palette(8), visual-clutter(7),
repetitive-layouts(5), bad-typography(8), meaningless-decoration(7), over-animation(7),
weak-metaphor(6), generic-ai-aesthetics(6), every-word-highlighted(6), meaningless-3d(8)
(value = default severity).

## 5.6 primitives.json
`common` params (see §4.3) + per-primitive param specs driving validation: types
string/number/boolean/enum/stringArray/objectArray with min/max/required/default. Enum examples:
Clock.variant analog|digital, ProgressBar.value 0..1 required, Timeline.items objectArray
{label required ≤30, state todo|active|done} 2..7, Comparison.left/rightLabel+Items required,
Grid.cols/rows 2..6, Grid.activeCells stringArray, Circle.diameterPct 5..100,
Arrow.direction right|left|up|down|diagonal, Line.orientation + lengthPct 5..100 + thicknessPx 1..24,
Checkbox.checkAt, CounterText.from/to/prefix/suffix/duration, Label.text ≤60 required, etc.
Align defaults: headline-family + Caption = **left** (V2), Label = center.

---

# 6. PRIMITIVE LIBRARY (38, deterministic)

All components are pure React FCs receiving `PrimitiveProps {element, sceneMotion, clock}`;
they call `elementMotionStyle()` themselves (entrance/emphasis/exit math), sizes via
`sizeScale(size)` and **`fs(base,s) = max(label.min=26, base*s)`** for all diagram/object text
(phase-2 fix: ~20px flow chips were unreadable).

## 6.1 Typography (9)
Headline/Subheadline/Label/Caption: `baseType(kind, align)` from typography.scale (family
display for headline-ish, Inter for label/caption), maxWidth928, wordBreak normal,
uppercase per scale; accent words recolored via `renderAccented()` (token split on whitespace,
normalized match).
WordReveal: per-word stagger (default step .1s, 0.35s smoothstep fade+translateY22),
internalMotion=true. CharacterReveal: per-char step .04s. HighlightWord: underline draw at
emphasisAt (0.4 duration). CounterText: smoothstep count from→to over duration (default1.6s),
toLocaleString, tabular-nums. Quote: display quote mark accent + text + optional attribution.

## 6.2 Objects (15)
Clock(analog SVG:12 ticks, hour hand white, minute hand accent, draw-in over1.1s; digital HH:MM
with blinking colon), Calendar(month header + 7×4 grid, activeDays filled accent, per-cell
reveal 0.02s stagger), ProfileCard(avatar circle initials + name/role), GenericCard(state
default|active|muted|done: accent bar/fade/done mark), Target(concentric rings, hit marker at
emphasisAt), ProgressBar(fill anim 1.0s from delay, optional showValue%), Checkbox(check path
stroke-dasharray draw at checkAt, strikethrough label after), Arrow(line draw 0.7s + chevron
head, direction rotate), Line(neutral color now **text.muted** (was invisible hairline),
orientation horizontal|vertical, lengthPct/thickness), Circle(outline|filled|ring draw via
strokeDashoffset, diameterPct×9.2px), Stack(cards|bars|coins layers, top layer accent, stagger
0.1), Grid(cols×rows cells, activeCells accent, dots variant), Indicator(dot/pulse ring/arrow,
label), Number(big value ±size), Badge(pill|outline uppercase).
Sizes (used by conformance OBJECT_BOX): Clock380², Calendar440², ProfileCard460×170,
GenericCard380×160, Target400², ProgressBar560×90, Checkbox420×90, Arrow320×48 (len=5.6×lengthPct),
Line (len%×1080 or thickness, vertical h=max(160,len×8)), Circle diameterPct%×1080 (cap column),
Stack340×260, Grid340×340, Indicator260×60, Number320×180, Badge220×70.

## 6.3 Diagrams (8)
Timeline(vertical|horizontal rail, done✓/active/todo states), Comparison(two columns + divider,
accentSide), BeforeAfter(strikethrough before / accent after + arrow), Flow(step pills + arrow
connectors), Branch(SVG trunk+curves to labeled boxes), Relationship(center pill + N nodes on
circle + radial lines), Progress(step dots + connectors filled to last done), Sequence(numbered
rows stagger 0.15). All text via fs() floor; stagger reveal via revealAt(i, step).

## 6.4 Atmospheric (5)
GradientGlow(radial accent blur40, intensity .35, diameterPct×15), SoftOrb(blur28 + sine drift
dx=sin(.5t)×30×drift, dy=cos(.37t)×22×drift), Grain(feTurbulence seed=7 fixed, opacity ≤.12,
mixBlend overlay), GridBackground(grid lines + radial mask), LightSweep(sweep x=−40%→140%
over duration, blur30). All internalMotion; skipped by collision detector (glow behind text by
design).

## 6.5 Motion engine (`primitives/motion.ts`)
Per element (pure function of clock): entrance progress eased (.22,1,.36,1) over 0.55s from
delay; exit over 0.45s starting duration−0.45; emphasis pulse sin(π·p) over0.4s from
emphasisAt (default 45% of scene). Entrance styles: fade opacity; reveal clipPath inset bottom
+ translateY18; draw clipPath inset left; slide translateY(1−e)×40; scale from0.98; stagger→fade
wrapper (real stagger internal to primitive). Emphasis: subtleScale ×(1+0.04·pulse),
positionShift −10px·pulse, glow drop-shadow 18px·accentGlow. Exit: fade, slide −40px,
dissolve blur6px+fade, maskedTransition wipe left+fade. internalMotion primitives get opacity
ramp only (they choreograph internally).

## 6.6 Renderer (`scenes/SceneRenderer.tsx`)
1. Build item list: elements (z=i+1) + scene.headline as synthesized Headline (z=90,
   position=headlinePositionFor(composition)).
2. Group by position anchor (first-appearance order).
3. Per group: absolute div at `anchor(position)` (safe-area aware: left/right/top/bottom/corners),
   transform translate(tx%,ty%), maxWidth (left/right46%, center/top/bottom90%, corners70%),
   display flex column, gap44, alignItems (left→start, right→end, else center),
   justifyContent (top→start, bottom→end, else center), zIndex=max(items).
4. Per item inner wrapper: translate(offsetX%×1080, offsetY%×1920) rotate scale(size×element.scale),
   fullscreen atmospheric primitives (Grain/GridBackground/LightSweep) rendered as inset:0 instead.
5. Background: radial-gradient 120%×90% base→deep (vignette per ref identity).
Same-anchor items NEVER overlap by construction (this is why the collision detector skips them).

## 6.7 ProjectRenderer
FontLoader: `delayRender` until `document.fonts.load` for Archivo 400/700/800/900 + Inter
400/600/700 then `document.fonts.ready`; @font-face injected with `staticFile` URLs (bundle
`publicDir=cwd/public`). Sequences back-to-back (from=cumulative frames), Audio staticFile when
audioPath given. Frame math uses `useVideoConfig().fps` (composition = OUTPUT).

---

# 7. REFERENCE-DNA PIPELINE (deterministic extract →5 analysts →tokens)

## 7.1 Extraction algorithm (`reference/extract.ts`), zero API calls
1. `probeReference`: ffprobe → duration 118.675s, 1024×576, 30fps, h264+aac, frames 3560.
2. `detectScenes`: `ffmpeg -vf "select='gt(scene,T)',showinfo"` parse pts_time.
   Measured score distribution: p50=0.0001 p90=0.0023 p95=0.0042 p99=0.0098 max=0.051
   (reference has smooth fades) → T default **0.006**, minScene **1.5s**, merge down to
   max **26 scenes** (merge shortest interval iteratively). Cuts <0.2s or >end−0.2 dropped.
   Raw score trace kept: `analysis/all-scores.txt` (234KB, 3560 entries).
3. Representative frames per scene: start+min(0.2,d/4), mid, end−inset (jpg q3, 1024w) plus
   transition-adjacent (±0.12s around up to 12 evenly spaced cuts, roles before/after).
   Total 96 frames; each also sampled at 48×27 rgb24 for color + textLikeRegions heuristic
   (bright-pixel row bands → bbox, kept as `textLikeRows`/`brightRegion` in frames-index.json,
   confidence low by design).
4. Colors: 48×27 per mid/start frame (30 samples): 5-bit RGB bucket histogram; background =
   dominant dark bucket (<90 luma) else global; textPrimary = dominant >170 bucket;
   accents = hue bins 30° (sat>.3, luma50..215) share ≥1%; meanLuma per frame
   (avg 24.8, all30 frames <80 luma).
5. Motion: 7 scenes × 5 evenly spaced frames at 64×36 rgb24 → consecutive mean |ΔRGB|/255;
   per-scene {meanDiff, entryDiff, exitDiff}; global mean **0.0112**.
   Saved: motion-samples/*.jpg (ordered sequences for the motion analyst) + analysis.json.
6. Contact sheet: scene-mid frames → concat list → `scale=256:144,tile=6×rows`.

## 7.2 Vision analysts (`reference/analyze.ts`), all cached (`findings-*.json`)
Each input downscaled to 512w jpg (`vision/`); visionJson = 2 attempts + correction; VISION_
UNAVAILABLE now re-asked (not hard-fail). Outputs strictly Zod-validated with `confidence`
0..1 and `lowConfidenceNotes[]`:
1. **Visual Identity** (contact sheet +6 mids): visualCharacter "minimalist flat motion-graphics
   explainer, bold uppercase kinetic typography, dark moody bg, editorial feel" (conf .88);
   density moderate; negative space 60-70% (one text block + one flat icon); objectStyle flat
   vector, thin strokes, no gradients; lighting flat+vignette; contrast high typographic;
   hierarchy type size/weight/accent first.
2. **Typography** (top textLikeRows frames +4 motion frames): grotesque; bold headlines regular
   sublines; uppercase-preferred; tiers ~8%/3%/1.5% frame height; left-aligned blocks;
   wide tracking on uppercase labels; emphasis color+weight; density moderate;
   animation sequential word-by-word L→R quick fade (conf .65).
3. **Color** (4 mids + pixel summary): reconciled estimates vs samples — bg #0b1313(.90),
   text #f4f2ed(.85)/secondary #b5b1a7(.70), accents red #e8475f(.65)/gold #f5c54d(.70)/
   teal #7fd1bd(.75); cool-dominant; luma dark; explicit reconcile note that samples are
   downscaled-diluted (conf .78).
4. **Composition** (7 mids): shares (§5.3), spacing patterns, proportions (text left 40-55%,
   object right 20-30%, split scenes object top60/caption bottom30-35, end-card stack),
   safe margins ~8%/12% (conf .75).
5. **Motion** (2 ordered sequences ×5 frames + diff numbers): staged sequential reveals,
   exits = wholesale replace (cut/dissolve), objects static after placement, text reveal
   L→R/top→bottom fixed resting, minimal scale, ease-out no bounce, static camera,
   emphasis typographic/color (conf .65).
Merged into `analysis/findings.json`. Values → design-system V2 (§5) with provenance entries.

---

# 8. GENERATION PIPELINE (stage by stage, with prompt inventory)

## 8.1 Script analysis (1 call, temp .4, maxTokens 8000)
System: Script Analyst role + full designBiblePrompt + output-key contract (§4.4 analysis).
User: raw script. → `analysis/script-analysis.json`.

## 8.2 Beats (1 call, temp .5)
System: Story Beat Director; "meaning units not sentences; one sentence can be 2-3 beats;
3–9 beats; mark 40–70% important". User: script + analysis JSON. → `analysis/beats.json`.

## 8.3 VO timing (no LLM)
`runVoTiming`: find input/voice.*; ffprobe duration; sources in priority:
(1) input/timestamps.json word array → wordsToPhrases(4);
(2) POST /audio/transcriptions whisper-1 verbose_json (currently400 no-credentials → null);
(3) phrase fallback estimate (proportional by words). No VO → duration = words/2.6s estimated.
`fitBeatDurations`: assignBeatTimings (phrase text match first, cursor-proportional fallback)
→ clamp min1.8s → if sum < audio, distribute remainder equally → monotonic start/end.
Writes timestamps.json + merges .timing into beats.json; copies VO to public/<id>/.

## 8.4 Concepts (per beat: candidates + selection; rejection →1 alternatives round)
generateCandidatesForBeat (temp .8): silent 4-question enactment framing (what said / emotion /
central semantic relationship / metaphor that PHYSICALLY demonstrates it); "ENACTMENT over
ILLUSTRATION"; memory list (avoid repeats); output 3–5 candidates with required
semanticMechanism + whyViewerUnderstandsIt; diversity check (same composition + overlapping
objects = near-duplicate → recoverable error → re-ask).
artDirectBeat (temp .4, maxTokens 8000, **compact bible**): 7-criterion scoring with weights
scriptRelevance > clarity > emotionalFit > motionPotential > designConsistency > novelty >
technicalFeasibility; REJECT if generic/decorative/literal/overcomplicated/off-bible/
memory-duplicate/unable to explain mechanism (then scriptRelevance≤4 auto-threshold);
else one selectedCandidateId + rationale citing mechanism.
`runConceptStage`: per-beat loop, ≤2 rounds, fallback = first candidate + note.
→ concepts/candidates.json {perBeat}, concepts/selected.json.

## 8.5 Scene generation (per beat one call; temp .4, maxTokens 8000)
System: Remotion Planner + full designBiblePrompt + memory + field contract + **sceneRulesPrompt**
(shared hard rules: inward offsets, headline budget/single-line/≤4 lines, band non-collision,
overflow-long-word→wide anchor, one accent, ≤4 elements, 60-70% negative space) + enactment
rule + no-duplicate-headline rule + motion vocabulary + exact duration + output envelope +
few-shot full example with real sceneId/duration.
Parse: normalizeScenes → sceneListSchema → validateScene (hard) → **collision gate (1 re-ask,
then accept + console.warn)** → force sceneId + duration.
`ctx.only` Set → partial regeneration (resume invalidates only invalid scenes).
Pipeline resume logic: stored scenes each re-validated; expectedIds scene_01..N; missing/invalid
→ `runSceneGeneration(only=...)`; merge + sort; marks stage done.

## 8.6 Novelty gate (deterministic)
`noveltyStage` → qa/novelty.json; status != pass → `repairPass` (per rejected scene:
repair with novelty findings only, best-effort) → re-run. Non-fatal.

## 8.7 Render
`renderWithProgress` → `audioRelPath` (copies VO into public/<id>/, returns staticFile path)
→ `renderProject`: ensureBrowser; `getBundle()` (cache key = max mtime of src+design-system+
**public** walk; stale-404-on-/public/ → clear cache + retry once); selectComposition "Project";
renderMedia h264/aac, onProgress → CLI log; copy to renders/preview.mp4.

---

# 9. LAYOUT COLLISION DETECTOR (calibrated; the crown jewel of Phase-2 hardening)

Location: `reference/conformance.ts textCollisions(scene)` + `scenes/layout.ts`.

```
collect items:
  headline (if scene.headline): pos=headlinePositionFor(comp), fs=96, lineHeight=1.08, ox=oy=0
  elements:
    TEXT_FONT_SIZE map: Headline/WordReveal/CharacterReveal/HighlightWord→96, CounterText→140,
      Quote→64, Subheadline→52, Label→34, Caption→30   (× sizeScale(size) × element.scale)
      → horizontalTextBoxFor(text, pos, fs, align, 1.2)
    OBJECT_BOX map (22 sizes, §6.2) with overrides:
      Circle → (diameterPct/100)×1080 square; Line → orientation-aware
        (vertical: w=thickness, h=max(160,len×8); horizontal: w=len%×1080, h=thickness);
        Arrow vertical directions swap (48×len)
      → width capped at column maxWidthFor(pos)×1080 (long-word exception below)
    atmospheric primitives skipped
  ox/oy from element (numbers only)

horizontalTextBoxFor(text,pos,fs,align,lineHeight):
  maxWidth = maxWidthFor(pos)×1080; natural = chars×fs×0.70   ← 0.70 MEASURED from rendered
    pixels (Archivo caps ≈66px @96px; earlier 0.62 underestimated)
  longestWord = max word len×fs×0.70   ← word-break:normal ⇒ long word OVERFLOWS column
    (this caught real scene_06: "PENGARUHNYA" 655px > 497px column → into ring band)
  width = min(max(longestWord, min(maxWidth, natural)), maxWidth×1.8)
  lines = wrapLines (greedy word wrap honoring explicit \n)
  x: leftish → x0=marginX; rightish → x0=W−marginX−width;
     center+align left → x0=W/2−maxWidth/2; right → x0=W/2+maxWidth/2−width; else centered

group flow (per anchor):  // mirrors renderer exactly
  H = Σh + 44×(n−1)
  y = topish ? marginTop : bottomish ? marginBottom−H : 960−H/2
  for each item: box = [x0+ox×10.8, y+oy×19.2, x1+ox×10.8, y+oy×19.2+h]; y += h+44

pairs: skip same anchor (stacked by renderer); skip object–object;
  ratio = overlapArea / min(areaA, areaB);
  thin (either h ≤14): threshold 0.6  (thin rules cross inter-line whitespace harmlessly
    — verified vs frames)
  else: threshold COLLISION_RATIO env default **0.2**
```
Calibration rounds (each verified by rendering still + asking vision directly):
- v1 (per-item boxes, no offsets, no group flow): FPs (scene_02 flagged, vision says clean);
  missed scene_06.
- v2 (+group flow, +offsets, charW0.70, overflow): scene_02 clean ✓, scene_06 0.22–0.45 ✓,
  scene_08 grid1.0 ✓, demo03 0.49 ✓ (all vision-confirmed); nothing false in 0.15–0.2 band.
Wire-up: `runConformance` persists evidence; `COLLISION:`-prefixed evidence adds scene to the
repair plan regardless of overall score; `repairScene` receives conformance findings when
overall<6 OR has COLLISION; generation/repair apply the soft gate (§4.3).

Other conformance dimensions (0–10 each, overall = mean, <6 → reason):
typography (chars/accents/layout-line estimate vs anchor), color (distinct accents, glow count,
atmospheric count), composition (referenceShares tiers: ≥.2→10, ≥.1→9, >0→8, else 6.5,
−4 per collision), motion (preferred-vocab membership −1 each, delay>1.4 −1 each),
density (over maxElements −2.5 each, >2 objects −1.5 each), negativeSpace (≥5 elements→6,
4→8, overlong headline −1), visualStyle (≥3 atmospheric −2).
Frame stats folded in (`applyFrameStats`): meanLuma≥60 → visualStyle −min(6,(luma−60)/12);
text share <0.005 → typography −3; >0.35 → negativeSpace −3; accent share >0.3 → color −3.
(frameStats: 48×27, text threshold luma>100 — calibrated: text cells peak 125–176 at this
downscale).

---

# 10. QA & SCORING (exact formulas)

## 10.1 Evaluators (qa.ts)
```
A: lens "script-communication: does each frame express its beat without narration?", temp 0.2
B: lens "design-craft: typography, composition, hierarchy, design bible", temp 0.4
C: lens "cold-viewer skeptic: first-impression clarity, phone readability, AI-slop", temp 0.6
```
Prompt: compact bible (§5 values, ~2KB) + beats + image order map + scene summaries +
calibration table (8-10 ship / 6-7 minor / 4-5 noticeable / 0-3 fails your lens; use full
range) + "work efficiently" + scores-only JSON envelope. maxTokens 4000, surgical images
(420→384px jpg). Runs serially through the global queue.

Per scene per dim: median of 3. Per scene stats over the 7 quality dims' per-evaluator means:
`mean/median/variance(mean of (x−mean)²)/confidence = clamp(1−variance/6,0,1)`.

## 10.2 Issues call (only if any scene flagged)
Flag criteria: rel<6 OR clar<6 OR typo<6 OR comp<6 OR des<6 OR aiSlop>6 OR scene median<7;
or overall stats median<8. Images/summaries restricted to flagged scenes. maxTokens 8000,
brevity: ≤4 issues/scene, ≤180ch issue, ≤140ch repair. → merged into aggregated visualQa
(unflagged: technical pass, issues[]).

## 10.3 Slop critic (1 call, temp .4)
Full forbidden-pattern table + images + scene summaries + "do not flag allowed restrained
atmosphere". → projectSeverity, verdict (<4/4-6/>6), findings[type, evidence, severity].

## 10.4 aggregateQa (exact)
```
sceneQuality_s = mean(7 dims of s.scores)                       // aiSlop excluded here
overallQuality = mean([ sceneQuality_s for all s,
                        mean(sceneQuality_s),
                        mean([10−overall.aiSlopSeverity, 10−slop.projectSeverity]),
                        conformance.overall ])
confidence = overall.stats.confidence ; variance = overall.stats.variance

reasons (ordered):
  technical.errors (except "silent render" note)
  overallQuality < 8            (QA_THRESHOLDS.overallQualityMin)
  slop.projectSeverity > 6
  novelty rejects
  conformance && conformance.overall < 6
  confidence < 0.5 (unstable judges)
  per scene: technicalCorrectness fail; aiSlopSeverity > 6 (median);
    (rel<6 OR clar<6) AND scene.stats.median < 6.5     ← VARIANCE GUARD (cross-session swings);
    critical issue regex /overlap|unreadable|illegible|cut off|out of frame/
status = fail if technical probe errors (non-silent) OR overall.technicalCorrectness fail;
       else needs_repair if reasons else pass
```

## 10.5 Technical QA
ffprobe: dims==1080×1920, fps≈30, duration vs expected ±1.2s, video h264, audio present iff
hasAudio. Errors push reasons; non-"silent render" errors → status fail.

## 10.6 Novelty (§4.5) — runs pre-render each round; persists qa/novelty.json.

---

# 11. REPAIR LOOP

## 11.1 Plan construction (`buildRepairPlan`)
Add scene when ANY:
- median-driven: aiSlop>6 OR ((rel<6 OR clar<6) AND scene median<6.5) OR typo<6 OR comp<6 OR des<6
  OR technicalCorrectness fail → issues[0..3] + recommendedRepair[0..3] (+ score dump if no issues)
- slop findings severity ≥5
- novelty verdict != accept
- conformance overall <6 OR evidence has `COLLISION:`
Cap: first 6 items per round.

## 11.2 repairScene (per scene)
Findings string: vision issues, vision fixes, `slop[type] sev: evidence`, novelty match,
`reference conformance X/10: evidence`. Empty → "nothing to repair" (recoverable skip).
System prompt: Repair Agent role + **compact bible + primitiveSpecsFor(scene primitives +
headline family) + sceneRulesPrompt + memory** + efficiency nudge ("brief root-cause then JSON")
+ report structure (issue/rootCause/scope/changesMade/preserve/expectedEffect/scene) + minimal-
fixes catalog + overflow-word composition-change hint + enactment guidance + "minimal scope
changing composition+primitives+concept at once will be rejected". temp .4, maxTokens **16000**,
attempts **3**.
Parse gates (each recoverable → re-ask): Zod repairReportSchema; validateScene;
conceptChanged && scope===minimal → reject; textCollisions non-empty (1 retry then accept +
warn). On success: writes scenes/<id>.json + qa/repair-<id>.json {issue,rootCause,scope,
changesMade,preserve,expectedEffect}.
**Policy: repair failures NEVER kill the run** (pipeline catches all, logs
`scene X repair skipped: ...`, continues).

## 11.3 Loop
`while status!=pass && round < 2: build plan → repair each → noveltyStage → re-render →
technicalQa → collectFrames(new label) → runConformance → visionQa(3) → slopCritic → aggregate`.
Then finalize regardless (complete + memory + final.mp4 copy) unless technical fail → status
failed. qa-summary.json always holds honest result.

---

# 12. LLM TRANSPORT (`llm.ts`) — FULL

## 12.1 Queue
`enqueueLlm(task)`: promise-chain tail; before run wait until `queueNextSlot`; finally
`queueNextSlot = now + 900ms + rand(0..700ms)`. All chatRaw calls (text+vision) serialized per
process (concurrency 1). Math.random used ONLY for scheduling jitter (never at render time).

## 12.2 executeChat retry ladder (per queued call, ≤5 transient attempts)
```
POST {baseURL}/chat/completions  timeout 180s   body {model, messages, temperature, max_tokens(default 8000)}
if 524:  consecutive524++ ; if ≥2 → max_tokens = max(4000, floor(cap/2)) ; wait 2s+rand(2s) ; retry
if 429:  wait min(60s, 15000×attempt)+rand(2.5s) ; retry          (FreeUsageLimit windows)
if 5xx or 400-matching /Upstream request failed|Provider returned error|server_error/:
         wait 1500×attempt+rand(2.5s) ; retry
other 4xx → throw non-recoverable
if finish_reason=="length" OR empty content:
         lastError = "truncated (reasoning consumed budget)"/"empty completion";
         max_tokens = min(16000, max(cap×2, 8000)) ; wait 1s×attempt ; retry   (inverse of squeeze)
else return content
network/other exception → wait 1500×attempt+rand(1.5s) ; retry
after attempts → throw stageError llm non-recoverable
```
Known tension: length→double vs524→halve can oscillate for runaway-thinking scenes; floor4000,
cap16000.

## 12.3 Structured output
`extractJson`: fenced-block preference; balanced scan tracking in-string escapes;
`parseLenient` (JSON.parse then trailing-comma strip `,\s*([}\]])`→`$1`);
diagnostic on fail: openCount−closeCount>0 → "TRUNCATED… Re-ask: output a SHORTER response…".
`completeJson`: system+user → chatRaw → extract → parse(Zod); on throw append assistant raw +
user corrective (includes exact Zod issues) → retry up to `attempts ?? 2`; exhausted →
stageError(stage) non-recoverable.

## 12.4 Vision
`chatVision(text, b64[])`: parts [text, image_url…] with **mime sniffed from magic bytes**
(`/9j/` jpeg, `iVBOR` png, `R0lGOD` gif, `UklGR` webp) — earlier bug: JPEGs sent as
image/png, provider occasionally dropped them → model honestly replied VISION_UNAVAILABLE.
`visionJsonCall` (qa): ≤4 attempts, backoff 5s×attempt; VISION_UNAVAILABLE now counted (≤2 →
corrective re-ask "images ARE attached", 3rd → hard fail, never fake scores); parse errors feed
next attempt.

## 12.5 Prompt size tiers (empirical; gateway ~100s window)
- Full bible: colors+typography JSON, grammars+safeArea, motion vocab+durations, forbidden ids,
  primitiveSpecs (all 38 with enum/range details) ≈ 10–11KB → generation calls (analysis, beats,
  candidates, scenes) and Phase-1 everything; caused 524s when output reasoning was long.
- Compact bible (QA evaluators, issues, slop, art director, repair): identity+colors one-liners,
  type tiers, grammar shares, motion vocab, forbidden ids ≈ 2KB.
- sceneRulesPrompt: 4 hard bullets (shared generate+repair).
- primitiveSpecsFor(Set): common params + only scene's primitives' specs + full name list.

---

# 13. SERVER API (`server.ts`, port 8787)

```
GET    /api/projects                    list manifests (sorted updated desc)
POST   /api/projects                    {script≥10ch, title?} → initProject → manifest 201
GET    /api/projects/:id                manifest
PATCH  /api/projects/:id                partial manifest update
PUT    /api/projects/:id/script         {script} → input/script.md
POST   /api/projects/:id/voice          {name, dataBase64} → input/voice<ext>, hasAudio=true
POST   /api/projects/:id/generate       {} → withJob(generate) → generateProject (no resume)
                                         → 202; job runs async in-process
GET    /api/projects/:id/status         {manifest, job{running, stage, detail, error}}
GET    /api/projects/:id/scenes         [{sceneId, scene}]
GET    /api/projects/:id/scenes/:sid    scene
PUT    /api/projects/:id/scenes/:sid    {notes} → withJob(regenerate-scene): regenerateOneScene
                                         + re-render preview → 202
POST   /api/projects/:id/render         withJob(render): render + preview + final copy → 202
GET    /api/projects/:id/qa             {summary, visual, slop, novelty}
POST   /api/projects/:id/qa/rerun       withJob(qa): rerunQa → 202
GET    /api/projects/:id/memory         beats json (debug)
GET    /renders/:id/{preview|final}.mp4 Range-streamed (206, Accept-Ranges)
GET    /api/frames/:id/...              frame images
GET    / (static dist-ui/)              MIME map (html/js/css/json/svg/png/jpg/ico/woff2/mp4/
                                         mp3/wav/map/txt); index.html SPA fallback
```
Jobs: in-memory map keyed by projectId (per-project mutex only — different projects may run
concurrently → two generate processes = double rate-limit pressure; observed). Errors →500 with
StudioError JSON. Range parsing regex for mp4 seeking.

Incident: originally no `.html` in content-type chain → `/` served as octet-stream → browser
DOWNLOADED the UI. Fixed with explicit MIME map (§13).

---

# 14. UI (`ui/`, Vite React, served at :8787 or dev :5173 with proxy)

Screens/logic (App.tsx 436 lines):
- Sidebar: title + script textarea + VO file input (base64→/voice) + "Generate video"
  (creates project if needed then POST generate) + "Save only"; project list with status pills
  (created/analyzing/.../complete/failed) and scene counts; selects project → polls
  /status every1.8s while mounted.
- Main: status pill, live job stage+detail, lastError; pipeline stage table (per-stage status +
  error snippet); timing source/audio duration line.
- Scenes grid (sceneId, visualConcept, composition, duration, element count) → click selects.
- Scene preview: `@remotion/player` Player wrapping ProjectRenderer with scenes=[scene],
  270×480, controls+loop; regen notes textarea → PUT scene (job: regenerate+re-render).
- Rendered preview: `<video src=/renders/<id>/preview.mp4?t=cachebust>` + Re-render /
  Re-run QA / Download final (disabled unless complete).
- QA panel: overall score + status pill + **judge confidence/variance/evaluator count** +
  conformance overall + reasons list + slop severity/verdict + novelty per scene +
  per-scene rel/median/conf line.
`ui:build` → `dist-ui/` (index.html 405B, ~499KB js, ~3.8KB css) served by the API server.

---

# 15. CLI

- `generate`: args --script(required)/--voice/--id/--title/--resume; calls generateProject with
  progress logger `[HH:MM:SS] stage: detail`; prints result JSON (qa trimmed to
  status/overallQuality/reasons); exit1 on throw (stack).
- `render`: loads stored scenes + public audio → renderProject → ffprobe dump.
- `reference` / `reference-analyze`: extraction & analysts (cached; skip-if-exists).

---

# 16. TESTS (76 total; `npm run verify` = typecheck + all)

| File | Coverage |
|---|---|
| schema.test.ts (14) | valid scene; unknown primitive; zero/negative duration; invalid position; motion vocab; timing beyond duration; missing field; invalid param type; strict unknown key; >max elements; >2 accent words; bad sceneId; narrow-anchor overlong headline; short narrow OK; outward offset fail; inward OK; duplicate timeline |
| registry.test.ts (5) | registry↔primitives.json no gaps; all38 Master-Spec names present; unknown resolve throws; category set; design invariants (grammars/motion vocab/accent keys) |
| timing.test.ts (6) | splitPhrases; estimate tiles [0,dur] monotonic; zero-duration throws; beat-phrase matching; wordsToPhrases; fitBeatDurations min1.8+coverage+ids |
| novelty.test.ts (5) | fresh accept0; identical ≥70 reject dims; one shared primitive <50; within-project duplicate reject; dissimilar <50 |
| qa.test.ts (9) | pass when strong; <8 needs_repair; slop>6; technical fail; silent-render reason; novelty reasons; repair plan thresholds; empty plan; slop≥5 only |
| phase2.test.ts (15) | statsOf median/variance/confidence/outlier-immune;3 evaluators distinct lenses; visualQa+evaluator schemas; conformance clean≥8; multi-accent punish; off-reference grammar; over-dense; frameStats bright penalize; pixel analyzer dark bg; conceptChanged true/false; repair schema required fields; candidate schema requires mechanism |
| golden.test.ts (7) | 5 golden scenes validate; real still renders; dark<60 luma + text share bounds; accent restrained; motion early-vs-mid diff 0.001..0.6; full scene conformance ≥8; all conformance ≥8 |
| render.test.ts (4) | real renderMedia output exists >50KB; ffprobe 1080×1920/30/h264; duration ±1.2s; filename |
| project.test.ts (5+1) | fixture scenes/timeline/OUTPUT; `RUN_E2E=1` opt-in full pipeline (skipped by default) |

---

# 17. INCIDENT CHRONOLOGY (Phase 1 → Phase 2, every notable failure + fix)

## Phase 1 (build)
1. Empty repo → scaffold; `path` import in render-bundle broke webpack → split `output.ts`
   (browser-safe) vs `config.ts` (node PATHS).
2. Remotion still OK; full pipeline failures in order: art-director JSON truncated mid-object
   (prompt had invalid few-shot `{7 scores}` placeholder) → concrete few-shot fixed;
   `max_tokens` too low on reasoning model → raised; scene `variant:'bridge'` invalid enum →
   primitiveSpecs with exhaustive enums embedded; **vision 400s** → root cause: qa passed
   file PATHS as base64 (missing `.map(b64)`) — payload invalid; 429 FreeUsageLimit mid-repair
   → backoff; VISION/V1 QA completed at 6.34 with real repair loop (found actual overlap bugs).
3. Render layer bugs found by vision QA: scene.headline + element Headline duplicated (→ schema
   dup rule + prompt); 7-line headline wrap in narrow anchor (→ wordBreak normal); same-anchor
   overlaps (→ anchor-group flex renderer rewrite); neutral Line invisible on near-black
   (→ text.muted); tiny flow chips ~20px (→ fs() floor).
4. E2E demo proj_e2e8 completed: h264 1080×1920/30 + AAC 22.2s; QA 5.6→6.34 over 4 rounds.
5. Server issues: download-instead-of-UI (MIME map fix); render 404 voice.mp3 (bundle cache key
   ignored public/ → added mtime + stale-404 rebundle-once guard).

## Phase 2 (this session)
6. Reference extraction: threshold 0.25 found only1 scene → measured score distribution →
   0.006/min1.5/max26 → 26 scenes/96 frames.
7. Vision analysts: HTTP524 on composite contact-sheet call → dropped sheet from composition
   call, added load-or-run cache; VISION_UNAVAILABLE hard-fail → retry-with-feedback;
   mime image/jpeg now sniffed.
8. QA scale-down for gateway: full bible → compact (evaluators 45min→**90s**); issues call
   only-flagged (surgical images) +4000→8000 + ≤180ch brevity (truncation incident:
   `finish_reason=length` mid-issues-JSON killed a run).
9. 524 adaptation incidents: initial "halve max_tokens on524" caused **truncated JSON** (the
   user's proj_muwsgfuc artDirection failure: content cut at `"emotion`) → attempt1 keeps full
   budget, halve only after consecutive524 with floor4000; added finish_reason=length detection
   (double budget) + truncation-aware re-ask copy.
10. Empty completion content (×several) → double budget (reasoning ate it).
11. Bundle 404 on UI-generated projects (stale public snapshot) → §12/render guards.
12. Offset outward clipping (scene_02 pill, scene_05/06/08 overflows across runs) →
    schema inward-only guard + prompt rule; regenerating invalid scenes on resume (partial
    regen `ctx.only`).
13. Collision detector v1 FPs (scene_02) + FN (scene_06) → group-flow model + offsets +
    charW0.70 pixel-calibration + long-word overflow + thin-threshold0.6 + threshold0.2
    (vision-verified both directions).
14. Repair prompt lacked shared rules (kept emitting outward offsets → skipped repairs) →
    sceneRulesPrompt shared; headline strict-schema rejects on stray element keys →
    normalizeScenes whitelist; repair attempts2→3 + maxTokens16000 + brevity nudge +
    overflow-word composition-change hint.
15. judge cross-session variance measured (identical frames rel7-8 → 2-4) → relevance reasons
    require scene median<6.5 (both aggregateQa and buildRepairPlan).
16. Neutral Line hairline color; fs() floor raised caption.min→label.min(26) after vision
    flagged ~20-26px labels.
17. Non-fatal repair policy (any repair error → skip+log) — runs stopped dying on provider flakiness.

---

# 18. QUALITY NUMBERS (all projects)

## proj_muwt0aze (USER's UI tests; 8 scenes; phrase VO)
| run | overall | conformance | slop | notes |
|---|---|---|---|---|
| initial | — | — | — | render404 (bundle public cache) → fixed |
| r+resume | 6.5 | — | 8 | first QA |
| run4 | 6.91 | 8.8 | 7–8 | +3 scenes regenerated (offset guard) |
| run5 | crashed | — | — | issues truncation@4000 → fixed |
| run6 | 6.96 | 8.7 | 8 | light repair prompt; surgical issues |
| run7 | 6.88 | 9.0 | 8 | collision v1 |
| run8 | **7.03** | 9.0 | 8 | ALL scenes tech=pass; collision gates |
| run9 | 6.96 | 8.9 | 8 | cross-session judge swing observed (rel 7-8→2-4 same frames) |
| run10 | ~7.0 (QA3 in flight at 06:30) | ~9 | 7 | overflow hint; label floor; variance gate |
Per-scene (run8 best):01 7.29,02 7.00,03 7.43,04 7.71,05 6.43,06 6.71,07 7.71,08 6.43.
Persistent blockers: **scene_06 ring×"PENGARUHNYA"** (long word overflows 46% column — repair
hint added, repeatedly dies on truncation/524), **scene_08 grid×last line**, slop7-8.

## proj_ref_demo ("Fewer Excuses" E2E, 6 scenes, TTS VO 21.5s)
complete; final **6.82**, conformance8.7, conf0.99; concepts29/29 with semanticMechanism;
blockers scene_03 (weak metaphor rel4), scene_04 (judge var conf0.72); rounds: 6.9→6.82.
Render: h264 1080×1920@30 + AAC, duration≈audio.

## proj_e2e8 (Phase1 reference-derived? no — Phase1 E2E,7 scenes)
complete; QA 5.6→6.34 over rounds; conformance not yet in Phase1.

## proj_muwsgfuc (user's first UI test)
failed at vision QA (VISION_UNAVAILABLE, pre-mime-fix) → **NOT YET RESUMED** (artDirection
itself was fixed; analysis/beats/timing cached; concepts need re-run or are cached? candidates
were never written → concepts will re-run on resume).

---

# 19. OPEN PROBLEMS (ranked, for the analyst AI)

1. **QA ceiling ~7.0 vs target ≥8.** Distribution: scene medians 6.3–7.7, slop 7–8.
   Levers not yet exhausted: (a) scene_06/08 collisions (fixes staged but model-truncated),
   (b) slop-driven nitpicks (label axis raggedness, weak metaphors in 03/05),
   (c) between-run judge instability corrupting repair targeting.
2. **Reasoning-runaway truncation**: `finish_reason=length` persists at 8000→16000 for heavy
   repair prompts; length↔524 oscillation. Candidates: structured output mode if provider
   supports `response_format`, per-call reasoning-effort knob, splitting repair report vs scene
   into two calls, or accepting scene JSON via partial update diff instead of full rewrite.
3. **Free-tier 524/429 dominate wall clock** (QA round 8–12min; repair scene 1–15min).
   Queue is per-process; two processes bypass each other's queue.
4. **Judge cross-session variance** (identical frames, rel 2-8 across sessions). Options:
   rolling per-dim history in qa-summary, blend t−1 median, more evaluators (5), or
   image-deduplicated scoring cache.
5. **Conformance approximations**: OBJECT_BOX static sizes; 0.70 charW measured once at96px;
   thin-line threshold heuristic; no pixel-level OCR check (could add ffprobe-free text detection
   via brighter-row banding — already prototyped in frame measurement scripts).
6. **Resume semantics**: vision/slop/conformance re-run from scratch every resume (correct per
   spec, expensive); could cache per (scene content hash) → skip unchanged scenes' issues.
7. **proj_muwsgfuc + proj_ref_demo unfinished passes** (queued).
8. **UI**: no live job cancel; no per-round QA history view; generate endpoint doesn't pass
   --resume (always fresh) — CLI only.

---

# 20. ARTIFACT PATHS (for the analyst to request raw evidence)

```
docs/ANALYSIS_HANDOFF.md                 summary handoff (this file's companion)
docs/_inventory.txt                      file line counts + run10 tail
design-system/*.json + PROVENANCE.md     token ledger with confidence
reference/analysis/findings.json         merged 5-analyst reference findings
reference/analysis/all-scores.txt        3560 scene-score samples
reference/analysis/sampled-colors.json   30 frame color samples
reference/analysis/motion-samples/analysis.json  per-scene diffs + sequences
projects/proj_muwt0aze/qa/qa-summary.json        latest full aggregate (scores+reasons+stats)
projects/proj_muwt0aze/qa/visual-qa-raw.json     raw per-evaluator scores (variance forensics)
projects/proj_muwt0aze/qa/frames/r*/             rendered stills per round
projects/proj_muwt0aze/qa/conformance.json       structural scores + COLLISION evidence
projects/proj_muwt0aze/qa/repair-scene_*.json    root-cause reports
projects/proj_ref_demo/...                      second full project (same layout)
e2e/*.log                                       every generation run log (run2..run10, demo-run*)
e2e/muwsgfuc-resume.log, muwt0aze-run*.log      user-test histories
```

# 21. LIVE STATE AT WRITING (2026-10-07 06:40 +07) — RUN10 FINAL

`proj_muwt0aze` run10 finalized: **overall 6.98, conformance 8.9, confidence 1.0,
SLOP 6 (first time at threshold — was 8)**, scene_06 ring×PENGARUHNYA collision **RESOLVED**
(7.14, tech pass — overflow-word composition hint worked). Per-scene: 01=7.00, 02=7.14,
03=6.71, 04=6.86(fail), 05=6.57(fail), 06=7.14, 07=7.86, 08=6.14(fail).
Remaining blockers: scene_05 (tether metaphor — the two Line primitives never render in frame),
scene_08 (headline renders 6 lines over grid — explicit-\n estimate says 4, render disagrees),
scene_04 (tech fail), overall <8.

Next queued: resume `proj_muwsgfuc` → resume `proj_ref_demo` (scene_03) → `npm run verify` →
final Phase-2 report.
