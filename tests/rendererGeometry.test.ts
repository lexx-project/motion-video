import { describe, it, expect, afterEach } from "vitest";
import { sceneRenderedGeometry, transformRect, TEXT_BOX_MAX } from "../src/scenes/rendererGeometry";
import { measureTextWidth, resetTextMetricsCache, setTextMetrics, metricKey, type TextStyle } from "../src/render/measureText";
import { safeAreaRect, frameRect, frameOverflow, safeAreaOverflow } from "../src/scenes/bounds";
import { typography } from "../src/core/designSystem";
import type { SceneSpec } from "../src/validation/schema";

/**
 * Batch B / B2 + B8: renderer-aware geometry.
 *
 * The Scene 03 regression is expressed as a PRINCIPLE, not as the literal "YES" text:
 * a large/scaled text block whose *logical* layout box sits inside the safe area, but whose
 * *transformed* rendered bounds leave the frame. The pre-Batch-B model reported 0 violations
 * for exactly that case while the rendered frames carried 419px of right-edge ink.
 */

const headlineStyle = (): TextStyle => {
  const t = typography.scale.headline;
  return { family: "Archivo", sizePx: t.default, weight: t.weight, letterSpacingEm: t.letterSpacingEm, lineHeight: t.lineHeight, uppercase: t.uppercase };
};

const scene = (over: Partial<SceneSpec>): SceneSpec =>
  ({
    sceneId: "fixture",
    duration: 3,
    purpose: "p",
    visualConcept: "c",
    composition: "centered",
    elements: [],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    ...over,
  }) as unknown as SceneSpec;

/** Deterministic text metrics so geometry tests never depend on a browser. */
const withMetrics = (entries: [string, number][]): void => setTextMetrics(Object.fromEntries(entries));

afterEach(() => {
  resetTextMetricsCache();
});

describe("transform math mirrors the renderer", () => {
  it("scale grows around the box centre, not the anchored edge", () => {
    const box = { x0: 800, y0: 400, x1: 1000, y1: 500 };
    const origin = { x: 900, y: 450 };
    const out = transformRect(box, origin, 2, 0, 0, 0);
    expect(out.x0).toBeCloseTo(700, 5);
    expect(out.x1).toBeCloseTo(1100, 5);
    // centre stays put
    expect((out.x0 + out.x1) / 2).toBeCloseTo(900, 5);
    expect((out.y0 + out.y1) / 2).toBeCloseTo(450, 5);
  });

  it("rotation produces the AABB of the rotated corners", () => {
    const box = { x0: 0, y0: 0, x1: 100, y1: 0 }; // degenerate thin bar
    const out = transformRect(box, { x: 50, y: 0 }, 1, 90, 0, 0);
    expect(out.x0).toBeCloseTo(50, 5);
    expect(out.x1).toBeCloseTo(50, 5);
    expect(out.y0).toBeCloseTo(-50, 5);
    expect(out.y1).toBeCloseTo(50, 5);
  });

  it("offsets are applied after scale/rotate (outermost transform)", () => {
    const box = { x0: 0, y0: 0, x1: 10, y1: 10 };
    const out = transformRect(box, { x: 5, y: 5 }, 2, 0, 100, -50);
    expect(out.x0).toBeCloseTo(95, 5); // scale about centre first, then translate
    expect(out.y0).toBeCloseTo(-55, 5);
  });

  it("is deterministic", () => {
    const box = { x0: 10, y0: 20, x1: 110, y1: 220 };
    const a = transformRect(box, { x: 60, y: 120 }, 1.7, 37, 12, -34);
    const b = transformRect(box, { x: 60, y: 120 }, 1.7, 37, 12, -34);
    expect(a).toEqual(b);
  });
});

describe("Scene 03 regression: scaled text leaves the frame (Batch B / B8)", () => {
  const wideWord = "BOLDWORD";

  it("logical box fits the safe area while the rendered bounds clip the right edge", () => {
    const style = headlineStyle();
    withMetrics([
      [metricKey(wideWord, style), 300],
      [metricKey("BOLD", style), 160],
      [metricKey("WORD", style), 150],
      [metricKey("A HEADLINE HERE", { ...style, sizePx: 96 }), 700],
      [metricKey("A", style), 70], [metricKey("HEADLINE", style), 420], [metricKey("HERE", style), 180],
    ]);

    const s = scene({
      composition: "leftTextRightObject",
      headline: { text: "A HEADLINE HERE", accentWords: [], align: "left" },
      elements: [{ primitive: "WordReveal", text: wideWord, position: "right", scale: 2.2, accent: "teal", role: "semantic", purpose: "hero word" }],
    });
    const geo = sceneRenderedGeometry(s);
    const hero = geo.items.find((i) => i.primitive === "WordReveal")!;

    // pre-Batch-B behaviour: the logical box is inside the safe area
    expect(hero.layout.x1).toBeLessThanOrEqual(safeAreaRect().x1 + 1);
    expect(hero.layout.x0).toBeGreaterThan(0);
    // corrected behaviour: the transformed box leaves the frame
    expect(hero.rendered.x1).toBeGreaterThan(1080);
    expect(frameOverflow(hero.rendered).right).toBeGreaterThan(50);
    expect(safeAreaOverflow(hero.rendered).outside).toBe(true);
    // ...and the gate evidence disagrees with the old "0 violations" answer
    expect(frameOverflow(hero.layout).outside).toBe(false);
  });

  it("detects left, top and bottom clipping from transforms too", () => {
    const style = headlineStyle();
    withMetrics([[metricKey("WIDEWORDTEXT", style), 900]]);

    const left = scene({
      elements: [{ primitive: "WordReveal", text: "WIDEWORDTEXT", position: "left", scale: 2.6, role: "semantic", purpose: "hero" }],
    });
    const leftGeo = sceneRenderedGeometry(left);
    expect(frameOverflow(leftGeo.items[0].rendered).left).toBeGreaterThan(0);

    // a wide box rotated 45deg at the top anchor grows above the top edge
    const top = scene({
      elements: [{ primitive: "Line", position: "top", orientation: "horizontal", lengthPct: 100, scale: 1.5, rotation: 45, role: "semantic", purpose: "diagonal" }],
    });
    const topGeo = sceneRenderedGeometry(top);
    const bar = topGeo.items[0];
    expect(bar.rendered.y0).toBeLessThan(bar.layout.y0);
    expect(frameOverflow(bar.rendered).top).toBeGreaterThan(0);
    expect(safeAreaOverflow(bar.rendered).top).toBeGreaterThan(0);

    const bottom = scene({
      elements: [{ primitive: "Circle", position: "bottom", diameterPct: 90, scale: 2.2, role: "semantic", purpose: "big ring" }],
    });
    const bottomGeo = sceneRenderedGeometry(bottom);
    expect(frameOverflow(bottomGeo.items[0].rendered).bottom).toBeGreaterThan(0);
  });

  it("reports safe-area crossing without frame clipping (scale just past the margin)", () => {
    const style = headlineStyle();
    withMetrics([[metricKey("EDGE", style), 240]]);
    const s = scene({ elements: [{ primitive: "WordReveal", text: "EDGE", position: "right", scale: 1.4, role: "semantic", purpose: "edge word" }] });
    const item = sceneRenderedGeometry(s).items[0];
    expect(safeAreaOverflow(item.rendered).outside).toBe(true);
    expect(frameOverflow(item.rendered).outside).toBe(false);
  });
});

describe("group layout mirrors the renderer", () => {
  it("right anchor group is shrink-to-fit, not limited by the anchor's free space", () => {
    const style = headlineStyle();
    withMetrics([[metricKey("WORDY", style), 300], [metricKey("WORD", style), 220]]);
    const s = scene({
      composition: "leftTextRightObject",
      headline: { text: "LEFT", accentWords: [], align: "left" },
      elements: [{ primitive: "WordReveal", text: "WORDY", position: "right", role: "semantic", purpose: "word" }],
    });
    withMetrics([[metricKey("LEFT", style), 200], [metricKey("L", style), 70], [metricKey("EFT", style), 130]]);
    const geo = sceneRenderedGeometry(s);
    const group = geo.groups.find((g) => g.pos === "right")!;
    expect(group.available).toBeCloseTo(86.4, 1); // only 8% of the canvas is right of `left:92%`
    expect(group.width).toBeCloseTo(300, 1); // min-content forces the box wider than `available`
    const item = geo.items.find((i) => i.primitive === "WordReveal")!;
    expect(item.layout.x1).toBeCloseTo(993.6, 0);
    expect(item.layout.x0).toBeCloseTo(693.6, 0);
  });

  it("caps the group with maxWidth and wraps long text inside it", () => {
    const style = headlineStyle();
    const long = "AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH IIII JJJJ";
    const words = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH", "IIII", "JJJJ"];
    const entries: [string, number][] = [[metricKey(long, style), 1600]];
    for (const w of words) entries.push([metricKey(w, style), 320]);
    withMetrics(entries);

    const s = scene({ composition: "topTextBottomObject", elements: [{ primitive: "WordReveal", text: long, position: "top", role: "semantic", purpose: "line" }] });
    const geo = sceneRenderedGeometry(s);
    const group = geo.groups.find((g) => g.pos === "top")!;
    expect(group.width).toBeLessThanOrEqual(group.maxWidthCap + 0.01);
    expect(group.width).toBeLessThanOrEqual(TEXT_BOX_MAX + 0.01);
    const item = geo.items[0];
    expect((item.ink.y1 - item.ink.y0)).toBeGreaterThan(style.sizePx * style.lineHeight + 1); // wrapped to >1 line
    expect(item.ink.x1 - item.ink.x0).toBeLessThanOrEqual(group.width + 1);
  });

  it("scale-around-centre keeps a shrunk object inside its anchor band", () => {
    const s = scene({ elements: [{ primitive: "Circle", position: "right", diameterPct: 40, scale: 0.55, role: "semantic", purpose: "mold" }] });
    const item = sceneRenderedGeometry(s).items[0];
    expect(item.layout.x1).toBeCloseTo(993.6, 0); // unscaled box ends at the anchor
    expect(item.rendered.x1).toBeLessThan(item.layout.x1); // 0.55 scale pulls the paint inward
    expect(item.rendered.x1 - item.rendered.x0).toBeCloseTo((item.layout.x1 - item.layout.x0) * 0.55, 0);
  });

  it("rotation is modelled as an AABB (Arrow direction up/down)", () => {
    const s = scene({ elements: [{ primitive: "Arrow", position: "left", direction: "down", lengthPct: 50, scale: 1, role: "semantic", purpose: "dir" }] });
    const item = sceneRenderedGeometry(s).items[0];
    // layout is the unrotated svg (long + thin); the painted AABB is tall + narrow
    expect((item.layout.x1 - item.layout.x0)).toBeGreaterThan((item.layout.y1 - item.layout.y0));
    expect((item.rendered.x1 - item.rendered.x0)).toBeLessThan((item.rendered.y1 - item.rendered.y0));
    expect(item.transform.scale).toBe(1);
  });

  it("is deterministic and independent of call order", () => {
    const style = headlineStyle();
    withMetrics([[metricKey("DETERMINISM", style), 640], [metricKey("DETERMINISM", { ...style, sizePx: 34 }), 300]]);
    const s = scene({
      composition: "leftTextRightObject",
      headline: { text: "DETERMINISM", accentWords: [], align: "left" },
      elements: [
        { primitive: "Label", text: "DETERMINISM", position: "right", role: "semantic", purpose: "label" },
        { primitive: "Circle", position: "bottom", scale: 1.4, role: "semantic", purpose: "ring" },
      ],
    });
    const a = sceneRenderedGeometry(s);
    const b = sceneRenderedGeometry(s);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.items).toHaveLength(3);
    expect(frameRect()).toEqual({ x0: 0, y0: 0, x1: 1080, y1: 1920 });
  });

  it("records whether text came from real measurement or an estimate", () => {
    const s = scene({ elements: [{ primitive: "Label", text: "UNMEASURED", position: "center", role: "semantic", purpose: "l" }] });
    resetTextMetricsCache();
    const cold = sceneRenderedGeometry(s);
    expect(cold.items[0].source).toBe("estimate");
    const style = { family: "Inter", sizePx: 34, weight: 700, letterSpacingEm: 0.12, lineHeight: 1.2, uppercase: true };
    setTextMetrics({ [metricKey("UNMEASURED", style)]: 300 });
    const warm = sceneRenderedGeometry(s);
    expect(warm.items[0].source).toBe("cache");
    expect((warm.items[0].layout.x1 - warm.items[0].layout.x0)).toBeCloseTo(300, 0);
  });
});

describe("text measurement API", () => {
  it("falls back to a labelled estimate when nothing is cached", () => {
    resetTextMetricsCache();
    const style = headlineStyle();
    const unique = "ESTIMATE_ONLY_7f3a9c";
    const m = measureTextWidth(unique, style);
    expect(m.source).toBe("estimate");
    expect(m.width).toBeGreaterThan(0);
  });

  it("uses cached measurements when present", () => {
    resetTextMetricsCache();
    const style = headlineStyle();
    setTextMetrics({ [metricKey("CACHED_ONLY_7f3a9c", style)]: 424 });
    expect(measureTextWidth("CACHED_ONLY_7f3a9c", style)).toEqual({ width: 424, source: "cache" });
  });
});
