import fs from "fs";
import path from "path";
import { openBrowser, ensureBrowser } from "@remotion/renderer";
import { typography } from "../core/designSystem";

/**
 * Real font measurement for layout geometry (Batch B / B2).
 *
 * The renderer lays text out with the actual bundled webfonts (Archivo / Inter), so a
 * character-count heuristic is not good enough to predict whether scaled text crosses the
 * frame edge. This module measures the SAME text with the SAME fonts in the headless Chrome
 * that Remotion already uses, and caches the results so measurement stays deterministic and
 * cheap.
 *
 * Design notes:
 * - measurement is a batch, async step (`ensureTextWidths`) that fills a cache;
 * - geometry code reads the cache synchronously (`measureTextWidth`), falling back to a
 *   calibrated estimate that is explicitly labelled `source: "estimate"` - never silently
 *   presented as measured;
 * - cache lives in `out/` (git-ignored) keyed by family/weight/size/letter-spacing/text, so
 *   repeated runs are byte-stable without re-opening a browser.
 *
 * Node-only (fs / headless browser). Never import from render-bundle code.
 */

export type MeasurementSource = "cache" | "estimate";

export interface TextStyle {
  /** font family name as registered with @font-face ("Archivo" | "Inter") */
  family: string;
  sizePx: number;
  weight: number;
  letterSpacingEm: number;
  lineHeight: number;
  /** CSS text-transform: uppercase is applied before measuring, exactly like the renderer */
  uppercase?: boolean;
}

export interface MeasuredWidth {
  width: number;
  source: MeasurementSource;
}

const CACHE_FILE = path.join(process.cwd(), "out", "text-metrics.json");

const cache = new Map<string, number>();
let cacheLoaded = false;
let diskCacheEnabled = true;

/**
 * Tests must not depend on whether a developer happens to have a populated cache in `out/`
 * (a git-ignored file). Disabling the disk layer makes unit tests deterministic: they either
 * use injected values or the labelled estimate.
 */
export function disableDiskMetricsCache(): void {
  diskCacheEnabled = false;
  cache.clear();
  cacheLoaded = true;
}

/** Re-enable reading the persisted cache (production path). */
export function enableDiskMetricsCache(): void {
  diskCacheEnabled = true;
  cacheLoaded = false;
}

/** Uppercase + whitespace normalisation - mirrors what the browser renders. */
const normalize = (text: string, style: TextStyle): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return style.uppercase ? t.toUpperCase() : t;
};

export const metricKey = (text: string, style: TextStyle): string =>
  [
    style.family,
    style.weight,
    style.sizePx,
    Number(style.letterSpacingEm.toFixed(4)),
    normalize(text, style),
  ].join("|");

/** Deterministic estimate used only when a measurement is missing (labelled, never hidden). */
export function estimateWidth(text: string, style: TextStyle): number {
  const t = normalize(text, style);
  if (!t) return 0;
  // calibrated for the bundled grotesque (see docs/AUTONOMOUS_AUDIT.md layout.ts charW 0.70)
  const advance = t.length * style.sizePx * 0.7;
  const tracking = t.length * style.sizePx * style.letterSpacingEm;
  return Math.max(0, advance + tracking);
}

export function loadTextMetricsCache(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  if (!diskCacheEnabled) return;
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Record<string, number>;
    for (const [k, v] of Object.entries(raw)) if (typeof v === "number") cache.set(k, v);
  } catch {
    // a corrupt cache must never break layout - it just re-measures
  }
}

export function saveTextMetricsCache(): void {
  if (cache.size === 0) return;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const sorted: Record<string, number> = {};
    for (const k of [...cache.keys()].sort()) sorted[k] = cache.get(k)!;
    fs.writeFileSync(CACHE_FILE, JSON.stringify(sorted), "utf8");
  } catch {
    // cache write failures are non-fatal
  }
}

/** Synchronous measurement: cache hit -> real measurement, otherwise labelled estimate. */
export function measureTextWidth(text: string, style: TextStyle): MeasuredWidth {
  loadTextMetricsCache();
  const key = metricKey(text, style);
  const hit = cache.get(key);
  if (hit !== undefined) return { width: hit, source: "cache" };
  return { width: estimateWidth(text, style), source: "estimate" };
}

/** Test/deterministic injection: preload measured values without a browser. */
export function setTextMetrics(entries: Record<string, number>): void {
  for (const [k, v] of Object.entries(entries)) cache.set(k, v);
  cacheLoaded = true;
}

export function resetTextMetricsCache(): void {
  cache.clear();
  cacheLoaded = false;
}

export function textMetricsStats(): { cached: number } {
  loadTextMetricsCache();
  return { cached: cache.size };
}

/* ----------------------------- browser measurement ---------------------------- */

interface WeightedFace {
  weight: number;
  file: string;
}

/** Available @font-face weights declared by the design system, parsed from file names. */
function availableWeights(family: string): WeightedFace[] {
  // families are keyed "display"/"body" but referenced by their real name ("Archivo"/"Inter")
  const fam =
    Object.values(typography.families).find((f) => f.name === family) ?? typography.families[family];
  if (!fam) return [];
  const out: WeightedFace[] = [];
  for (const src of fam.src) {
    const m = /-(\d{3})-/.exec(src);
    if (m) out.push({ weight: parseInt(m[1], 10), file: src });
  }
  return out.sort((a, b) => a.weight - b.weight);
}

/** CSS font matching for weights > 500: exact, else next higher, else nearest below. */
function matchWeight(requested: number, faces: WeightedFace[]): WeightedFace | null {
  if (faces.length === 0) return null;
  const exact = faces.find((f) => f.weight === requested);
  if (exact) return exact;
  if (requested > 500) {
    const higher = faces.find((f) => f.weight > requested);
    if (higher) return higher;
    return faces[faces.length - 1];
  }
  const lower = [...faces].reverse().find((f) => f.weight < requested);
  if (lower) return lower;
  return faces[0];
}

export interface WidthRequest {
  text: string;
  style: TextStyle;
}

export interface MeasurementReport {
  measured: number;
  fromCache: number;
  failed: number;
  browserUsed: boolean;
  /** populated only when the browser pass could not run (kept for diagnostics) */
  error?: string;
}

const uniquePending = (reqs: WidthRequest[]): Map<string, { text: string; style: TextStyle }> => {
  const out = new Map<string, { text: string; style: TextStyle }>();
  for (const r of reqs) {
    const key = metricKey(r.text, r.style);
    if (!cache.has(key) && !out.has(key)) out.set(key, { text: r.text, style: r.style });
  }
  return out;
};

/**
 * Measure every requested string that is not cached, in ONE headless-Chrome batch.
 * Words are measured too so the geometry can reproduce greedy line wrapping synchronously.
 */
export async function ensureTextWidths(reqs: WidthRequest[]): Promise<MeasurementReport> {
  loadTextMetricsCache();
  const report: MeasurementReport = { measured: 0, fromCache: 0, failed: 0, browserUsed: false };
  report.fromCache = reqs.filter((r) => cache.has(metricKey(r.text, r.style))).length;

  const pending = uniquePending(reqs);
  if (pending.size === 0) return report;

  const faces: { family: string; weight: number; dataUrl: string }[] = [];
  for (const family of [...new Set([...pending.values()].map((v) => v.style.family))]) {
    for (const f of availableWeights(family)) {
      const file = path.join(process.cwd(), "public", f.file);
      if (fs.existsSync(file)) {
        faces.push({ family, weight: f.weight, dataUrl: `data:font/woff2;base64,${fs.readFileSync(file).toString("base64")}` });
      }
    }
  }
  if (faces.length === 0) {
    report.failed = pending.size;
    return report;
  }

  const items = [...pending.entries()].map(([key, v]) => ({ key, text: v.text, style: v.style }));
  let browser: Awaited<ReturnType<typeof openBrowser>> | null = null;
  try {
    await ensureBrowser();
    browser = await openBrowser("chrome", { logLevel: "error" });
    const page = await browser.newPage({
      context: () => null,
      logLevel: "error",
      indent: false,
      pageIndex: 0,
      onBrowserLog: null,
      onLog: () => {},
    });
    const widths = await page.evaluate(
      async (arg: { faces: { family: string; weight: number; dataUrl: string }[]; items: { key: string; text: string; style: TextStyle }[] }) => {
        for (const f of arg.faces) {
          try {
            const face = new FontFace(f.family, `url(${f.dataUrl})`, { weight: String(f.weight) });
            await face.load();
            (document as unknown as { fonts: FontFaceSet }).fonts.add(face);
          } catch {
            /* missing face -> canvas falls back */
          }
        }
        await (document as unknown as { fonts: FontFaceSet }).fonts.ready;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return [] as { key: string; width: number }[];
        const out: { key: string; width: number }[] = [];
        for (const item of arg.items) {
          const st = item.style;
          const text = (st.uppercase ? item.text.toUpperCase() : item.text).replace(/\s+/g, " ").trim();
          const anyCtx = ctx as unknown as { letterSpacing?: string };
          let hasLetterSpacing = true;
          try {
            anyCtx.letterSpacing = `${st.letterSpacingEm}em`;
          } catch {
            hasLetterSpacing = false;
          }
          ctx.font = `${st.weight} ${st.sizePx}px ${st.family}`;
          const measured = ctx.measureText(text).width;
          const manual = hasLetterSpacing ? 0 : text.length * st.sizePx * st.letterSpacingEm;
          out.push({ key: item.key, width: Math.round((measured + manual) * 100) / 100 });
        }
        return out;
      },
      // the payload is plain JSON; the cast satisfies puppeteer's Serializable signature
      { faces, items } as unknown as never,
    );
    report.browserUsed = true;
    for (const w of widths) {
      if (typeof w?.width === "number" && Number.isFinite(w.width) && w.width >= 0) {
        cache.set(w.key, w.width);
        report.measured += 1;
      } else {
        report.failed += 1;
      }
    }
    if (report.measured > 0) saveTextMetricsCache();
  } catch (e) {
    report.failed = pending.size;
    report.error = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
  } finally {
    if (browser) {
      try {
        await browser.close({ silent: true });
      } catch {
        /* ignore */
      }
    }
  }
  return report;
}
