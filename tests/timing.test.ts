import { describe, it, expect } from "vitest";
import {
  splitPhrases,
  estimateTimingsFromDuration,
  assignBeatTimings,
  wordsToPhrases,
} from "../src/core/timing";
import { fitBeatDurations } from "../src/agents/voTiming";

const SCRIPT =
  "Every day you say you want to change, but tomorrow you repeat the same thing. " +
  "The gap between who you are and who you want to be is built from tiny choices.";

describe("VO timing (phrase-level fallback, never fake word precision)", () => {
  it("splits into phrases of ~4 words", () => {
    const phrases = splitPhrases("one two three four five six seven eight nine");
    expect(phrases).toEqual(["one two three four", "five six seven eight", "nine"]);
  });

  it("estimates phrase timings that tile the audio exactly", () => {
    const phrases = estimateTimingsFromDuration(SCRIPT, 12);
    expect(phrases.length).toBeGreaterThan(3);
    expect(phrases[0].start).toBeCloseTo(0, 5);
    expect(phrases[phrases.length - 1].end).toBeCloseTo(12, 5);
    for (let i = 1; i < phrases.length; i++) {
      expect(phrases[i].start).toBeGreaterThanOrEqual(phrases[i - 1].end - 1e-9);
    }
  });

  it("rejects zero audio duration", () => {
    expect(() => estimateTimingsFromDuration("hello world", 0)).toThrow();
  });

  it("assigns beats to matching phrases when possible", () => {
    const phrases = estimateTimingsFromDuration(SCRIPT, 12);
    const beats = [
      { id: "b1", text: "Every day you say you want to change" },
      { id: "b2", text: "tomorrow you repeat the same thing" },
    ];
    const timings = assignBeatTimings(beats, phrases, 12, "phrase");
    expect(timings[0].start).toBe(0);
    expect(timings[1].start).toBeGreaterThan(0);
    expect(timings[1].end).toBeLessThanOrEqual(13);
  });

  it("converts word timestamps into phrases", () => {
    const words = [
      { word: "every", start: 0, end: 0.2 },
      { word: "day", start: 0.2, end: 0.4 },
      { word: "you", start: 0.4, end: 0.5 },
      { word: "change", start: 0.5, end: 0.9 },
      { word: "later", start: 1.0, end: 1.4 },
    ];
    const phrases = wordsToPhrases(words, 4);
    expect(phrases[0].text).toBe("every day you change");
    expect(phrases[0].end).toBeCloseTo(0.9, 5);
    expect(phrases[1].text).toBe("later");
  });

  it("fitBeatDurations enforces a minimum and covers the whole audio", () => {
    const beats = [
      { id: "b1", text: "short" },
      { id: "b2", text: "short too" },
    ] as never;
    const phrases = [
      { text: "a", start: 0, end: 1 },
      { text: "b", start: 1, end: 2 },
    ];
    const fitted = fitBeatDurations(beats, phrases, 10, "phrase");
    const total = fitted.reduce((n, b) => n + b.duration, 0);
    expect(total).toBeGreaterThanOrEqual(10 - 0.05);
    for (const b of fitted) expect(b.duration).toBeGreaterThanOrEqual(1.8);
    expect(fitted[0].id).toBe("b1");
    expect(fitted[0].start).toBe(0);
    expect(fitted[1].start).toBeGreaterThan(0);
  });
});
