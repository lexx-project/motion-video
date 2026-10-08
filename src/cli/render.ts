import fs from "fs";
import path from "path";
import { renderProject, probeRender } from "../render/renderProject";
import { OUTPUT } from "../core/output";
import type { SceneSpec } from "../validation/schema";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const projectId = arg("id");
  if (!projectId) {
    console.error("Usage: npm run render -- --id proj_x [--out final.mp4]");
    process.exit(1);
  }
  const scenesDir = path.join(process.cwd(), "projects", projectId, "scenes");
  const scenes = fs
    .readdirSync(scenesDir)
    .filter((f) => /^scene_\d+\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(scenesDir, f), "utf8")) as SceneSpec);
  const audioFile = fs
    .readdirSync(path.join(process.cwd(), "public", projectId))
    .find((f) => /\.(mp3|wav|m4a|ogg|webm)$/i.test(f));
  const outName = arg("out") ?? `${projectId}.mp4`;
  const file = await renderProject({
    scenes,
    audioPath: audioFile ? `${projectId}/${audioFile}` : undefined,
    outputName: outName,
    onProgress: (p) => process.stdout.write(`\rrendering ${Math.round(p * 100)}%   `),
  });
  console.log("");
  const projectRenderDir = path.join(process.cwd(), "projects", projectId, "renders");
  if (fs.existsSync(projectRenderDir)) {
    fs.copyFileSync(file, path.join(projectRenderDir, outName));
  }
  const probe = await probeRender(file, scenes.reduce((n, s) => n + s.duration, 0));
  console.log(JSON.stringify({ file, expected: { ...OUTPUT }, probe }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
