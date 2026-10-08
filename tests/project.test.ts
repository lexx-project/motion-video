import { describe, it, expect } from "vitest";
import { testProjectScenes } from "../src/render/testProject";
import { validateScenes, validateProjectTimeline, totalDurationSec } from "../src/validation/validate";
import { OUTPUT } from "../src/core/output";

describe("test project fixture", () => {
  it("every hand-authored test scene validates", () => {
    const { valid, failures } = validateScenes(testProjectScenes);
    expect(failures).toEqual([]);
    expect(valid).toHaveLength(testProjectScenes.length);
  });

  it("passes the cross-scene timeline check", () => {
    expect(validateProjectTimeline(testProjectScenes)).toEqual([]);
  });

  it("produces a sane total duration", () => {
    const total = totalDurationSec(testProjectScenes);
    expect(total).toBeGreaterThan(5);
    expect(total).toBeLessThan(30);
  });

  it("uses the centralized output configuration", () => {
    expect(OUTPUT.width).toBe(1080);
    expect(OUTPUT.height).toBe(1920);
    expect(OUTPUT.fps).toBe(30);
    expect(OUTPUT.videoCodec).toBe("h264");
    expect(OUTPUT.audioCodec).toBe("aac");
  });
});

/**
 * Full generation pipeline test (script -> LLM -> scene JSON -> render -> QA).
 * Requires network + LLM access; opt in with RUN_E2E=1.
 */
describe.runIf(process.env.RUN_E2E === "1")("end-to-end pipeline (opt-in)", () => {
  it("generates a project from a script", async () => {
    const { generateProject } = await import("../src/agents/pipeline");
    const result = await generateProject({
      projectId: `proj_e2e_${Date.now()}`,
      script:
        "You keep saying tomorrow you will change, but tomorrow you repeat the same thing. " +
        "Discipline is choosing what you want most over what you want now.",
      title: "E2E test",
    });
    expect(result.status).toBe("complete");
    expect(result.sceneIds.length).toBeGreaterThanOrEqual(3);
    expect(result.qa?.overallQuality).toBeGreaterThan(0);
  }, 600000);
});
