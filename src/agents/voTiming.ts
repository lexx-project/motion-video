import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import {
  estimateTimingsFromDuration,
  splitPhrases,
  assignBeatTimings,
  wordsToPhrases,
  detectSpeechEvidence,
  alignTilingToGaps,
  tileDurations,
  MIN_BEAT_DURATION_SEC,
  BOUNDARY_SNAP_TOLERANCE_SEC,
  type PhraseTiming,
  type WordTimestamp,
  type SpeechEvidence,
  type SpeechGap,
  type TimingSource,
} from "../core/timing";
import { markStage, readJson, updateManifest, writeJson, writeText } from "../core/projectStore";
import { readScript } from "./context";
import { stageError } from "../core/errors";
import type { Beats, Beat } from "./schemas";
import type { Timestamps, TimingBeat } from "./scriptAnalyst";
import { llmConfig } from "./llm";

const execFileAsync = promisify(execFile);

const AUDIO_EXTS = [".mp3", ".wav", ".m4a", ".ogg", ".webm", ".aac", ".flac"];

export function findVoiceFile(projectId: string): string | null {
  const dir = path.join(process.cwd(), "projects", projectId, "input");
  if (!fs.existsSync(dir)) return null;
  const hit = fs
    .readdirSync(dir)
    .map((f) => ({ f, ext: path.extname(f).toLowerCase() }))
    .find(({ ext }) => AUDIO_EXTS.includes(ext));
  return hit ? path.join(dir, hit.f) : null;
}

export async function probeDuration(file: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    const d = parseFloat(stdout.trim());
    if (Number.isFinite(d) && d > 0) return d;
  } catch {
    // fall through
  }
  throw stageError("audio", `Could not read audio duration (ffprobe failed) for ${file}`, {
    recoverable: false,
  });
}

/**
 * Attempt word-level transcription via an OpenAI-compatible /audio/transcriptions
 * endpoint. Returns null when the provider has no transcription credentials -
 * we then fall back to phrase-level timing (never fake word precision).
 */
async function tryTranscribe(file: string): Promise<WordTimestamp[] | null> {
  try {
    const cfg = llmConfig();
    const fd = new FormData();
    const bytes = fs.readFileSync(file);
    fd.append("file", new Blob([new Uint8Array(bytes)]), path.basename(file));
    fd.append("model", "whisper-1");
    fd.append("response_format", "verbose_json");
    const res = await fetch(`${cfg.baseURL.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: fd,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      text?: string;
      words?: { word: string; start: number; end: number }[];
      segments?: { text: string; start: number; end: number }[];
    };
    if (json.words && json.words.length > 0) {
      return json.words.map((w) => ({ word: w.word, start: w.start, end: w.end }));
    }
    return null;
  } catch {
    return null;
  }
}

export interface TimingResult {
  timestamps: Timestamps;
  beatsWithTiming: TimingBeat[];
  audioDurationSec: number;
  hasAudio: boolean;
}

export interface FitOptions {
  /** measured speech pauses; scene boundaries inside/near one are snapped onto its centre */
  gaps?: SpeechGap[];
  toleranceSec?: number;
}

const baseAlignedLabel = (source: TimingSource): "word" | "phrase" | "proportional" =>
  source === "word" ? "word" : source === "phrase" || source === "provided" ? "phrase" : "proportional";

/**
 * Merge beat texts onto phrase timings, then fit them to the audio length.
 *
 * Batch B / B1 guarantees:
 *   - durations tile the audio EXACTLY (sum == audioDurationSec) and respect the 1.8s floor;
 *   - when measured speech pauses are supplied, interior boundaries snap onto pause centres
 *     (never onto a semantic claim - a pause is a physical measurement);
 *   - every beat carries `evidence` describing where its boundary came from.
 */
export function fitBeatDurations(
  beats: Beat[],
  phrases: PhraseTiming[],
  audioDurationSec: number,
  source: TimingBeat["source"],
  options: FitOptions = {},
): TimingBeat[] {
  const raw = assignBeatTimings(
    beats.map((b) => ({ id: b.id, text: b.text })),
    phrases,
    audioDurationSec,
    source,
  );
  const durations = tileDurations(
    raw.map((r) => r.duration),
    audioDurationSec,
    MIN_BEAT_DURATION_SEC,
  );

  const tiling: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const d of durations) {
    tiling.push({ start: cursor, end: cursor + d });
    cursor += d;
  }
  if (tiling.length > 0) tiling[tiling.length - 1].end = audioDurationSec;

  // Word- or user-provided timings are already authoritative - never move their boundaries.
  const canAlign = source !== "word" && source !== "provided" && Boolean(options.gaps && options.gaps.length > 0);
  const aligned = canAlign
    ? alignTilingToGaps(tiling, options.gaps!, {
        minSegmentSec: MIN_BEAT_DURATION_SEC,
        toleranceSec: options.toleranceSec ?? BOUNDARY_SNAP_TOLERANCE_SEC,
      })
    : { tiling, moved: 0, evidence: [] };

  const byIndex = new Map(aligned.evidence.map((e) => [e.index, e]));
  const base = baseAlignedLabel(source);

  return beats.map((beat, i) => {
    const seg = aligned.tiling[i];
    const start = Number(seg.start.toFixed(3));
    const end = Number(seg.end.toFixed(3));
    const hit = byIndex.get(i);
    return {
      id: beat?.id ?? raw[i]?.beatId ?? `b${i + 1}`,
      text: beat?.text ?? "",
      start,
      end,
      duration: Number((end - start).toFixed(3)),
      source,
      evidence: hit
        ? {
            aligned: true,
            alignedTo: "silence-gap",
            shiftSec: Number(hit.shiftSec.toFixed(3)),
            gap: { start: hit.gap.start, end: hit.gap.end, mid: hit.gap.mid },
          }
        : { aligned: false, alignedTo: base, shiftSec: 0 },
    };
  });
}

/** Stage: VO timing (MASTER_SPEC section 7). */
export async function runVoTiming(
  projectId: string,
  beats: Beats,
): Promise<TimingResult> {
  markStage(projectId, "timing", "running");
  try {
    const script = readScript(projectId);
    const voice = findVoiceFile(projectId);
    let audioDurationSec = 0;
    let hasAudio = false;
    let phrases: PhraseTiming[] = [];
    let source: TimingSource = "estimated";
    let speech: SpeechEvidence | null = null;

    if (voice) {
      hasAudio = true;
      audioDurationSec = await probeDuration(voice);
      const provided = readJson<WordTimestamp[] | { words: WordTimestamp[] }>(
        projectId,
        "input/timestamps.json",
      );
      if (provided) {
        const words = Array.isArray(provided) ? provided : provided.words;
        if (Array.isArray(words) && words.length > 0) {
          phrases = wordsToPhrases(words);
          source = "word";
        }
      }
      if (phrases.length === 0) {
        const words = await tryTranscribe(voice);
        if (words && words.length > 0) {
          phrases = wordsToPhrases(words);
          source = "word";
          writeJson(projectId, "analysis/transcript-words.json", words);
        }
      }
      if (phrases.length === 0) {
        // Batch B / B1: no word timestamps -> proportional split, then align to MEASURED
        // speech pauses when ffmpeg can detect them. Never invents word-level precision.
        try {
          speech = await detectSpeechEvidence(voice);
        } catch {
          speech = null;
        }
        phrases = estimateTimingsFromDuration(script, audioDurationSec);
        const usable = Boolean(speech && speech.source === "silence" && speech.gaps.length > 0);
        source = usable ? "silence" : "proportional";
        if (usable) {
          const tiling = phrases.map((p) => ({ start: p.start, end: p.end }));
          const alignedPhrases = alignTilingToGaps(tiling, speech!.gaps, {
            minSegmentSec: 0.5,
            toleranceSec: BOUNDARY_SNAP_TOLERANCE_SEC,
          });
          phrases = phrases.map((p, i) => ({
            ...p,
            start: Number(alignedPhrases.tiling[i].start.toFixed(3)),
            end: Number(alignedPhrases.tiling[i].end.toFixed(3)),
          }));
        }
      }
    } else {
      const words = script.trim().split(/\s+/).length;
      audioDurationSec = Math.max(4, words / 2.6);
      phrases = splitPhrases(script).map((p, i, arr) => {
        const share = p.split(" ").length / Math.max(1, arr.reduce((n, x) => n + x.split(" ").length, 0));
        const start = arr.slice(0, i).reduce((n, x) => n + x.split(" ").length, 0) / Math.max(1, arr.reduce((n, x) => n + x.split(" ").length, 0)) * audioDurationSec;
        return { text: p, start, end: start + share * audioDurationSec };
      });
      source = "estimated";
    }

    const beatsWithTiming = fitBeatDurations(beats.beats, phrases, audioDurationSec, source, {
      gaps: speech?.gaps ?? [],
    });
    const timestamps: Timestamps = {
      source,
      audioDurationSec: hasAudio ? audioDurationSec : undefined,
      phrases,
      ...(speech && speech.gaps.length > 0
        ? {
            gaps: speech.gaps,
            segments: speech.segments,
            snapToleranceSec: BOUNDARY_SNAP_TOLERANCE_SEC,
          }
        : {}),
    };
    writeJson(projectId, "analysis/timestamps.json", timestamps);
    writeJson(projectId, "analysis/beats.json", { ...beats, beats: beats.beats.map((b, i) => ({ ...b, timing: beatsWithTiming[i] })) });

    if (hasAudio) {
      const ext = path.extname(voice!).slice(1);
      const pubDir = path.join(process.cwd(), "public", projectId);
      fs.mkdirSync(pubDir, { recursive: true });
      fs.copyFileSync(voice!, path.join(pubDir, `vo.${ext}`));
    }
    updateManifest(projectId, {
      hasAudio,
      audioDurationSec: hasAudio ? audioDurationSec : undefined,
      timingSource: source,
    });
    markStage(projectId, "timing", "done");
    return { timestamps, beatsWithTiming, audioDurationSec, hasAudio };
  } catch (e) {
    markStage(projectId, "timing", "failed", String(e));
    if (e instanceof Error && "stage" in e) throw e;
    throw stageError("timing", e instanceof Error ? e.message : String(e), { projectId });
  }
}
