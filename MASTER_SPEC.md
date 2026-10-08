# MASTER SPEC V1 — AI Motion Video Generator

Status: Draft V1
Purpose: Source of truth for the project architecture, visual system, generation pipeline, QA, and implementation constraints.

## 0. PROJECT DECISION

This project generates short-form vertical motivational motion-design videos from:
- prepared SCRIPT
- existing VO/audio
- fixed project visual language derived once from the original reference video

The original reference video is a one-time design reference. It is NOT a scene template and must NOT be required for every generation.

Core principle:
> SCRIPT decides WHAT is communicated.
> MASTER DESIGN BIBLE decides HOW it looks.
> AI decides WHAT/WHY.
> REMOTION CODE decides HOW it is rendered.

Primary AI model:
- MiMo V2.6 Flash via OpenCode/Zen.
- Use multiple specialized agent calls instead of one monolithic generation prompt when useful.

Renderer:
- Remotion.

Default output:
- 1080x1920
- 9:16
- 30fps
- H.264 video + AAC audio

## 1. NON-NEGOTIABLE RULES

1. Never copy the reference video scene-by-scene.
2. Never require the reference video during normal project generation.
3. Do not hardcode reference scenes as reusable templates.
4. Visuals must be derived from the meaning of the current script.
5. Different scripts should produce meaningfully different visual storytelling.
6. Do not let an LLM freely invent arbitrary Remotion code for each scene.
7. AI outputs structured scene specifications; deterministic Remotion primitives render them.
8. VO is the primary timing source whenever usable timestamps are available.
9. Every generated project passes visual QA, technical QA, slop review, and novelty review.
10. Failed scenes are repaired locally where possible instead of regenerating the entire video.
11. Never invent visual details merely because they appeared in the reference.
12. Avoid generic AI-video aesthetics: excessive particles, random camera movement, unnecessary glow, random 3D objects, excessive transitions, visual clutter, and meaningless animation.

## 2. MASTER DESIGN BIBLE

The reference establishes a design language, not content.

### 2.1 Visual identity

Target feeling:
- cinematic
- premium
- serious
- minimal
- intentional
- modern
- emotionally controlled

General characteristics:
- dark / near-black environments
- strong negative space
- bold typography
- restrained accent colors
- simple geometric / symbolic objects
- atmospheric lighting
- visual metaphors rather than literal stock footage
- typography and objects work together as one composition

### 2.2 Color philosophy

Base:
- near-black / charcoal backgrounds
- off-white primary text

Accents:
- teal/green for positive/cool emphasis
- yellow/gold for important semantic emphasis
- warm orange/brown for selected environmental warmth
- red/magenta only when semantic meaning requires warning/contrast

Rules:
- accent colors are semantic, not decorative
- do not highlight every word
- one dominant accent per scene is preferred
- background glow must remain subordinate to content
- no arbitrary rainbow palettes

Exact palette values should be finalized during implementation by sampling representative reference frames and recording them in `design-system/colors.json`.

### 2.3 Typography

Typography is a primary visual element.

Rules:
- bold / extra-bold sans-serif feel
- short, high-impact phrases
- uppercase is preferred for major headlines
- off-white is the default
- accent only meaningful words
- avoid paragraphs as primary visual content
- maintain generous spacing and hierarchy
- never shrink text merely to fit too much copy

Required typography primitives:
- Headline
- Subheadline
- Label
- WordReveal
- HighlightWord
- CounterText
- Quote
- Caption

### 2.4 Composition

Supported composition grammar:
- centered typography
- left-text / right-object
- right-text / left-object
- object-dominant
- typography-dominant
- asymmetric
- split composition
- top-text / bottom-object
- bottom-text / top-object
- dual-object
- full-frame symbolic composition

Composition must be selected based on story beat and visual hierarchy, not randomly.

### 2.5 Negative space

Negative space is an intentional design element.

Rules:
- never fill empty space merely because it is available
- preserve breathing room around headlines
- avoid overlapping important typography and objects
- allow scenes with very few visual elements when that improves emphasis

## 3. VISUAL VOCABULARY / PRIMITIVE LIBRARY

The library is implemented by the coding agent. The user does not manually create every component.

### 3.1 Typography primitives
- Headline
- WordReveal
- CharacterReveal
- HighlightWord
- CounterText
- Label
- Quote

### 3.2 Object primitives
Initial target set:
- Clock
- Calendar
- ProfileCard
- GenericCard
- Target
- ProgressBar
- Checkbox
- Arrow
- Line
- Circle
- Stack
- Grid
- Indicator
- Number
- Badge

### 3.3 Diagram primitives
- Timeline
- Comparison
- BeforeAfter
- Flow
- Branch
- Relationship
- Progress
- Sequence

### 3.4 Atmospheric primitives
Use sparingly:
- GradientGlow
- SoftOrb
- Grain/Noise
- GridBackground
- LightSweep

Every primitive must expose controlled parameters such as:
- size
- position
- scale
- opacity
- accent
- variant
- rotation
- timing
- entrance
- emphasis
- exit
- density where applicable

Primitives must remain deterministic and reusable.

## 4. STORYTELLING ENGINE

Pipeline:
SCRIPT + VO
→ script analysis
→ semantic beats
→ emotional/semantic keywords
→ candidate visual concepts
→ art direction
→ motion direction
→ timing
→ scene JSON
→ Remotion render

For each beat, identify:
- what is being said
- why it matters
- emotional tone
- key nouns
- key verbs
- abstract meaning
- possible visual metaphors
- visual priority
- typography priority
- expected emphasis moment

The system should generate multiple visual concepts before selecting one.

Example:
Meaning = repetition / stagnation

Candidate concepts:
- repeating daily cards
- looped timeline
- progress reset
- circular path
- repeated identical checkpoints

Do NOT automatically reuse an object simply because it existed in the reference.

## 5. VISUAL CONCEPT GENERATION

For each important beat:
- generate 3–5 candidate concepts
- each concept must communicate the beat without relying on narration alone
- avoid near-duplicates
- include composition and object strategy
- explain the metaphor briefly
- estimate implementation complexity

Art Director selects based on:
1. script relevance
2. clarity
3. design consistency
4. novelty
5. emotional fit
6. motion potential
7. technical feasibility

## 6. MOTION BIBLE

Motion should feel:
- controlled
- intentional
- smooth
- cinematic
- restrained

Entrance vocabulary:
- fade
- reveal
- slide
- scale
- draw
- stagger

Emphasis vocabulary:
- subtle scale
- position shift
- highlight
- glow
- counter change
- controlled reveal

Exit vocabulary:
- fade
- slide
- dissolve
- masked transition

Rules:
- motion must communicate hierarchy or meaning
- no random motion
- no constant camera shake
- no excessive zooms
- no gratuitous glitch
- no transition for transition's sake
- avoid too many simultaneous motion systems in one scene

## 7. VO / TIMING SYSTEM

VO is the preferred timing authority.

Pipeline:
audio
→ transcription
→ word/phrase timestamps
→ semantic emphasis
→ beat boundaries
→ scene durations
→ animation key moments

Important spoken words should be candidates for:
- highlight
- reveal
- scale emphasis
- object state change
- diagram progression

Do not force every spoken word into an animation.

If timestamp precision is unavailable:
- use phrase-level segmentation
- fall back to semantic sentence boundaries
- preserve natural pacing

## 8. SCENE JSON CONTRACT

AI must output structured JSON rather than arbitrary scene code.

Example:

{
  "sceneId": "scene_03",
  "duration": 4.7,
  "purpose": "show repetitive behavior",
  "visualConcept": "repeating_daily_cards",
  "composition": "asymmetric",
  "headline": {
    "text": "JANGAN ULANGI POLA YANG SAMA",
    "accentWords": ["ULANGI"]
  },
  "elements": [
    {
      "primitive": "GenericCard",
      "variant": "daily",
      "position": "left"
    },
    {
      "primitive": "ProgressBar",
      "position": "right"
    }
  ],
  "motion": {
    "entrance": "reveal",
    "emphasis": "subtleScale",
    "exit": "fade"
  }
}

The schema must be validated before rendering.

Unknown primitive names, invalid parameters, impossible durations, and malformed timing data must fail validation instead of silently rendering.

## 9. AGENT ARCHITECTURE

Primary orchestration agent:
- owns project state
- delegates specialist work
- validates outputs
- never skips required QA

Recommended specialist agents:
1. Script Analyst
2. Story Beat Director
3. Visual Concept Designer
4. Visual Alternative Generator
5. Art Director
6. Motion Director
7. Timing Director
8. Remotion Planner
9. Technical Validator
10. Vision QA
11. Slop Critic
12. Novelty Checker
13. Repair Agent
14. Final Editor

Agents may be combined for MVP, but responsibilities must remain conceptually separated.

## 10. NOVELTY SYSTEM

Each completed project stores:
- visual concepts
- composition patterns
- primitive combinations
- motion patterns
- dominant objects
- semantic metaphors

Before accepting a new scene:
- compare against project history
- reject excessive similarity
- generate alternatives when needed

Novelty does NOT mean randomness.
Novelty means:
> different visual solution for the current meaning while remaining inside the same design language.

## 11. QA SYSTEM

Every final render is evaluated.

Scores:
- script relevance: 0–10
- visual clarity: 0–10
- design consistency: 0–10
- typography: 0–10
- composition: 0–10
- motion quality: 0–10
- novelty: 0–10
- AI-slop severity: 0–10, where lower is better
- technical correctness: pass/fail

Minimum target:
- overall quality >= 8/10
- no critical technical failure
- no severe readability issue
- no severe script/visual mismatch
- no severe AI-slop issue

QA must identify exact scene IDs and actionable reasons for failure.

## 12. SELF-REPAIR

If QA fails:
1. identify affected scene(s)
2. identify root cause
3. modify only the necessary scene spec when possible
4. rerender affected output
5. rerun QA
6. stop when acceptance criteria pass or retry budget is exhausted

Do not blindly regenerate the entire project.

## 13. PROJECT MEMORY

Suggested structure:

projects/
  project-id/
    input/
      script.md
      voice.mp3
    analysis/
      script-analysis.json
      beats.json
      timestamps.json
    concepts/
      candidates.json
      selected.json
    scenes/
      scene-001.json
      scene-002.json
    qa/
      visual-qa.json
      slop-qa.json
      novelty.json
    renders/
      preview.mp4
      final.mp4
    manifest.json

Persistent design system:

design-system/
  MASTER_DESIGN_BIBLE.md
  colors.json
  typography.json
  composition.json
  motion.json
  primitives.json
  forbidden-patterns.json

## 14. REPOSITORY ARCHITECTURE

Recommended:

/
├── AGENTS.md
├── MASTER_SPEC.md
├── opencode.json
├── .opencode/
│   └── agents/
│       ├── orchestrator.md
│       ├── script-analyst.md
│       ├── visual-designer.md
│       ├── art-director.md
│       ├── motion-director.md
│       ├── qa.md
│       ├── slop-critic.md
│       ├── novelty-checker.md
│       └── repair.md
├── design-system/
├── src/
│   ├── agents/
│   ├── core/
│   ├── primitives/
│   ├── scenes/
│   ├── render/
│   └── validation/
├── projects/
└── tests/

The original reference video may be stored outside the runtime generation path as:
reference/reference.mp4

It is used for initial design-system extraction only.

## 15. OPENCODE RULE

AGENTS.md must contain concise non-negotiable project rules and explicitly instruct the agent to read MASTER_SPEC.md before making architectural or generation-system changes.

Do not duplicate the entire Master Spec into AGENTS.md.

OpenCode V2 uses AGENTS.md as the persistent project instruction mechanism. Keep the detailed specification in MASTER_SPEC.md and require the agent to read it when relevant.

## 16. ACCEPTANCE CRITERIA

The system is not considered complete until:

- a user can provide script + VO
- the system analyzes the script
- the system creates meaningful visual concepts
- concepts follow the Master Design Bible
- scene JSON validates
- Remotion renders successfully
- output is 1080x1920 by default
- typography remains readable
- visuals meaningfully correspond to narration
- scenes are not simple copies of reference scenes
- repeated projects demonstrate visual variation
- QA can detect weak scenes
- repair can fix weak scenes
- final output passes technical and visual validation
- the reference video is not required for normal generation

## 17. IMPLEMENTATION PHASES

Phase 1 — Foundation
- project structure
- Remotion setup
- JSON schemas
- primitive registry
- design-system files
- project state

Phase 2 — Primitive Library
- implement initial primitives
- deterministic animation utilities
- parameter validation
- visual consistency tests

Phase 3 — Generation Pipeline
- script analysis
- beat generation
- concept generation
- art direction
- scene JSON generation

Phase 4 — VO Timing
- transcription
- timestamp alignment
- beat timing
- animation synchronization

Phase 5 — QA
- render preview
- vision QA
- slop critic
- novelty checker
- repair loop

Phase 6 — UI
- script input
- VO upload
- generate
- preview
- scene-level regeneration
- final render

Phase 7 — Hardening
- error handling
- caching
- deterministic seeds where useful
- performance
- regression tests
- project history

## 18. IMPORTANT DESIGN PHILOSOPHY

This is not a generic AI video generator.

It is a virtual motion-design studio.

The system should behave like:
- a scriptwriter's visual translator
- an art director
- a motion designer
- a technical Remotion engineer
- a visual QA reviewer

It should NOT behave like:
- a random template generator
- a stock-footage generator
- an LLM that dumps arbitrary JSX
- a flashy transition generator
- a prompt-to-video black box

Quality > quantity.
Meaning > decoration.
Consistency > randomness.
Intentional motion > effects.
Script-driven visuals > reference copying.

---

## 19. PHASE 3 � SEMANTIC VISUAL STORYTELLING (UPGRADE)

The studio must behave like a professional motion-design team: understand what the narrator is
saying, design a visual story that communicates it, then deterministically render that story.
Sparse composition does NOT mean sparse storytelling: simple visual language + rich semantic
storytelling. Same reference visual language, different sentences.

### 19.1 Pipeline
SCRIPT + VO ? script analysis ? semantic beats ? VO timing ? **VISUAL STORYBOARD DIRECTOR**
(candidates 3-5 by mechanism ? Art Director 13 criteria, reject-all allowed ? full expansion)
? **SCENE COMPOSER (storyboard compiler)** ? scene JSON ? deterministic render ?
Technical QA ? Vision QA (3 judges) ? **Semantic Visual QA** ? Subtitle QA ? Slop ? Novelty ?
targeted repair ? final render.

### 19.2 Storyboard contract
`src/validation/storyboardSchema.ts`: spokenMeaning, viewerTakeaway, visualMechanism
(taxonomy in `design-system/mechanisms.json`), visualNarrative (order/action/meaning/
visualEvidence), semanticObjects (role/relationship/importance), relationships, typographyPlan,
subtitlePlan, motionBeats, compositionIntent, visualEvidence, forbiddenInterpretations,
noveltyIntent, elementBudget. Embedded into `scene.storyboard` deterministically (never
model-echoed). Human-understandable without seeing the render.

### 19.3 Scene JSON extensions
- `storyboard?` (semantic source preserved), `subtitle?` (phrase-level VO captions with
  validated in-scene timing), element `role` (semantic|supporting|decorative) + `purpose`.
- Dynamic semantic density: hard max 10 elements; guidelines simple 3-5 / normal 5-8 /
  complex 7-10. 3 meaningful > 10 decorative.

### 19.4 Subtitles first-class
Distinct from headline/supporting text. Phrase-level timing injected deterministically from
timestamps.json (never invented); rendered as an editorial caption band in the bottom safe area;
coverage is a QA dimension (target >=8 when VO exists).

### 19.5 Primitives
38 + **Person** + **SpeechBubble** (semantic actors). Generic shapes require documented
role+purpose (else GENERIC penalty). Text-only scenes penalized unless typography is the
intentional mechanism.

### 19.6 QA additions
Semantic Visual QA (relevance, storytelling, deterministic evidence coverage, subtitle coverage,
richness), multi-judge vision (median/variance/confidence), conformance (layout collisions,
subtitle band, text-only, generic, dynamic density), novelty with mechanism dimension.
Targets: overall >=8, semantic relevance >=8, storytelling >=8, clarity >=8, subtitle >=8,
conformance >=8, richness >=8, slop <=6. Never lower thresholds to pass; fix the output.

### 19.7 Repair routing
Root-cause categories: semantic (regenerate storyboard ? recompile scene), layout (deterministic
collision repair), subtitle, typography, composition. No whole-project regeneration.

### 19.8 Runtime rule
Reference analyzed ONCE (design-system + conformance are the runtime reference). No scene
templates; generated visuals must belong to the same design world without copying it.
