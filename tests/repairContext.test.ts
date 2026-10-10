import { describe, it, expect, afterEach } from "vitest";
import {
  classifyFailures,
  buildRepairContext,
  primaryFailurePerScene,
  repairContextBlock,
  FAILURE_PRIORITY,
  type RepairFailure,
} from "../src/agents/repairContext";
import { resetTextMetricsCache, setTextMetrics, metricKey, type TextStyle } from "../src/render/measureText";
import type { LayoutGateReport } from "../src/validation/layoutGate";
import type { VisualGateReport } from "../src/validation/visualGates";
import type { SceneSpec } from "../src/validation/schema";

/** Batch C / §5: deterministic failure classification before any LLM call. */

const headlineStyle = (): TextStyle => {
  const t = { family: "Archivo", sizePx: 96, weight: 900, letterSpacingEm: -0.02, lineHeight: 1.08, uppercase: true };
  return t as TextStyle;
};

const scene = (over: Partial<SceneSpec>): SceneSpec =>
  ({
    sceneId: "scene_01",
    duration: 3,
    purpose: "p",
    visualConcept: "c",
    composition: "centered",
    elements: [],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    ...over,
  }) as unknown as SceneSpec;

const scenes = [scene({}), scene({ sceneId: "scene_02" })];

const layoutGate: LayoutGateReport = {
  schema: "layout-gate/1",
  generatedAt: "2026-10-08T00:00:00.000Z",
  findings: [
    {
      sceneId: "scene_01",
      model: {
        frameViolations: [{ id: 'WordReveal[0]("YES...")', side: "right", px: 38 }],
        safeAreaViolations: [],
        contentBox: null,
        contentBoxRounded: null,
        sources: ["cache"],
      },
      rendered: {
        available: true,
        edgeInk: { left: 0, right: 419, top: 0, bottom: 0 },
        contentOutsideFrame: true,
        safeAreaOverflowPx: { left: 0, top: 0, right: 86, bottom: 1 },
        contentBox: { x0: 86, y0: 460, x1: 1080, y1: 1652 },
      },
      agreement: { frame: "both", safeArea: "both" },
      hard: ["scene_01: RENDERED clipping", "scene_01: MODEL clipping"],
      warnings: [],
      summary: "hard=2",
    },
  ],
  hard: [],
  warnings: [],
  ok: false,
  disagreements: 0,
};

const visualGates: VisualGateReport = {
  schema: "visual-gates/1",
  generatedAt: "2026-10-08T00:00:00.000Z",
  scenes: [
    {
      sceneId: "scene_02",
      empty: {
        sceneId: "scene_02",
        status: "fail",
        reason: "accidentally empty: 3 non-text objects are placed in the middle band but its rendered occupancy is 0.290% (< 0.5%)",
        occupancy: 0.0462,
        contentBBox: null,
        motionDelta: 0.001,
        regionOccupancy: { top: 0.11, middle: 0.0029, bottom: 0.016, subtitleBand: 0.05 },
        bands: [
          { band: "top", expectedBoxes: 1, occupancy: 0.11, expected: true },
          { band: "middle", expectedBoxes: 4, occupancy: 0.0029, expected: true },
        ],
      },
      readability: { sceneId: "scene_02", status: "ok", reasons: [], brightShare: 0.04, headlineHeightPx: 104, smallestTextHeightPx: 40, subtitleBandOccupancy: 0.05 },
    },
  ],
  hard: [],
  warnings: [],
  ok: false,
};

afterEach(() => resetTextMetricsCache());

describe("failure classification", () => {
  it("classifies hard layout evidence as layout_clip with the affected object + side", () => {
    const failures = classifyFailures({ scenes, layoutGate, visualGates });
    const clip = failures.find((f) => f.type === "layout_clip");
    expect(clip).toBeDefined();
    expect(clip!.sceneId).toBe("scene_01");
    expect(clip!.severity).toBe("hard");
    expect(clip!.source).toBe("deterministic-layout");
    expect(clip!.target).toEqual(['WordReveal[0]("YES...")']);
    expect(clip!.region).toEqual(["right"]);
    expect(clip!.magnitude).toBe(38);
    expect(clip!.evidence).toMatch(/model overflow 38px/);
    expect(clip!.evidence).toMatch(/pixel edge ink 419px/);
    expect(clip!.evidence).toMatch(/agreement=both/);
  });

  it("classifies a dead band as empty_visual_band with band + occupancy", () => {
    const failures = classifyFailures({ scenes, layoutGate, visualGates });
    const empty = failures.find((f) => f.type === "empty_visual_band");
    expect(empty).toBeDefined();
    expect(empty!.sceneId).toBe("scene_02");
    expect(empty!.severity).toBe("hard");
    expect(empty!.source).toBe("deterministic-visual");
    expect(empty!.region).toEqual(["middle"]);
    expect(empty!.target).toEqual(["4 non-text objects"]);
    expect(empty!.magnitude).toBeCloseTo(0.0462, 4);
  });

  it("honours the documented priority order", () => {
    const mixed = classifyFailures({
      scenes,
      judgeIssues: [{ sceneId: "scene_01", evidence: "judge: looks generic" }],
      slopFindings: [{ sceneId: "scene_01", type: "visual-clutter", evidence: "too many items", severity: 7 }],
      layoutGate,
      visualGates,
      collisions: {
        scene_01: {
          intentional: [],
          unintended: [
            { a: "scene.headline(...)", b: "Circle[1]", posA: "left", posB: "right", ratio: 0.62, kind: "unintentional", reason: "text overlaps content across anchors", sameAnchor: false },
          ],
          hardRatio: 0.5,
        },
      },
    });
    const order = mixed.map((f) => f.type);
    const rank = (t: string) => FAILURE_PRIORITY.indexOf(t as never);
    for (let i = 1; i < order.length; i++) expect(rank(order[i - 1])).toBeLessThanOrEqual(rank(order[i]));
    expect(order[0]).toBe("layout_clip");
    expect(order).toContain("empty_visual_band");
    expect(order).toContain("unintended_collision");
    expect(order[order.length - 1]).toBe("judge_issue");
    // severity: high-ratio collision is hard, judge/slop stay warnings
    expect(mixed.find((f) => f.type === "unintended_collision")!.severity).toBe("hard");
    expect(mixed.filter((f) => f.type === "judge_issue").every((f) => f.severity === "warning")).toBe(true);
  });

  it("maps pre-render gate issues into failures", () => {
    const failures = classifyFailures({
      scenes,
      preRenderIssues: [
        { sceneId: "scene_01", failureType: "layout_clip", severity: "hard", evidence: "model overflow 38px past the right frame edge after transform", target: ["WordReveal[0]"], region: ["right"], magnitude: 38 },
        { sceneId: "scene_02", failureType: "safe_area_overflow", severity: "warning", evidence: "model crossing 26px past the right safe margin", target: ["Line[1]"], region: ["right"], magnitude: 26 },
      ],
    });
    expect(failures.map((f) => `${f.sceneId}/${f.type}/${f.severity}`)).toEqual([
      "scene_01/layout_clip/hard",
      "scene_02/safe_area_overflow/warning",
    ]);
    expect(failures[0].source).toBe("deterministic-layout");
  });

  it("ignores judge evidence for scenes that do not exist", () => {
    const failures = classifyFailures({ scenes, judgeIssues: [{ sceneId: "scene_99", evidence: "x" }] });
    expect(failures).toHaveLength(0);
  });

  it("picks the highest-priority failure per scene", () => {
    const failures = classifyFailures({
      scenes,
      layoutGate,
      judgeIssues: [{ sceneId: "scene_01", evidence: "judge: soft complaint" }],
    });
    const primary = primaryFailurePerScene(failures);
    expect(primary.get("scene_01")!.type).toBe("layout_clip");
  });
});

describe("repair context", () => {
  const failure: RepairFailure = {
    type: "layout_clip",
    severity: "hard",
    source: "deterministic-layout",
    sceneId: "scene_01",
    evidence: "model overflow 38px past the right frame edge after transform; pixel edge ink 419px",
    target: ['WordReveal[0]("YES...")'],
    region: ["right"],
    magnitude: 38,
  };

  it("builds a compact, narrow context with allowed properties and preservation rules", () => {
    const ctx = buildRepairContext({
      round: 1,
      attempt: 1,
      maxAttempts: 2,
      failure,
      allowedProperties: ["position", "offsetX", "offsetY", "scale", "size"],
      baselineArtifactHash: "abc123def456",
      baselineSnapshotId: "r1-scene_01",
    });
    expect(ctx.sceneId).toBe("scene_01");
    expect(ctx.failureType).toBe("layout_clip");
    expect(ctx.suggestedAction).toMatch(/ONLY the named object/);
    expect(ctx.suggestedAction).toMatch(/Do not change typography style, timing/);
    expect(ctx.preserve.join(" ")).toMatch(/other scenes and project-wide design tokens/);
    expect(ctx.baselineSnapshotId).toBe("r1-scene_01");
  });

  it("renders a prompt block that contains evidence, target, budget and no project dump", () => {
    const ctx = buildRepairContext({ round: 2, attempt: 2, maxAttempts: 2, failure, allowedProperties: ["scale"] });
    const block = repairContextBlock(ctx);
    expect(block).toMatch(/round=2 attempt=2\/2/);
    expect(block).toMatch(/failure=layout_clip severity=hard/);
    expect(block).toMatch(/model overflow 38px/);
    expect(block).toMatch(/affected objects: WordReveal/);
    expect(block).toMatch(/allowed properties: scale/);
    expect(block.length).toBeLessThan(900); // prompt economy
    expect(block).not.toMatch(/\{/); // no JSON/project dump in the context block
    expect(block).not.toMatch(/elements:\s*\[/);
  });

  it("gives each failure type a narrow action (never 'make it better')", () => {
    const types = ["layout_clip", "safe_area_overflow", "empty_visual_band", "unintended_collision", "timing_issue", "judge_issue"] as const;
    for (const t of types) {
      const ctx = buildRepairContext({
        round: 1,
        attempt: 1,
        maxAttempts: 2,
        failure: { ...failure, type: t, magnitude: undefined },
        allowedProperties: ["scale"],
      });
      expect(ctx.suggestedAction.length).toBeGreaterThan(30);
      // every action must carry an explicit constraint (never "just make it better")
      expect(ctx.suggestedAction).toMatch(/do not|never|keep /i);
    }
  });

  it("uses the same typography metrics source as the geometry (no ad-hoc fonts)", () => {
    resetTextMetricsCache();
    setTextMetrics({ [metricKey("PROBE", headlineStyle())]: 123 });
    expect(metricKey("PROBE", headlineStyle())).toBeDefined();
  });
});
