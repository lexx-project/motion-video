import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import { renderProject, probeRender } from "../src/render/renderProject";
import { testProjectScenes } from "../src/render/testProject";
import { OUTPUT } from "../src/core/output";

/**
 * Real Remotion render smoke test (Step 10/30): a valid scene renders,
 * output matches the centralized output config.
 */
describe("Remotion render", () => {
  let file = "";
  let probe: Awaited<ReturnType<typeof probeRender>>;

  beforeAll(async () => {
    file = await renderProject({ scenes: testProjectScenes, outputName: "test-project.mp4" });
    probe = await probeRender(file, testProjectScenes.reduce((n, s) => n + s.duration, 0));
  }, 300000);

  it("writes the render output", () => {
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBeGreaterThan(50_000);
  });

  it("matches 1080x1920 @30fps h264", () => {
    expect(probe.errors).toEqual([]);
    expect(probe.width).toBe(OUTPUT.width);
    expect(probe.height).toBe(OUTPUT.height);
    expect(Math.abs(probe.fps - OUTPUT.fps)).toBeLessThan(0.05);
    expect(probe.videoCodec).toBe("h264");
  });

  it("matches the expected duration", () => {
    const expected = testProjectScenes.reduce((n, s) => n + s.duration, 0);
    expect(Math.abs(probe.durationSec - expected)).toBeLessThan(1.2);
  });

  it("is stored in out/", () => {
    expect(path.basename(file)).toBe("test-project.mp4");
  });
});
