import { describe, it, expect, afterEach } from "vitest";
import {
  ensureTextWidths,
  measureTextWidth,
  estimateWidth,
  metricKey,
  resetTextMetricsCache,
  type TextStyle,
} from "../src/render/measureText";

/**
 * Batch B / B2 text measurement: real font metrics in the same headless Chrome the renderer
 * uses, cached so geometry stays deterministic and synchronous.
 */

const archivo96: TextStyle = {
  family: "Archivo",
  sizePx: 96,
  weight: 900,
  letterSpacingEm: -0.02,
  lineHeight: 1.08,
  uppercase: true,
};

const inter34: TextStyle = {
  family: "Inter",
  sizePx: 34,
  weight: 700,
  letterSpacingEm: 0.12,
  lineHeight: 1.2,
  uppercase: true,
};

afterEach(() => resetTextMetricsCache());

describe("text measurement", () => {
  it("estimates deterministically and grows with the string", () => {
    const a = estimateWidth("AB", archivo96);
    const b = estimateWidth("ABCD", archivo96);
    expect(b).toBeGreaterThan(a);
    expect(estimateWidth("AB", archivo96)).toBe(a);
  });

  it("normalises uppercase in cache keys (CSS text-transform)", () => {
    expect(metricKey("yes", archivo96)).toBe(metricKey("YES", archivo96));
    expect(metricKey("yes", archivo96)).not.toBe(metricKey("YES", inter34));
  });

  it("measures real font widths in the headless browser and caches them", async () => {
    const report = await ensureTextWidths([
      { text: "MEASUREME", style: archivo96 },
      { text: "YES", style: archivo96 },
      { text: "AUDIENCE", style: inter34 },
    ]);
    expect(report.browserUsed).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.measured).toBeGreaterThanOrEqual(3);

    const measured = measureTextWidth("MEASUREME", archivo96);
    expect(measured.source).toBe("cache");
    expect(measured.width).toBeGreaterThan(0);

    // a longer word is wider than a shorter one at the same size
    expect(measureTextWidth("MEASUREME", archivo96).width).toBeGreaterThan(measureTextWidth("YES", archivo96).width);
    // body font differs from display font at the same size
    expect(measureTextWidth("AUDIENCE", inter34).width).toBeGreaterThan(0);
  }, 120000);

  it("reuses the cache: a second ensure pass measures nothing new", async () => {
    await ensureTextWidths([{ text: "CACHEDPASS", style: archivo96 }]);
    const before = measureTextWidth("CACHEDPASS", archivo96);
    const again = await ensureTextWidths([{ text: "CACHEDPASS", style: archivo96 }]);
    expect(again.measured).toBe(0);
    expect(again.fromCache).toBeGreaterThan(0);
    expect(measureTextWidth("CACHEDPASS", archivo96)).toEqual(before);
  }, 120000);

  it("falls back to a labelled estimate for strings that were never measured", () => {
    resetTextMetricsCache();
    const m = measureTextWidth("NEVER_MEASURED_9f2", archivo96);
    expect(m.source).toBe("estimate");
    expect(m.width).toBeGreaterThan(0);
  });
});
