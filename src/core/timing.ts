import { OUTPUT } from "./output";
import { stageError } from "./errors";

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
  source: "word" | "phrase" | "estimated";
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
 * Never fakes word-level precision: every beat is marked source="estimated".
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
