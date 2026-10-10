import { z } from "zod";
import { composition, motion, primitives, colors, typography } from "../core/designSystem";
import { isKnownPrimitive } from "../core/designSystem";
import { headlinePositionFor, availableWidthPx, wrapLines } from "../scenes/layout";
import { storyboardSchema, subtitleSchema } from "./storyboardSchema";
import { executionPlanSchema } from "./executionPlan";

/** Max headline chars in a narrow (left/right) anchor column before wrapping past 4 lines. */
export const NARROW_HEADLINE_MAX = 34;

const paramToZod = (spec: (typeof primitives.common)[string]): z.ZodTypeAny => {
  let base: z.ZodTypeAny;
  switch (spec.type) {
    case "string":
      base = z.string().max(spec.max ?? 500);
      break;
    case "number": {
      let n = z.number().finite();
      if (typeof spec.min === "number") n = n.min(spec.min);
      if (typeof spec.max === "number") n = n.max(spec.max);
      base = n;
      break;
    }
    case "boolean":
      base = z.boolean();
      break;
    case "enum":
      base = z.enum(spec.values as [string, ...string[]]);
      break;
    case "stringArray": {
      let a = z.array(z.string().max(80));
      if (typeof spec.maxItems === "number") a = a.max(spec.maxItems);
      if (typeof spec.minItems === "number") a = a.min(spec.minItems);
      base = a;
      break;
    }
    case "objectArray": {
      const itemShape: Record<string, z.ZodTypeAny> = {};
      for (const [k, fs] of Object.entries(spec.itemFields)) {
        const f = paramToZod(fs);
        itemShape[k] = "required" in fs && fs.required ? f : f.optional();
      }
      let a = z.array(z.object(itemShape).strict());
      if (typeof spec.maxItems === "number") a = a.max(spec.maxItems);
      if (typeof spec.minItems === "number") a = a.min(spec.minItems);
      base = a;
      break;
    }
    default: {
      const never: never = spec;
      throw new Error(`Unsupported param spec: ${JSON.stringify(never)}`);
    }
  }
  const optional = !("required" in spec && spec.required);
  const defaultValue = "default" in spec ? spec.default : undefined;
  if (defaultValue !== undefined) base = base.default(defaultValue as never);
  else if (optional) base = base.optional();
  return base;
};

const commonShape: Record<string, z.ZodTypeAny> = {};
for (const [key, spec] of Object.entries(primitives.common)) {
  commonShape[key] = paramToZod(spec);
}

/** One Zod schema per registered primitive: common params + primitive-specific params, strict. */
export const elementSchemas: Record<string, z.ZodObject<z.ZodRawShape, "strict">> = {};
for (const [name, def] of Object.entries(primitives.primitives)) {
  const shape: Record<string, z.ZodTypeAny> = { ...commonShape };
  for (const [key, spec] of Object.entries(def.params)) {
    shape[key] = paramToZod(spec);
  }
  shape.primitive = z.literal(name);
  elementSchemas[name] = z.object(shape).strict() as z.ZodObject<z.ZodRawShape, "strict">;
}

/** Dispatching element schema: validates `primitive` first, then the matching param schema. */
export const elementSchema = z
  .object({ primitive: z.string() })
  .passthrough()
  .superRefine((val, ctx) => {
    const name = val.primitive;
    if (typeof name !== "string" || !isKnownPrimitive(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["primitive"],
        message: `Unknown primitive "${String(name)}". Registered primitives: ${Object.keys(
          primitives.primitives,
        ).join(", ")}`,
      });
      return;
    }
    const sub = elementSchemas[name].safeParse(val);
    if (!sub.success) {
      for (const issue of sub.error.issues) {
        ctx.addIssue({ ...issue, path: [...issue.path] });
      }
    }
  });

export const headlineSchema = z
  .object({
    text: z.string().min(1).max(typography.rules.maxHeadlineChars * 3),
    semanticId: z.string().min(2).max(40).regex(/^[A-Za-z][A-Za-z0-9_]*$/).optional(),
    accentWords: z.array(z.string().max(60)).max(colors.rules.maxAccentWordsPerHeadline).optional(),
    // reference DNA: predominantly left-aligned blocks (V2)
    align: z.enum(["left", "center", "right"]).default("left"),
    // optional anchor override (default: derived from composition) - used by the
    // composer's deterministic narrow-column fallback (Phase 3)
    position: z
      .enum(["center", "left", "right", "top", "bottom", "topLeft", "topRight", "bottomLeft", "bottomRight"])
      .optional(),
  })
  .strict();

export const motionSchema = z
  .object({
    entrance: z.enum(motion.vocabulary.entrance as [string, ...string[]]),
    emphasis: z.enum(motion.vocabulary.emphasis as [string, ...string[]]),
    exit: z.enum(motion.vocabulary.exit as [string, ...string[]]),
  })
  .strict();

export const timingSchema = z
  .object({
    entranceAt: z.number().min(0).max(60),
    emphasisAt: z.number().min(0).max(60).optional(),
    exitAt: z.number().min(0).max(60).optional(),
  })
  .strict();

export const sceneSchema = z
  .object({
    sceneId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, "sceneId must be alphanumeric/underscore/dash"),
    duration: z
      .number({ invalid_type_error: "duration must be a number (seconds)" })
      .positive("duration must be > 0 (zero/negative duration scenes are invalid)")
      .max(15, "duration must be <= 15 seconds"),
    purpose: z.string().min(3).max(300),
    visualConcept: z.string().min(2).max(160),
    composition: z.enum(composition.grammars as [string, ...string[]]),
    headline: headlineSchema.optional(),
    elements: z
      .array(elementSchema)
      .min(1, "scene needs at least one element")
      .max(composition.maxElementsPerScene, `max ${composition.maxElementsPerScene} elements per scene (negative space rule)`)
      .transform((els) => els as unknown as SceneElement[]),
    motion: motionSchema,
    timing: timingSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
    /** Phase 3: semantic intent preserved through compilation (never a dumb list of shapes). */
    storyboard: storyboardSchema.optional(),
    /** Phase 3: VO-synced subtitle band (phrase-level timing; deterministic injection). */
    subtitle: subtitleSchema.optional(),
    /** Batch D: deterministic temporal execution plan (compiled from storyboard.motionBeats). */
    executionPlan: executionPlanSchema.optional(),
  })
  .strict()
  .superRefine((scene, ctx) => {
    if (!scene.headline && scene.elements.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["elements"], message: "scene has no renderable content" });
    }
    if (scene.headline) {
      const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
      const headlineNorm = norm(scene.headline.text);
      const dupIdx = scene.elements.findIndex(
        (el) =>
          typeof el.text === "string" &&
          (el.primitive === "Headline" || el.primitive === "WordReveal" || el.primitive === "CharacterReveal" || el.primitive === "HighlightWord") &&
          norm(el.text) === headlineNorm,
      );
      if (dupIdx >= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["elements", dupIdx, "text"],
          message:
            "duplicates scene.headline (would render the same text twice and overlap). Use scene.headline OR a headline element - not both.",
        });
      }
    }
    if (scene.headline && scene.headline.accentWords && scene.headline.accentWords.length > colors.rules.maxAccentWordsPerHeadline) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["headline", "accentWords"],
        message: `max ${colors.rules.maxAccentWordsPerHeadline} accent words per headline (semantic accent rule)`,
      });
    }
    // Anchor-aware headline budget: a left/right column is ~46% of the canvas (~7 chars
    // per line at 96px). Long copy there wraps to 5-7 lines (observed slop failure) -
    // the reference keeps left-column headlines <= ~30 chars. Shorten, don't shrink.
    const narrow = (pos: string): boolean => pos === "left" || pos === "right";
    if (scene.headline) {
      const pos = scene.headline.position ?? headlinePositionFor(scene.composition);
      const limit = narrow(pos) ? NARROW_HEADLINE_MAX : typography.rules.maxHeadlineChars;
      const len = scene.headline.text.replace(/\s+/g, " ").trim().length;
      if (len > limit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["headline", "text"],
          message: `headline is ${len} chars but the "${pos}" anchor only fits ~${limit} (narrow column wraps past ${typography.rules.maxHeadlineLines} lines). Shorten the headline or move it to a wide anchor (top/center/bottom composition).`,
        });
      }
      // Layout-aware line estimate (explicit newlines + greedy wrap) - 6-line headlines
      // were a recurring slop failure even within the char budget.
      const avail = availableWidthPx(pos) - 40;
      const estLines = scene.headline.text
        .split("\n")
        .reduce((n, seg) => n + wrapLines(seg, typography.scale.headline.default, avail), 0);
      if (estLines > typography.rules.maxHeadlineLines) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["headline", "text"],
          message: `headline renders ~${estLines} lines at the "${pos}" anchor (max ${typography.rules.maxHeadlineLines}). Shorten the copy and do not use line breaks (\\n) - the renderer wraps itself.`,
        });
      }
    }
    scene.elements.forEach((el, i) => {
      if (!["Headline", "WordReveal", "CharacterReveal", "HighlightWord"].includes(el.primitive)) return;
      if (typeof el.text !== "string") return;
      const pos = (el.position as string) ?? "center";
      const limit = narrow(pos) ? NARROW_HEADLINE_MAX : typography.rules.maxHeadlineChars;
      const len = el.text.replace(/\s+/g, " ").trim().length;
      if (len > limit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["elements", i, "text"],
          message: `${el.primitive} text is ${len} chars but the "${pos}" anchor fits ~${limit} before exceeding ${typography.rules.maxHeadlineLines} lines. Shorten it or use a wide anchor.`,
        });
      }
    });
    // Phase 3 subtitle contract: phrase timing must fit the scene window (VO-synced;
    // times are injected deterministically from timestamps.json by the composer).
    if (scene.subtitle && scene.subtitle.enabled) {
      scene.subtitle.phrases.forEach((p, i) => {
        if (p.end <= p.start) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["subtitle", "phrases", i, "end"],
            message: `subtitle phrase end (${p.end}) must be greater than start (${p.start})`,
          });
        }
        if (p.end > scene.duration + 0.35) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["subtitle", "phrases", i, "end"],
            message: `subtitle phrase end ${p.end}s exceeds scene duration ${scene.duration}s (+0.35 tolerance) - timing must match the VO window`,
          });
        }
        if (!p.text.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["subtitle", "phrases", i, "text"],
            message: "subtitle phrase text must not be empty",
          });
        }
      });
    }
    // Safe-margin guard: offsets are % of the FULL canvas, so an outward offset on an
    // edge anchor pushes content past the frame (observed: left pill clipped off-screen).
    // Offsets may only move content INWARD from its anchor.
    const outward = (pos: string, ox: number, oy: number): string | null => {
      if (["left", "topLeft", "bottomLeft"].includes(pos) && ox < -0.5)
        return `offsetX ${ox} pushes a left-anchored element past the left safe margin (content would be clipped) - use offsetX >= 0`;
      if (["right", "topRight", "bottomRight"].includes(pos) && ox > 0.5)
        return `offsetX ${ox} pushes a right-anchored element past the right safe margin (content would be clipped) - use offsetX <= 0`;
      if (["top", "topLeft", "topRight"].includes(pos) && oy < -0.5)
        return `offsetY ${oy} pushes a top-anchored element past the top safe margin (content would be clipped) - use offsetY >= 0`;
      if (["bottom", "bottomLeft", "bottomRight"].includes(pos) && oy > 0.5)
        return `offsetY ${oy} pushes a bottom-anchored element past the bottom safe margin (content would be clipped) - use offsetY <= 0`;
      return null;
    };
    scene.elements.forEach((el, i) => {
      const pos = (el.position as string) ?? "center";
      const ox = typeof el.offsetX === "number" ? el.offsetX : 0;
      const oy = typeof el.offsetY === "number" ? el.offsetY : 0;
      const violation = outward(pos, ox, oy);
      if (violation) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["elements", i, "offsetX"], message: violation });
      }
    });
    if (scene.timing) {
      if (scene.timing.entranceAt > scene.duration) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["timing", "entranceAt"], message: "entranceAt exceeds scene duration" });
      }
      if (scene.timing.emphasisAt !== undefined && scene.timing.emphasisAt > scene.duration) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["timing", "emphasisAt"], message: "emphasisAt exceeds scene duration" });
      }
      if (scene.timing.exitAt !== undefined && scene.timing.exitAt > scene.duration) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["timing", "exitAt"], message: "exitAt exceeds scene duration" });
      }
    }
    for (const [i, el] of scene.elements.entries()) {
      if (typeof el.delay === "number" && el.delay > scene.duration) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["elements", i, "delay"], message: "delay exceeds scene duration" });
      }
      if (typeof el.emphasisAt === "number" && el.emphasisAt > scene.duration) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["elements", i, "emphasisAt"], message: "emphasisAt exceeds scene duration" });
      }
      // Batch D: stable semantic identity contract (resolved by the semantic enactment gate)
      const ID_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
      if (typeof el.semanticId === "string" && !ID_RE.test(el.semanticId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["elements", i, "semanticId"],
          message: `semanticId "${el.semanticId}" must be a stable identifier like person_01 (letters/digits/underscore, starting with a letter)`,
        });
      }
      if (typeof el.attachTo === "string") {
        if (!ID_RE.test(el.attachTo)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["elements", i, "attachTo"],
            message: `attachTo "${el.attachTo}" must be a semantic id like card_01`,
          });
        } else if (el.attachTo === el.semanticId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["elements", i, "attachTo"],
            message: "attachTo must reference a DIFFERENT element (an element cannot attach to itself)",
          });
        }
      }
    }
    // semanticIds must be unique: resolution would otherwise be ambiguous
    const seenIds = new Map<string, number>();
    if (scene.headline?.semanticId) seenIds.set(scene.headline.semanticId, -1);
    scene.elements.forEach((el, i) => {
      if (typeof el.semanticId !== "string") return;
      if (seenIds.has(el.semanticId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["elements", i, "semanticId"],
          message: `duplicate semanticId "${el.semanticId}" (already used by element ${seenIds.get(el.semanticId)}) - semantic ids must be unique`,
        });
      } else seenIds.set(el.semanticId, i);
    });
    // Batch D execution plan: events must fit the scene window and carry unique stable ids
    if (scene.executionPlan) {
      const seenEvents = new Set<string>();
      scene.executionPlan.events.forEach((ev, i) => {
        if (seenEvents.has(ev.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["executionPlan", "events", i, "id"],
            message: `duplicate execution event id "${ev.id}"`,
          });
        }
        seenEvents.add(ev.id);
        if (ev.atSeconds > scene.duration) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["executionPlan", "events", i, "atSeconds"],
            message: `execution event ${ev.id} atSeconds ${ev.atSeconds} exceeds scene duration ${scene.duration}s (event must happen inside the scene window)`,
          });
        }
        if (typeof ev.target !== "string" || !ev.target.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["executionPlan", "events", i, "target"],
            message: `execution event ${ev.id} needs a target semantic id`,
          });
        }
      });
    }
  });

export type SceneSpec = z.infer<typeof sceneSchema>;

/**
 * Runtime-validated element with typed common fields (primitive-specific params stay open).
 * Produced by sceneSchema.elements transform after the strict per-primitive validation.
 */
export interface SceneElement {
  primitive: string;
  position?: string;
  offsetX?: number;
  offsetY?: number;
  scale?: number;
  opacity?: number;
  rotation?: number;
  accent?: string;
  size?: string;
  variant?: string;
  delay?: number;
  entrance?: string;
  emphasis?: string;
  exit?: string;
  emphasisAt?: number;
  density?: number;
  /** Batch D: stable semantic id binding the element to a storyboard semanticObject */
  semanticId?: string;
  /** Batch D: semantic id of the parent element this one is attached to */
  attachTo?: string;
  [param: string]: unknown;
}

export type HeadlineSpec = z.infer<typeof headlineSchema>;
export type SceneMotion = z.infer<typeof motionSchema>;
