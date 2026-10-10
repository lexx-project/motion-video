import { detectSpeechEvidence, alignTilingToGaps } from "../src/core/timing";

async function main(): Promise<void> {
  const ev = await detectSpeechEvidence("projects/proj_p3_demo/input/voice.wav");
  console.log(`source=${ev.source} dur=${ev.durationSec.toFixed(3)} detect=${JSON.stringify(ev.detect)}`);
  console.log(`gaps=${ev.gaps.map((g) => `${g.start.toFixed(2)}-${g.end.toFixed(2)}`).join(" | ")}`);
  console.log(`segments=${ev.segments.map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).join(" | ")}`);

  const tiling = [
    { start: 0, end: 5.9 },
    { start: 5.9, end: 10.11 },
    { start: 10.11, end: 12.74 },
    { start: 12.74, end: 16.95 },
    { start: 16.95, end: 21.15 },
    { start: 21.15, end: 24.94059 },
  ];
  const a = alignTilingToGaps(tiling, ev.gaps, { minSegmentSec: 1.8 });
  console.log(`moved=${a.moved}`);
  for (const e of a.evidence) {
    console.log(`  boundary[${e.index}] ${e.from.toFixed(3)} -> ${e.to.toFixed(3)} (shift ${e.shiftSec.toFixed(3)})`);
  }
  console.log(`tiling=${a.tiling.map((s) => `${s.start.toFixed(2)}..${s.end.toFixed(2)}`).join(" | ")}`);
  const total = a.tiling[a.tiling.length - 1].end - a.tiling[0].start;
  console.log(`sum=${total.toFixed(3)}`);
  const durs = a.tiling.map((s) => s.end - s.start);
  console.log(`minDur=${Math.min(...durs).toFixed(3)}`);
}

void main();
