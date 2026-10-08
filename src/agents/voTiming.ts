import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import {
  estimateTimingsFromDuration,
  splitPhrases,
  assignBeatTimings,
  wordsToPhrases,
  type PhraseTiming,
  type WordTimestamp,
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

/** Merge beat texts onto phrase timings, then fit durations to the audio length. */
export function fitBeatDurations(
  beats: Beat[],
  phrases: PhraseTiming[],
  audioDurationSec: number,
  source: TimingBeat["source"],
): TimingBeat[] {
  const raw = assignBeatTimings(
    beats.map((b) => ({ id: b.id, text: b.text })),
    phrases,
    audioDurationSec,
    source,
  );
  const MIN = 1.8;
  const durations = raw.map((r) => Math.max(MIN, r.duration));
  let sum = durations.reduce((a, b) => a + b, 0);
  if (sum < audioDurationSec) {
    const extra = audioDurationSec - sum;
    for (let i = 0; i < durations.length; i++) durations[i] += extra / durations.length;
    sum = audioDurationSec;
  }
  let cursor = 0;
  return raw.map((r, i) => {
    const start = Number(cursor.toFixed(2));
    const end = Number((cursor + durations[i]).toFixed(2));
    cursor += durations[i];
    const beat = beats[i];
    return {
      id: beat?.id ?? r.beatId,
      text: beat?.text ?? "",
      start,
      end,
      duration: Number((end - start).toFixed(2)),
      source,
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
    let source: TimingBeat["source"] = "estimated";

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
        phrases = estimateTimingsFromDuration(script, audioDurationSec);
        source = "phrase";
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

    const beatsWithTiming = fitBeatDurations(beats.beats, phrases, audioDurationSec, source);
    const timestamps: Timestamps = { source, audioDurationSec: hasAudio ? audioDurationSec : undefined, phrases };
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
