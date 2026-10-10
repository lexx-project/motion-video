import { execFile } from "child_process";
import { promisify } from "util";
import { OUTPUT } from "./output";
import { stageError } from "./errors";

const execFileAsync = promisify(execFile);

/**
 * Timing provenance (Batch B / B1).
 *
 * - "word"         : real word-level timestamps (transcript or provided)
 * - "phrase"       : caller-provided phrase timings (or legacy stored data)
 * - "silence"      : proportional phrases + boundaries aligned to MEASURED speech pauses
 * - "proportional" : proportional word-rate split only (no usable speech evidence found)
 * - "estimated"    : no audio (duration guessed from the script)
 * - "provided"     : timestamps supplied with the project input
 *
 * A measured pause is a physical fact, never a semantic sentence boundary: evidence records
 * the gap it snapped to and how far the boundary moved, and nothing claims to know meaning.
 */
export type TimingSource = "word" | "phrase" | "silence" | "proportional" | "estimated" | "provided";

/** ffmpeg silencedetect settings (deterministic for a given file). */
export const SILENCE_DETECT = { noiseDb: -35, minGapSec: 0.25 } as const;

/** How far from a measured pause a scene boundary may sit and still be snapped onto it. */
export const BOUNDARY_SNAP_TOLERANCE_SEC = 1.0;

/** Minimum scene duration (matches the pipeline's fitBeatDurations floor). */
export const MIN_BEAT_DURATION_SEC = 1.8;

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface PhraseTiming {
  text: string;
  start: number;
  end: number;
  emphasis?: boolean;
}

export interface BeatTiming {
  beatId: string;
  start: number;
  end: number;
  duration: number;
  source: TimingSource;
}

export interface SpeechSegment {
  start: number;
  end: number;
}

export interface SpeechGap {
  start: number;
  end: number;
  mid: number;
}

export interface SpeechEvidence {
  /** "silence" when at least one pause was measured, "none" when the file yields nothing */
  source: "silence" | "none";
  durationSec: number;
  segments: SpeechSegment[];
  gaps: SpeechGap[];
  /** settings used, so the measurement is reproducible */
  detect: { noiseDb: number; minGapSec: number };
}

/** Where a scene boundary came from (attached to each beat, never fabricated). */
export interface BoundaryEvidence {
  aligned: boolean;
  alignedTo: "silence-gap" | "phrase" | "proportional" | "word";
  shiftSec: number;
  gap?: { start: number; end: number; mid: number };
}

export const secToFrame = (seconds: number, fps = OUTPUT.fps): number =>
  Math.round(seconds * fps);

export const frameToSec = (frame: number, fps = OUTPUT.fps): number => frame / fps;

export const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

/** Split text into phrase chunks of roughly n words (phrase-level fallback). */
export function splitPhrases(text: string, wordsPerPhrase = 4): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const phrases: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerPhrase) {
    phrases.push(words.slice(i, i + wordsPerPhrase).join(" "));
  }
  return phrases;
}

/**
 * Phrase-level proportional timing when word timestamps are unavailable.
 * Never fakes word-level precision: the caller labels the result with an honest
 * TimingSource ("silence" when pauses were measured, "proportional" otherwise).
 */
export function estimateTimingsFromDuration(
  text: string,
  totalDuration: number,
): PhraseTiming[] {
  if (totalDuration <= 0) {
    throw stageError("timing", "Total audio duration must be > 0", { recoverable: true });
  }
  const phrases = splitPhrases(text);
  const totalWords = Math.max(
    1,
    phrases.reduce((n, p) => n + p.split(" ").length, 0),
  );
  let cursor = 0;
  return phrases.map((p) => {
    const share = p.split(" ").length / totalWords;
    const start = cursor;
    const end = cursor + share * totalDuration;
    cursor = end;
    return { text: p, start, end };
  });
}

/** Map phrases onto beats: each beat consumes the phrases it contains, else proportional. */
export function assignBeatTimings(
  beats: { id: string; text: string }[],
  phrases: PhraseTiming[],
  audioDuration: number,
  source: BeatTiming["source"],
): BeatTiming[] {
  const totalChars = Math.max(
    1,
    beats.reduce((n, b) => n + b.text.length, 0),
  );
  let cursor = 0;
  return beats.map((b) => {
    const normalized = b.text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "");
    const matching = phrases.filter((p) => {
      const pn = p.text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "");
      return pn.length > 6 && normalized.includes(pn.slice(0, Math.min(pn.length, 24)));
    });
    let start: number;
    let end: number;
    if (matching.length > 0) {
      start = matching[0].start;
      end = matching[matching.length - 1].end;
      cursor = Math.max(cursor, end);
    } else {
      const share = b.text.length / totalChars;
      start = cursor;
      end = cursor + share * audioDuration;
      cursor = end;
    }
    if (end <= start) end = start + 0.5;
    return { beatId: b.id, start, end, duration: end - start, source };
  });
}

/** Word timestamps -> phrase timings by grouping consecutive words into ~4-word phrases. */
export function wordsToPhrases(words: WordTimestamp[], wordsPerPhrase = 4): PhraseTiming[] {
  const phrases: PhraseTiming[] = [];
  for (let i = 0; i < words.length; i += wordsPerPhrase) {
    const group = words.slice(i, i + wordsPerPhrase);
    phrases.push({
      text: group.map((w) => w.word).join(" "),
      start: group[0].start,
      end: group[group.length - 1].end,
    });
  }
  return phrases;
}

/* ------------------------- speech evidence + alignment ------------------------ */

interface FfmpegResult {
  stdout?: string;
  stderr?: string;
}

/**
 * Measure speech segments with ffmpeg's silencedetect (deterministic for a given file).
 *
 * A pause is a physical measurement. It is used ONLY to move scene boundaries onto real
 * silence; nothing here claims a pause is a sentence boundary (Batch B / B1).
 */
export async function detectSpeechEvidence(
  file: string,
  opts: { noiseDb?: number; minGapSec?: number } = {},
): Promise<SpeechEvidence> {
  const noiseDb = opts.noiseDb ?? SILENCE_DETECT.noiseDb;
  const minGapSec = opts.minGapSec ?? SILENCE_DETECT.minGapSec;
  const detect = { noiseDb, minGapSec };

  let durationSec = 0;
  try {
    const probe = (await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ])) as unknown as FfmpegResult;
    durationSec = parseFloat(String(probe.stdout ?? "").trim());
  } catch {
    return { source: "none", durationSec: 0, segments: [], gaps: [], detect };
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { source: "none", durationSec: 0, segments: [], gaps: [], detect };
  }

  let log = "";
  try {
    const res = (await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-i", file,
      "-af", `silencedetect=noise=${noiseDb}dB:d=${minGapSec}`,
      "-f", "null", "-",
    ])) as unknown as FfmpegResult;
    log = `${res.stderr ?? ""}\n${res.stdout ?? ""}`;
  } catch {
    return { source: "none", durationSec, segments: [], gaps: [], detect };
  }

  const pauses: { start: number; end: number }[] = [];
  let openStart: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const s = /silence_start:\s*([0-9.]+)/.exec(line);
    if (s) openStart = parseFloat(s[1]);
    const e = /silence_end:\s*([0-9.]+)/.exec(line);
    if (e && openStart !== null) {
      pauses.push({ start: openStart, end: parseFloat(e[1]) });
      openStart = null;
    }
  }
  if (openStart !== null) pauses.push({ start: openStart, end: durationSec });

  const gaps: SpeechGap[] = pauses
    .filter((p) => p.end > p.start)
    .sort((a, b) => a.start - b.start)
    .map((p) => ({ start: p.start, end: p.end, mid: (p.start + p.end) / 2 }))
    .filter((g) => g.mid > 0 && g.mid < durationSec);

  // speech segments = the complement of the pauses inside [0, duration]
  const segments: SpeechSegment[] = [];
  let cursor = 0;
  for (const g of gaps) {
    if (g.start > cursor + 1e-3) segments.push({ start: cursor, end: g.start });
    cursor = Math.max(cursor, g.end);
  }
  if (cursor < durationSec - 1e-3) segments.push({ start: cursor, end: durationSec });

  return { source: segments.length > 0 ? "silence" : "none", durationSec, segments, gaps, detect };
}

export interface TilingSegment {
  start: number;
  end: number;
}

export interface AlignedBoundary {
  /** index of the segment whose END was moved */
  index: number;
  from: number;
  to: number;
  gap: SpeechGap;
  shiftSec: number;
}

export interface TilingAlignment {
  tiling: TilingSegment[];
  moved: number;
  evidence: AlignedBoundary[];
}

/**
 * Move interior boundaries of a contiguous tiling onto measured pauses.
 *
 * - a boundary is a candidate when it sits inside a gap (or within `toleranceSec` of it);
 * - the gap's midpoint is the target (the centre of a real pause);
 * - a move is rejected if it would break `minSegmentSec`, so scene durations stay legal;
 * - the tiling stays contiguous and still ends at the same total duration.
 *
 * Pure and deterministic: no I/O, no randomness.
 */
export function alignTilingToGaps(
  tiling: TilingSegment[],
  gaps: SpeechGap[],
  opts: { toleranceSec?: number; minSegmentSec?: number; minShiftSec?: number } = {},
): TilingAlignment {
  const tolerance = opts.toleranceSec ?? BOUNDARY_SNAP_TOLERANCE_SEC;
  const minSegment = opts.minSegmentSec ?? MIN_BEAT_DURATION_SEC;
  const minShift = opts.minShiftSec ?? 0.05;
  const out: TilingSegment[] = tiling.map((s) => ({ ...s }));
  const evidence: AlignedBoundary[] = [];

  for (let i = 0; i < out.length - 1; i++) {
    const boundary = out[i].end;
    let best: SpeechGap | null = null;
    let bestDistance = Infinity;
    for (const g of gaps) {
      if (g.mid <= 0) continue;
      if (boundary < g.start - tolerance || boundary > g.end + tolerance) continue;
      const d = Math.abs(g.mid - boundary);
      if (d < bestDistance) {
        bestDistance = d;
        best = g;
      }
    }
    if (!best) continue;
    const target = best.mid;
    const shift = target - boundary;
    if (Math.abs(shift) < minShift) continue;
    const prevDur = target - out[i].start;
    const nextDur = out[i + 1].end - target;
    if (prevDur < minSegment - 1e-9 || nextDur < minSegment - 1e-9) continue;
    out[i].end = target;
    out[i + 1].start = target;
    evidence.push({ index: i, from: boundary, to: target, gap: best, shiftSec: shift });
  }

  return { tiling: out, moved: evidence.length, evidence };
}

/**
 * Force a set of durations to tile `audioDuration` exactly while respecting `minDuration`.
 * Scaling preserves relative proportions; the residual is absorbed by the largest segments.
 */
export function tileDurations(durations: number[], audioDuration: number, minDuration: number): number[] {
  const raw = durations.map((d) => (Number.isFinite(d) && d > 0 ? d : minDuration));
  const out = raw.map((d) => Math.max(minDuration, d));
  let sum = out.reduce((a, b) => a + b, 0);
  if (sum <= 0) return out.map(() => audioDuration / Math.max(1, out.length));

  const factor = audioDuration / sum;
  const scaled = out.map((d) => Math.max(minDuration, d * factor));
  let target = scaled.reduce((a, b) => a + b, 0);
  for (let i = 0; i < scaled.length; i++) scaled[i] = Math.max(minDuration, scaled[i]);
  target = scaled.reduce((a, b) => a + b, 0);

  let residual = audioDuration - target;
  const order = scaled
    .map((_, i) => i)
    .sort((a, b) => (residual > 0 ? scaled[b] - scaled[a] : scaled[a] - scaled[b]));
  for (const i of order) {
    if (Math.abs(residual) < 1e-9) break;
    const room = residual > 0 ? Infinity : scaled[i] - minDuration;
    const step = residual > 0 ? Math.min(residual, Math.abs(residual)) : Math.min(room, Math.abs(residual));
    if (step <= 1e-12) continue;
    scaled[i] += residual > 0 ? step : -step;
    residual += residual > 0 ? -step : step;
  }
  return scaled;
}
