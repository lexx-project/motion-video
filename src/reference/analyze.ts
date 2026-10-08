import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import { chatVision, extractJson } from "../agents/llm";
import { stageError } from "../core/errors";
import type { FrameRef, RefScene, ColorSample, MotionAnalysis } from "./extract";

const execFileAsync = promisify(execFile);

const conf = z.number().min(0).max(1);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const evidence = z.array(z.string().max(300)).max(8);

const identitySchema = z
  .object({
    visualCharacter: z.string().min(5).max(400),
    backgroundTreatment: z.string().min(5).max(300),
    visualDensity: z.enum(["minimal", "moderate", "dense"]),
    negativeSpace: z.string().min(5).max(300),
    objectStyle: z.string().min(5).max(300),
    lighting: z.string().min(5).max(300),
    contrast: z.string().min(5).max(300),
    visualHierarchy: z.string().min(5).max(300),
    confidence: conf,
    evidence,
    lowConfidenceNotes: z.array(z.string().max(200)).max(6).optional(),
  })
  .strict();

const typographySchema = z
  .object({
    fontCategory: z.string().min(3).max(120),
    weight: z.string().min(3).max(80),
    casing: z.enum(["uppercase-preferred", "mixed", "sentence", "lowercase"]),
    sizeHierarchy: z.array(z.string().max(80)).min(2).max(6),
    alignment: z.string().max(120),
    tracking: z.string().max(160),
    wordEmphasis: z.string().max(300),
    textDensity: z.enum(["low", "moderate", "high"]),
    textAnimation: z.string().max(300),
    confidence: conf,
    evidence,
    lowConfidenceNotes: z.array(z.string().max(200)).max(6).optional(),
  })
  .strict();

const colorSchema = z
  .object({
    background: z.object({ value: hex, confidence: conf }),
    textPrimary: z.object({ value: hex, confidence: conf }),
    textSecondary: z.object({ value: hex, confidence: conf }),
    accents: z
      .array(
        z.object({
          role: z.string().max(80),
          value: hex,
          semantic: z.string().max(200),
          confidence: conf,
        }),
      )
      .min(1)
      .max(5),
    warmCoolBalance: z.string().max(200),
    overallLuma: z.enum(["dark", "dark-medium", "mixed", "bright"]),
    reconcileWithSamples: z.string().max(400),
    confidence: conf,
    lowConfidenceNotes: z.array(z.string().max(200)).max(6).optional(),
  })
  .strict();

const GRAMMARS = [
  "centered", "leftTextRightObject", "rightTextLeftObject", "objectDominant",
  "typographyDominant", "asymmetric", "split", "topTextBottomObject",
  "bottomTextTopObject", "dualObject", "fullFrameSymbolic",
] as const;

const compositionSchema = z
  .object({
    recurringGrammars: z
      .array(
        z.object({
          grammar: z.enum(GRAMMARS),
          shareEstimate: z.number().min(0).max(1),
          confidence: conf,
        }),
      )
      .min(2)
      .max(6),
    spacingPatterns: z.array(z.string().max(200)).max(6),
    proportions: z.string().max(300),
    safeMargins: z.string().max(300),
    confidence: conf,
    evidence,
    lowConfidenceNotes: z.array(z.string().max(200)).max(6).optional(),
  })
  .strict();

const motionSchema = z
  .object({
    entrance: z.string().max(300),
    exit: z.string().max(300),
    objectMovement: z.string().max(300),
    textMovement: z.string().max(300),
    scaleBehavior: z.string().max(300),
    easing: z.string().max(200),
    transitionBehavior: z.string().max(300),
    motionDensity: z.enum(["restrained", "moderate", "heavy"]),
    camera: z.string().max(200),
    emphasis: z.string().max(300),
    confidence: conf,
    evidence,
    lowConfidenceNotes: z.array(z.string().max(200)).max(6).optional(),
  })
  .strict();

export type IdentityFindings = z.infer<typeof identitySchema>;
export type TypographyFindings = z.infer<typeof typographySchema>;
export type ColorFindings = z.infer<typeof colorSchema>;
export type CompositionFindings = z.infer<typeof compositionSchema>;
export type MotionFindings = z.infer<typeof motionSchema>;

/* ------------------------------- helpers ---------------------------------- */

const b64 = (f: string): string => fs.readFileSync(f).toString("base64");

/** Deterministic downscale for vision inputs (512px wide) - keeps requests small. */
async function visionCopy(src: string, outDir: string): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, path.basename(src));
  if (!fs.existsSync(out)) {
    await execFileAsync("ffmpeg", ["-hide_banner", "-y", "-i", src, "-vf", "scale=512:-2", "-q:v", "4", out]);
  }
  return out;
}

async function visionJson<T>(
  label: string,
  prompt: string,
  images: string[],
  parse: (o: unknown) => T,
  temperature = 0.3,
): Promise<T> {
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = attempt === 0 ? prompt : `${prompt}\n\nPrevious response was invalid:\n${lastErr}\nRespond with ONLY the corrected JSON object.`;
    const raw = await chatVision(text, images.map(b64), { temperature, maxTokens: 8000 });
    if (/^\s*VISION_UNAVAILABLE\s*$/i.test(raw)) {
      lastErr = `You replied VISION_UNAVAILABLE, but ${images.length} images ARE attached as base64 data URLs. Look again and answer.`;
      continue;
    }
    try {
      return parse(extractJson(raw));
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw stageError("input", `${label}: invalid analysis JSON after retries: ${lastErr}`, { recoverable: false });
}

const spread = <T>(arr: T[], n: number): T[] => {
  if (arr.length <= n) return [...arr];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor((i * (arr.length - 1)) / Math.max(1, n - 1))]);
  return [...new Set(out)];
};

/* ------------------------------- analysts ---------------------------------- */

export async function analyzeIdentity(analysisDir: string, frames: FrameRef[]): Promise<IdentityFindings> {
  const visionDir = path.join(analysisDir, "vision");
  const mids = spread(frames.filter((f) => f.role === "mid"), 6);
  const imgs = await Promise.all(mids.map((f) => visionCopy(path.join(analysisDir, "..", f.file), visionDir)));
  const sheet = path.join(analysisDir, "contact-sheet.jpg");
  const images = fs.existsSync(sheet) ? [await visionCopy(sheet, visionDir), ...imgs] : imgs;
  const prompt = [
    "You are the Visual Identity Analyst of a motion-design studio analyzing a REFERENCE video (design DNA extraction - not content copying).",
    `Images: ${images.length} frames sampled across the video${fs.existsSync(sheet) ? " (first image = contact sheet of scene thumbnails)" : ""}.`,
    "Determine: overall visual character, background treatment, visual density, negative space usage, object style, lighting, contrast, how visual hierarchy is built.",
    "Set confidence honestly 0-1; list lowConfidenceNotes for anything you cannot determine reliably.",
    'Output ONLY JSON: {"visualCharacter":"...","backgroundTreatment":"...","visualDensity":"minimal|moderate|dense","negativeSpace":"...","objectStyle":"...","lighting":"...","contrast":"...","visualHierarchy":"...","confidence":0.85,"evidence":["what you see in specific images"],"lowConfidenceNotes":["..."]}',
  ].join("\n\n");
  const out = await visionJson<IdentityFindings>("identity", prompt, images, (o) => identitySchema.parse(o), 0.4);
  fs.writeFileSync(path.join(analysisDir, "findings-identity.json"), JSON.stringify(out, null, 2));
  return out;
}

export async function analyzeTypography(analysisDir: string, frames: FrameRef[]): Promise<TypographyFindings> {
  const visionDir = path.join(analysisDir, "vision");
  const sorted = [...frames]
    .filter((f) => f.role !== "before" && f.role !== "after")
    .sort((a, b) => b.textLikeRows - a.textLikeRows);
  const picks = spread(sorted.slice(0, Math.max(12, Math.ceil(sorted.length / 2))), 6);
  const imgs = await Promise.all(picks.map((f) => visionCopy(path.join(analysisDir, "..", f.file), visionDir)));
  const motionSeq = JSON.parse(fs.readFileSync(path.join(analysisDir, "motion-samples", "analysis.json"), "utf8")) as {
    sequences: { sceneIndex: number; files: string[] }[];
  };
  const seq = motionSeq.sequences[0];
  const seqImgs = seq ? await Promise.all(seq.files.slice(0, 4).map((f) => visionCopy(path.join(analysisDir, "..", f), visionDir))) : [];
  const images = [...imgs, ...seqImgs];
  const prompt = [
    "You are the Typography Analyst of a motion-design studio analyzing a REFERENCE video (design DNA only).",
    `Images: ${imgs.length} frames chosen for likely text presence${seqImgs.length ? `, followed by ${seqImgs.length} ordered frames of one scene to observe text animation` : ""}.`,
    "Determine: apparent font category (grotesque/geometric/humanist/serif/mono), weight, casing preference, size hierarchy (label the tiers e.g. 'headline ~12% of frame height'), alignment, tracking, how individual words are emphasized, text density per frame, and text animation behavior from the ordered frames (reveal? word-by-word? fade?).",
    "Set confidence honestly 0-1; use lowConfidenceNotes when a detail cannot be read reliably.",
    'Output ONLY JSON: {"fontCategory":"...","weight":"...","casing":"uppercase-preferred|mixed|sentence|lowercase","sizeHierarchy":["tier1: ...","tier2: ..."],"alignment":"...","tracking":"...","wordEmphasis":"...","textDensity":"low|moderate|high","textAnimation":"...","confidence":0.8,"evidence":["..."],"lowConfidenceNotes":["..."]}',
  ].join("\n\n");
  const out = await visionJson<TypographyFindings>("typography", prompt, images, (o) => typographySchema.parse(o), 0.4);
  fs.writeFileSync(path.join(analysisDir, "findings-typography.json"), JSON.stringify(out, null, 2));
  return out;
}

export async function analyzeColors(
  analysisDir: string,
  frames: FrameRef[],
  samples: ColorSample[],
): Promise<ColorFindings> {
  const visionDir = path.join(analysisDir, "vision");
  const picks = spread(frames.filter((f) => f.role === "mid"), 4);
  const imgs = await Promise.all(picks.map((f) => visionCopy(path.join(analysisDir, "..", f.file), visionDir)));

  // deterministic aggregate of pixel samples (ground truth anchor)
  const bg = new Map<string, number>();
  const txt = new Map<string, number>();
  for (const s of samples) {
    bg.set(s.background, (bg.get(s.background) ?? 0) + 1);
    if (s.textPrimary) txt.set(s.textPrimary, (txt.get(s.textPrimary) ?? 0) + 1);
  }
  const topOf = (m: Map<string, number>): [string, number][] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const sampleSummary = {
    pixelSampledBackgrounds: topOf(bg).map(([hex, n]) => ({ hex, frames: n })),
    pixelSampledTextPrimaries: topOf(txt).map(([hex, n]) => ({ hex, frames: n })),
    avgFrameLuma: Number((samples.reduce((a, s) => a + s.meanLuma, 0) / Math.max(1, samples.length)).toFixed(1)),
    frameCount: samples.length,
    note: "pixel samples are 48x27 downscales - bright accents are diluted; use frames to refine",
  };
  const prompt = [
    "You are the Color Analyst of a motion-design studio analyzing a REFERENCE video. Never invent values - derive them from the attached frames and the pixel samples.",
    `Images: ${imgs.length} full frames.`,
    `Pixel-sample ground truth (deterministic local extraction):\n${JSON.stringify(sampleSummary, null, 1)}`,
    "Determine: dominant background color, primary/secondary text colors, accent colors with semantic roles (positive/important/warning), warm/cool balance, overall luminance level. Reconcile your visual estimates with the pixel samples (samples are diluted by downscaling; frames show true vividness). Hex values must be realistic 6-digit.",
    "Set confidence honestly per token (0-1). If a color cannot be pinned down, give confidence <= 0.5 and explain in lowConfidenceNotes.",
    'Output ONLY JSON: {"background":{"value":"#......","confidence":0.9},"textPrimary":{"value":"#......","confidence":0.8},"textSecondary":{"value":"#......","confidence":0.7},"accents":[{"role":"positive/important/warning/other","value":"#......","semantic":"when it is used","confidence":0.75}],"warmCoolBalance":"...","overallLuma":"dark|dark-medium|mixed|bright","reconcileWithSamples":"how your estimates relate to the pixel samples","confidence":0.8,"lowConfidenceNotes":["..."]}',
  ].join("\n\n");
  const out = await visionJson<ColorFindings>("color", prompt, imgs, (o) => colorSchema.parse(o), 0.3);
  fs.writeFileSync(path.join(analysisDir, "findings-color.json"), JSON.stringify(out, null, 2));
  return out;
}

export async function analyzeComposition(analysisDir: string, frames: FrameRef[]): Promise<CompositionFindings> {
  const visionDir = path.join(analysisDir, "vision");
  const mids = spread(frames.filter((f) => f.role === "mid"), 6);
  const imgs = await Promise.all(mids.map((f) => visionCopy(path.join(analysisDir, "..", f.file), visionDir)));
  // contact sheet dropped from this call: composite image pushed generation past the gateway timeout (HTTP 524)
  const images = imgs;
  const prompt = [
    "You are the Composition Analyst of a motion-design studio analyzing a REFERENCE video (design DNA only).",
    `Images: ${images.length} scene frames sampled across the video.`,
    `Recurring composition grammars must be named EXACTLY from this vocabulary: ${GRAMMARS.join(", ")}.`,
    "For each recurring grammar estimate its share (0-1) of the video's scenes. Also describe spacing patterns (margins, grouping gaps), overall proportions (where text vs objects sit), and safe margins.",
    "Set confidence honestly 0-1; lowConfidenceNotes for uncertain reads.",
    'Output ONLY JSON: {"recurringGrammars":[{"grammar":"centered","shareEstimate":0.3,"confidence":0.8}],"spacingPatterns":["..."],"proportions":"...","safeMargins":"...","confidence":0.8,"evidence":["..."],"lowConfidenceNotes":["..."]}',
  ].join("\n\n");
  const out = await visionJson<CompositionFindings>("composition", prompt, images, (o) => compositionSchema.parse(o), 0.4);
  fs.writeFileSync(path.join(analysisDir, "findings-composition.json"), JSON.stringify(out, null, 2));
  return out;
}

export async function analyzeMotion(analysisDir: string): Promise<MotionFindings> {
  const visionDir = path.join(analysisDir, "vision");
  const data = JSON.parse(fs.readFileSync(path.join(analysisDir, "motion-samples", "analysis.json"), "utf8")) as {
    motion: MotionAnalysis;
    sequences: { sceneIndex: number; files: string[] }[];
  };
  const seqs = data.sequences.slice(0, 2);
  const images: string[] = [];
  const labels: string[] = [];
  for (const [si, seq] of seqs.entries()) {
    const letter = String.fromCharCode(65 + si);
    for (const [fi, f] of seq.files.entries()) {
      images.push(await visionCopy(path.join(analysisDir, "..", f), visionDir));
      labels.push(`sequence ${letter} frame ${fi + 1} (evenly spaced within one scene)`);
    }
  }
  const prompt = [
    "You are the Motion Analyst of a motion-design studio analyzing a REFERENCE video from ORDERED FRAME SEQUENCES (not isolated stills).",
    `Images in order:\n${labels.map((l, i) => `${i + 1}. ${l}`).join("\n")}`,
    `Deterministic frame-diff measurements: global mean normalized RGB diff = ${data.motion.globalMeanDiff} (per-scene values in the sequence). Low values = restrained motion.`,
    `Sequence-to-sequence changes (end of one scene vs start of next) also indicate transition behavior - note what changes across sequences.`,
    "Determine: how elements ENTER, how they EXIT, object movement, text movement, scale behavior, easing character (linear/snappy/smooth-overshoot), transition behavior between scenes, motion density (restrained/moderate/heavy), camera behavior, how emphasis moments are animated.",
    "Set confidence honestly 0-1; use lowConfidenceNotes when motion cannot be inferred from the given samples.",
    'Output ONLY JSON: {"entrance":"...","exit":"...","objectMovement":"...","textMovement":"...","scaleBehavior":"...","easing":"...","transitionBehavior":"...","motionDensity":"restrained|moderate|heavy","camera":"...","emphasis":"...","confidence":0.7,"evidence":["..."],"lowConfidenceNotes":["..."]}',
  ].join("\n\n");
  const out = await visionJson<MotionFindings>("motion", prompt, images, (o) => motionSchema.parse(o), 0.4);
  fs.writeFileSync(path.join(analysisDir, "findings-motion.json"), JSON.stringify(out, null, 2));
  return out;
}

export interface ReferenceAnalysis {
  identity: IdentityFindings;
  typography: TypographyFindings;
  colors: ColorFindings;
  composition: CompositionFindings;
  motion: MotionFindings;
}

/** Cached findings are reused so a partial run can resume without re-spending calls. */
function loadOrRun<T>(file: string, label: string, run: () => Promise<T>): Promise<T> {
  if (fs.existsSync(file)) {
    console.log(`[${label}] cached findings found - skipping`);
    return Promise.resolve(JSON.parse(fs.readFileSync(file, "utf8")) as T);
  }
  return run();
}

export async function runReferenceAnalysis(analysisDir: string): Promise<ReferenceAnalysis> {
  const frames: FrameRef[] = JSON.parse(fs.readFileSync(path.join(analysisDir, "frames-index.json"), "utf8"));
  const samples: ColorSample[] = JSON.parse(fs.readFileSync(path.join(analysisDir, "sampled-colors.json"), "utf8"));

  console.log("[1/5] visual identity analyst");
  const identity = await loadOrRun(path.join(analysisDir, "findings-identity.json"), "identity", () =>
    analyzeIdentity(analysisDir, frames),
  );
  console.log("[2/5] typography analyst");
  const typography = await loadOrRun(path.join(analysisDir, "findings-typography.json"), "typography", () =>
    analyzeTypography(analysisDir, frames),
  );
  console.log("[3/5] color analyst");
  const colors = await loadOrRun(path.join(analysisDir, "findings-color.json"), "color", () =>
    analyzeColors(analysisDir, frames, samples),
  );
  console.log("[4/5] composition analyst");
  const composition = await loadOrRun(path.join(analysisDir, "findings-composition.json"), "composition", () =>
    analyzeComposition(analysisDir, frames),
  );
  console.log("[5/5] motion analyst");
  const motion = await loadOrRun(path.join(analysisDir, "findings-motion.json"), "motion", () =>
    analyzeMotion(analysisDir),
  );

  const merged: ReferenceAnalysis = { identity, typography, colors, composition, motion };
  fs.writeFileSync(path.join(analysisDir, "findings.json"), JSON.stringify(merged, null, 2));
  return merged;
}
