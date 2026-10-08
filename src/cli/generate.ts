import fs from "fs";
import path from "path";
import { generateProject } from "../agents/pipeline";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  let scriptFile = arg("script");
  let voiceFile = arg("voice");
  const projectId = arg("id");
  const title = arg("title");
  if (!scriptFile && projectId) {
    const candidateScript = path.resolve(`projects/${projectId}/input/script.md`);
    if (fs.existsSync(candidateScript)) {
      scriptFile = candidateScript;
    }
  }
  if (!voiceFile && projectId) {
    const candidateVoice = path.resolve(`projects/${projectId}/input/voice.mp3`);
    if (fs.existsSync(candidateVoice)) {
      voiceFile = candidateVoice;
    }
  }
  if (!scriptFile) {
    console.error("Usage: npm run generate -- --script path/to/script.md [--voice vo.mp3] [--id proj_x] [--title 'Title']");
    process.exit(1);
  }
  const script = fs.readFileSync(path.resolve(scriptFile), "utf8");
  const result = await generateProject({
    projectId,
    script,
    voicePath: voiceFile ? path.resolve(voiceFile) : undefined,
    title,
    resume: process.argv.includes("--resume"),
    onProgress: (stage, detail) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${stage}${detail ? `: ${detail}` : ""}`),
  });
  console.log(JSON.stringify({ ...result, qa: result.qa ? { status: result.qa.status, overallQuality: Number(result.qa.overallQuality.toFixed(2)), reasons: result.qa.reasons } : undefined }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
