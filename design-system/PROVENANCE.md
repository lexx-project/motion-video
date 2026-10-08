# Design System Provenance — V2

The reference video **is now present**: `reference/reference.mp4`
(118.675s, 1024×576, 30fps, h264+aac). V2 values are derived from the deterministic local
extraction pipeline plus MiMo vision analysts — see `reference/analysis/`.

## Pipeline

```bash
npm run reference:extract    # ffmpeg: metadata, scene cuts, frames, contact sheet, pixel colors, motion diffs
npm run reference:analyze    # MiMo vision: identity, typography, color, composition, motion (cached)
```

Outputs: `reference/analysis/{metadata,scenes,frames-index,sampled-colors}.json`,
`frames/` (96 frames: start/mid/end per scene + transition-adjacent), `contact-sheet.jpg`,
`motion-samples/` (7 sequences + diffs), `findings-*.json` (per-analyst, each with `confidence`
and `lowConfidenceNotes`).

**No vision API is required for extraction** — frame/scene/color/motion measurement is pure ffmpeg
+ local pixel math. Vision analysts only interpret.

## Ledger (token → source → confidence)

| Token | Value | Source | Confidence |
|---|---|---|---|
| background.base | `#0B1313` | pixel sampling: `#0a1212`×10, `#0b1212`×5 of 30 frames; vision `#0b1313` | 0.90 |
| background.deep / elevated / hairline | derived companions of base | derivation (same teal cast) | 0.60–0.70 |
| background.warmVariant | `#17110B` | warm-brown graded frames (intent unclear) | 0.50 |
| text.primary | `#F4F2ED` | vision estimate; pixel samples diluted by 48×27 downscale | 0.85 |
| text.secondary | `#B5B1A7` | pixel samples of subtitle glyphs | 0.70 |
| text.muted | `#7A776F` | derived | 0.50 |
| accents.teal | `#7FD1BD` | vision: mint brand accent on avatars/logo | 0.75 |
| accents.gold | `#F5C54D` | vision: golden key-word emphasis | 0.70 |
| accents.red | `#E8475F` | vision: pink-red warning phrases (±10 hue/sat) | 0.65 |
| accents.orange | `#E07A3F` | Master Spec §2.2 only — weak reference presence | 0.40 |
| headline default align | `left` | vision: predominantly left-aligned blocks | 0.75 |
| headline size 96px @1080 | ref tier ≈8% frame height → 8.9% of portrait short side | tier mapping | 0.70 |
| subheadline/label sizes | **deviation**: ref tiers 3%/1.5% (17/16px equiv.) raised to 52/34px for phone readability | documented deviation | 0.60 |
| Archivo grotesque | bold grotesque family | vision: "grotesque" (letterforms unreadable at sample res) | 0.65 |
| label tracking 0.12em | slightly wide tracking on uppercase labels | vision | 0.75 |
| safeArea 8%/10%/14% | ref ~8% x, ~12% y; bottom 14% extra for platform UI | vision + deviation | 0.75 |
| maxElementsPerScene = 4 | ref: one text block + one object, 60–70% empty | identity analyst | 0.85 |
| grammar shares | leftTextRightObject .30, centered .20, top/bottom splits .30, typo/asym .20 | composition analyst | 0.60–0.85 |
| slidePx 40 (max 90) | entrances = subtle settles, no off-screen travel | motion analyst | 0.65 |
| entrance easing | ease-out soft settles, no bounce/overshoot | motion analyst | 0.65 |
| motion density restrained | measured global RGB frame-diff = **0.0112** (7 scenes × 5 samples) | deterministic measurement | 0.75 |
| camera static | no pan/zoom/parallax detectable | motion analyst | 0.70 |
| preferred exits fade/dissolve | scene changes read as cut/dissolve + fresh staged entrances | motion analyst | 0.60 |
| word-by-word reveal behavior | sequential L→R reveal, quick fade | typography + motion analysts | 0.65 |

## Known limitations (honest gaps)

- Reference is **landscape 576p**; some small text is unreadable at sample resolution — exact
  letterforms and micro-label sizes could not be verified (confidence capped 0.5–0.65 there).
- Accent hexes from vision were **not pixel-sampled** (accents occupy <5% of frames and are
  diluted by downscale) — confidence 0.65–0.75, ±10 hue/sat.
- Exit behavior and transition type are **inferred** (sampled frames rarely catch mid-transition)
  — confidence 0.6.
- No token is invented: every value above traces to a sample, a finding, or an explicitly marked
  derivation/deviation.

## What the reference does NOT define

Scene content, metaphors, object choices, text, scene order. Clocks/avatars in the reference are
*examples of the object style*, never requirements. `primitives.json` (Master Spec §3) is the
content inventory; the AI selects from it per script meaning.
