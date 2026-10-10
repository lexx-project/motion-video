import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import {
  alignTilingToGaps,
  tileDurations,
  detectSpeechEvidence,
  estimateTimingsFromDuration,
  MIN_BEAT_DURATION_SEC,
  BOUNDARY_SNAP_TOLERANCE_SEC,
  type SpeechGap,
} from "../src/core/timing";
import { fitBeatDurations } from "../src/agents/voTiming";

const execFileAsync = promisify(execFile);

/**
 * Batch B / B1: VO timing evidence.
 *
 * Priority order under test: word timestamps > measured speech pauses > proportional split.
 * No test may ever see a fabricated word timestamp or a source that overstates the evidence.
 */

const SCRIPT =
  "Every day you say you want to change, but tomorrow you repeat the same thing. " +
  "The gap between who you are and who you want to be is built from tiny choices.";

const gaps: SpeechGap[] = [
  { start: 4.0, end: 5.0, mid: 4.5 },
  { start: 9.5, end: 10.5, mid: 10.0 },
];

describe("boundary alignment onto measured pauses (pure)", () => {
  it("snaps boundaries inside a pause to the pause centre", () => {
    const tiling = [
      { start: 0, end: 4.6 },
      { start: 4.6, end: 10.2 },
      { start: 10.2, end: 20 },
    ];
    const r = alignTilingToGaps(tiling, gaps, { minSegmentSec: 1.8 });
    expect(r.moved).toBe(2);
    expect(r.evidence[0].to).toBe(4.5);
    expect(r.evidence[0].gap.mid).toBe(4.5);
    expect(r.evidence[1].to).toBe(10.0);
    expect(r.tiling[0].end).toBe(4.5);
    expect(r.tiling[1].start).toBe(4.5); // tiling stays contiguous
    expect(r.tiling[1].end).toBe(10.0);
    expect(r.tiling[2].start).toBe(10.0);
    expect(r.tiling[2].end).toBe(20);
    const total = r.tiling[r.tiling.length - 1].end - r.tiling[0].start;
    expect(total).toBeCloseTo(20, 6); // total duration preserved
  });

  it("leaves boundaries outside the tolerance untouched", () => {
    const tiling = [
      { start: 0, end: 7 },
      { start: 7, end: 20 },
    ];
    const r = alignTilingToGaps(tiling, gaps, { minSegmentSec: 1.8, toleranceSec: 1.0 });
    expect(r.moved).toBe(0);
    expect(r.tiling[0].end).toBe(7);
  });

  it("never moves a boundary that would break the minimum scene duration", () => {
    // boundary 4.0 sits inside the pause, but snapping to its centre would leave the next
    // segment at 1.0s < min, so both candidate moves must be rejected
    const tight: SpeechGap[] = [{ start: 4.0, end: 5.0, mid: 4.5 }];
    const tiling = [
      { start: 0, end: 4.0 },
      { start: 4.0, end: 5.5 },
      { start: 5.5, end: 9.0 },
    ];
    const r = alignTilingToGaps(tiling, tight, { minSegmentSec: 1.8, toleranceSec: 1.0 });
    expect(r.moved).toBe(0);
    expect(r.tiling[0].end).toBe(4.0);
  });

  it("returns identical results for identical inputs (deterministic)", () => {
    const tiling = [
      { start: 0, end: 4.6 },
      { start: 4.6, end: 10.2 },
      { start: 10.2, end: 20 },
    ];
    const a = alignTilingToGaps(tiling, gaps, { minSegmentSec: 1.8 });
    const b = alignTilingToGaps(tiling, gaps, { minSegmentSec: 1.8 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // and it does not mutate the input
    expect(tiling[0].end).toBe(4.6);
  });

  it("with no measured pauses it changes nothing", () => {
    const tiling = [
      { start: 0, end: 5 },
      { start: 5, end: 10 },
    ];
    const r = alignTilingToGaps(tiling, [], { minSegmentSec: 1.8 });
    expect(r.moved).toBe(0);
    expect(r.tiling).toEqual(tiling);
  });
});

describe("duration tiling conserves the audio length", () => {
  it("tiles exactly and respects the minimum", () => {
    const d = tileDurations([1, 5, 2], 12, 1.8);
    expect(d.reduce((a, b) => a + b, 0)).toBeCloseTo(12, 6);
    for (const v of d) expect(v).toBeGreaterThanOrEqual(1.8 - 1e-9);
  });

  it("handles a deficit and an excess", () => {
    const small = tileDurations([1, 1, 1], 30, 1.8);
    expect(small.reduce((a, b) => a + b, 0)).toBeCloseTo(30, 6);
    const big = tileDurations([50, 50], 10, 1.8);
    expect(big.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 6);
    for (const v of big) expect(v).toBeGreaterThanOrEqual(1.8 - 1e-9);
  });
});

describe("fitBeatDurations provenance + conservation", () => {
  const beats = [
    { id: "b1", text: "Every day you say you want to change" },
    { id: "b2", text: "tomorrow you repeat the same thing" },
    { id: "b3", text: "The gap between who you are and who you want to be is built from tiny choices." },
  ] as never;

  it("conserves duration, respects the floor and records unaligned boundaries", () => {
    const phrases = estimateTimingsFromDuration(SCRIPT, 24);
    const out = fitBeatDurations(beats, phrases, 24, "proportional");
    const total = out.reduce((n, b) => n + b.duration, 0);
    expect(total).toBeCloseTo(24, 3);
    expect(out[0].start).toBe(0);
    expect(out[out.length - 1].end).toBeCloseTo(24, 3);
    for (const b of out) expect(b.duration).toBeGreaterThanOrEqual(MIN_BEAT_DURATION_SEC - 1e-9);
    // contiguous
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeCloseTo(out[i - 1].end, 6);
    // provenance: honest, no silence claimed when none was measured
    for (const b of out) {
      expect(b.evidence).toBeDefined();
      expect(b.evidence!.aligned).toBe(false);
      expect(b.evidence!.alignedTo).toBe("proportional");
      expect(b.evidence!.gap).toBeUndefined();
    }
    expect(out[0].source).toBe("proportional");
  });

  it("records a real snap with its gap when pauses are supplied", () => {
    // pauses placed where this proportional tiling actually lands its boundaries
    const snapGaps: SpeechGap[] = [
      { start: 6.0, end: 7.0, mid: 6.5 },
      { start: 11.5, end: 12.5, mid: 12.0 },
    ];
    const phrases = estimateTimingsFromDuration(SCRIPT, 24);
    const out = fitBeatDurations(beats, phrases, 24, "silence", { gaps: snapGaps });
    expect(out[0].source).toBe("silence");
    const total = out.reduce((n, b) => n + b.duration, 0);
    expect(total).toBeCloseTo(24, 3);
    for (const b of out) expect(b.duration).toBeGreaterThanOrEqual(MIN_BEAT_DURATION_SEC - 1e-9);
    const aligned = out.filter((b) => b.evidence?.aligned);
    expect(aligned.length).toBeGreaterThan(0);
    for (const b of aligned) {
      const idx = out.indexOf(b);
      expect(b.evidence!.alignedTo).toBe("silence-gap");
      // the moved boundary is this beat's END (and the next beat's START)
      expect(b.end).toBeCloseTo(b.evidence!.gap!.mid, 6);
      if (idx + 1 < out.length) expect(out[idx + 1].start).toBeCloseTo(b.evidence!.gap!.mid, 6);
      expect(Math.abs(b.evidence!.shiftSec)).toBeGreaterThan(0.05);
    }
    // boundaries stay contiguous after snapping
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeCloseTo(out[i - 1].end, 6);
  });

  it("keeps the word source honest (no silence claim for word timings)", () => {
    const phrases = [
      { text: "one two three four", start: 0, end: 4 },
      { text: "five six seven", start: 4, end: 10 },
    ];
    const out = fitBeatDurations(
      [
        { id: "b1", text: "one two three four" },
        { id: "b2", text: "five six seven" },
      ] as never,
      phrases,
      10,
      "word",
      { gaps },
    );
    expect(out[0].source).toBe("word");
    expect(out[0].evidence!.alignedTo).toBe("word");
    expect(out[1].evidence!.alignedTo).toBe("word");
    // word timings are authoritative: measured pauses must NOT move them
    expect(out[0].evidence!.aligned).toBe(false);
    expect(out[0].start).toBe(0);
    expect(out[1].start).toBeCloseTo(4, 3);
  });
});

describe("speech evidence from audio (deterministic)", () => {
  let dir = "";
  let synthetic = "";

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "speech-"));
    synthetic = path.join(dir, "gaps.wav");
    // 6s of tone gated by mod(t,2)>=1 -> tone in [1,2) [3,4) [5,6), silence elsewhere
    // (commas inside the expression must be escaped for the filter parser)
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi",
      "-i", "aevalsrc=0.6*sin(2*PI*440*t)*gte(mod(t\\,2)\\,1):s=44100:d=6",
      synthetic,
    ]);
  }, 60000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects pauses and speech spans in a synthetic file", async () => {
    const ev = await detectSpeechEvidence(synthetic);
    expect(ev.source).toBe("silence");
    expect(ev.durationSec).toBeGreaterThan(5.5);
    expect(ev.gaps.length).toBeGreaterThanOrEqual(2);
    expect(ev.segments.length).toBeGreaterThanOrEqual(2);
    // segments and gaps interleave and stay inside the file
    for (const g of ev.gaps) {
      expect(g.end).toBeGreaterThanOrEqual(g.start);
      expect(g.mid).toBeGreaterThan(0);
      expect(g.mid).toBeLessThan(ev.durationSec + 1e-6);
    }
    for (const s of ev.segments) expect(s.end).toBeGreaterThan(s.start);
    // detection settings are reported so the measurement can be reproduced
    expect(ev.detect.noiseDb).toBe(-35);
  }, 60000);

  it("is repeatable for the same file", async () => {
    const a = await detectSpeechEvidence(synthetic);
    const b = await detectSpeechEvidence(synthetic);
    expect(JSON.stringify(a.gaps)).toBe(JSON.stringify(b.gaps));
    expect(JSON.stringify(a.segments)).toBe(JSON.stringify(b.segments));
  }, 60000);

  it("reports source=none for a file it cannot analyse", async () => {
    const ev = await detectSpeechEvidence(path.join(dir, "missing.wav"));
    expect(ev.source).toBe("none");
    expect(ev.gaps).toEqual([]);
  });

  it.runIf(fs.existsSync("projects/proj_p3_demo/input/voice.wav"))(
    "aligns the real Phase-3 VO boundaries onto its measured pauses",
    async () => {
      const ev = await detectSpeechEvidence("projects/proj_p3_demo/input/voice.wav");
      expect(ev.source).toBe("silence");
      expect(ev.gaps.length).toBeGreaterThanOrEqual(5);

      // boundaries as the pre-Batch-B pipeline produced them
      const tiling = [
        { start: 0, end: 5.9 },
        { start: 5.9, end: 10.11 },
        { start: 10.11, end: 12.74 },
        { start: 12.74, end: 16.95 },
        { start: 16.95, end: 21.15 },
        { start: 21.15, end: 24.94059 },
      ];
      const aligned = alignTilingToGaps(tiling, ev.gaps, { minSegmentSec: MIN_BEAT_DURATION_SEC });
      expect(aligned.moved).toBeGreaterThanOrEqual(3);
      const total = aligned.tiling[aligned.tiling.length - 1].end - aligned.tiling[0].start;
      expect(total).toBeCloseTo(24.94059, 3);
      for (const s of aligned.tiling) expect(s.end - s.start).toBeGreaterThanOrEqual(MIN_BEAT_DURATION_SEC - 1e-6);
      for (const e of aligned.evidence) expect(e.to).toBeCloseTo(e.gap.mid, 6);
      expect(BOUNDARY_SNAP_TOLERANCE_SEC).toBeGreaterThan(0);
    },
    60000,
  );
});
