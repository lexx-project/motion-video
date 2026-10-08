import path from "path";
import { runReferenceExtraction } from "../reference/extract";

async function main(): Promise<void> {
  const file = path.resolve(process.argv[2] ?? "reference/reference.mp4");
  console.log(`extracting reference DNA from ${file}`);
  const result = await runReferenceExtraction(file);
  console.log(
    JSON.stringify(
      {
        durationSec: result.metadata.durationSec,
        resolution: `${result.metadata.width}x${result.metadata.height}`,
        fps: result.metadata.fps,
        scenesDetected: result.scenes.length,
        framesExtracted: result.frames.length,
        colorSamples: result.colorSamples.length,
        motionScenes: result.motion.perScene.length,
        globalMotion: result.motion.globalMeanDiff,
        contactSheet: result.contactSheet || "(none)",
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
