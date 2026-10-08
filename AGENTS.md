# AGENTS.md — Motion Design Studio

This repository is an **AI-driven motion-design studio** that turns SCRIPT + VO into short-form
vertical motion graphics. It is NOT a generic AI video generator.

## Source of truth

- `MASTER_SPEC.md` is the single source of truth. **Read the relevant sections before making any
  architectural or generation-system change.** This file only carries non-negotiable rules.
- The hierarchy is: `MASTER_SPEC.md` → `AGENTS.md` → existing architecture → your decisions.

## Non-negotiable rules

1. **Never bypass scene JSON.** AI produces structured scene specs (`src/validation/schema.ts`,
   Zod-validated). Deterministic Remotion primitives (`src/primitives/`) render them. Never let an
   LLM emit arbitrary JSX/Remotion code for a scene.
2. **Never bypass validation.** Every scene must pass `validateScene` (unknown primitive, bad
   duration, bad position, bad motion, malformed timing = hard failure with actionable errors).
3. **Never bypass QA.** Technical QA, Vision QA, Slop Critic, and Novelty Checker run on every
   project; failures route to the repair loop (`src/agents/repair.ts`).
4. **Never hardcode reference scenes.** No `referenceSceneN()` templates. The reference video is a
   one-time design-DNA source only (`design-system/`), never a runtime dependency.
5. **Preserve deterministic rendering.** Primitives are pure functions of (scene JSON, frame).
   No randomness at render time; no network calls inside components.
6. **Design language lives in `design-system/`.** Colors, type, composition, motion, and forbidden
   patterns are data files consumed by code. Do not invent values inline. V2 values are
   **reference-derived**: regenerate with `npm run reference:extract && npm run reference:analyze`
   and update `PROVENANCE.md` — never fabricate tokens or confidence.
7. **VO is the timing authority** when timestamps exist; phrase-level fallback otherwise. Never
   invent fake word-level precision.
8. **Run `npm run verify` (typecheck + tests) after changes.** Render a representative scene when
   touching primitives or the render layer.
9. **QA decisions are median-of-3-evaluators** (`src/agents/qa.ts`) with variance/confidence
   recorded; never trust or repair on a single judge outlier. Reference conformance
   (`src/reference/conformance.ts`) scores "same design language, different content" — never
   pixel similarity, never scene copying.

## Map

- `src/core` — config, errors, timing, manifest, project IO
- `src/validation` — scene/project JSON schemas + validators
- `src/primitives` — primitive components + registry
- `src/scenes` — SceneRenderer / ProjectRenderer
- `src/render` — Remotion Root/compositions + programmatic render
- `src/agents` — generation pipeline specialists (analysis → storyboards → composer → QA → repair)
- `src/reference` — reference video extraction, vision analysis, conformance + richness evaluators
- `src/validation/storyboardSchema.ts` — Phase 3 storyboard/subtitle contracts
- `src/server` + `ui/` — local-first API + UI (scene intelligence inspector)
- `design-system/` — Master Design Bible data (V2: reference-derived + provenance; `mechanisms.json` taxonomy)
- `reference/` — reference.mp4 + deterministic analysis artifacts (design source only, never a runtime template)
- `projects/` — per-project memory (input, analysis, storyboards, scenes, qa, renders, manifest)
- `tests/` — schema, registry, timing, novelty, QA, pipeline, golden visual, phase3 suites
