# MASTER DESIGN BIBLE — V2 (reference-derived)

The reference video (`reference/reference.mp4`, 118.7s @ 1024×576) is analyzed by the local
pipeline in `src/reference/` and the MiMo vision analysts. **It is design DNA, not content**: it
constrains style, composition language, typography language, color language, motion language and
visual density — never which objects or metaphors a scene may use.

> Design DNA ≠ scene template: the reference contains clocks and avatars; generated scenes may use
> timelines, cards, targets, grids, diagrams — anything that fits the language and serves the script.

## Files

| File | Governs | Reference evidence |
|---|---|---|
| `colors.json` | backgrounds, text, semantic accents + per-token provenance/confidence | 30-frame pixel sampling + color analyst (conf 0.65–0.9) |
| `typography.json` | families, tiers, casing, alignment, animation behavior | typography analyst (conf 0.6–0.75) |
| `composition.json` | grammars + reference shares, safe area, spacing, density | composition analyst (conf 0.6–0.85) |
| `motion.json` | vocabulary, amplitudes, preferred entrances/exits, measured frame-diff | motion analyst (conf 0.6–0.65) + deterministic diff 0.0112 |
| `primitives.json` | renderable inventory + params (content-side; NOT reference-constrained) | Master Spec §3 |
| `forbidden-patterns.json` | slop definitions | Master Spec §1.12 |
| `PROVENANCE.md` | full provenance ledger incl. deviations | — |

## Identity (reference-derived)

- **Flat minimalist motion graphics**: one text block + one symbolic object, 60–70% of the frame
  left empty; flat vector objects (thin uniform strokes, no gradients/shadows).
- **Backgrounds**: near-black desaturated **teal** `#0B1313` with radial vignette; rare warm brown
  variant for contrast.
- **Type**: bold **grotesque**, **uppercase-preferred, left-aligned** blocks; accent = color shift
  (+ weight) on ≤2 key words; word-by-word reveal animation; tier sizes mapped in `typography.json`.
- **Accents are semantic**: teal `#7FD1BD` (positive/brand), gold `#F5C54D` (important),
  red `#E8475F` (warning only), orange rare warmth. One dominant accent per scene.
- **Composition**: `leftTextRightObject` (30%), `centered` (20%), top/bottom-object splits (30%
  combined), typography-dominant/asymmetric (20%). Safe margins 8% x / 10–14% y.
- **Motion**: restrained (measured frame-diff **0.0112**), static camera, staged sequential
  entrances (reveal/stagger/fade, subtle amplitudes ≤90px), soft ease-out settles, no bounce;
  scene changes read as cut/dissolve + fresh staged entrances; emphasis is typographic/color.

## Enforcement points

- Generation prompts embed these files (`src/agents/context.ts designBiblePrompt`).
- `src/validation` builds element schemas from `primitives.json` (unknown primitive = failure).
- Primitives read tokens at render time (no inline invented values).
- `src/reference/conformance.ts` scores generated scenes against this language (same language,
  different content — never pixel similarity).
- QA: vision + slop + conformance feed the multi-sample score aggregation.
