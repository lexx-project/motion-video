/** Batch B probe: renderer-aware geometry vs rendered frame evidence for the real scenes. */
import fs from "fs";
import { sceneRenderedGeometry } from "../src/scenes/rendererGeometry";
import { ensureTextWidths, type TextStyle } from "../src/render/measureText";
import { listSceneFilesAt, projectDir } from "../src/core/projectStore";
import { typography } from "../src/core/designSystem";
import type { SceneSpec, SceneElement } from "../src/validation/schema";

const TEXT_TIERS: Record<string, { tier: string; family: string; upper: boolean }> = {
  Headline: { tier: "headline", family: "Archivo", upper: true },
  WordReveal: { tier: "headline", family: "Archivo", upper: true },
  CharacterReveal: { tier: "headline", family: "Archivo", upper: true },
  HighlightWord: { tier: "headline", family: "Inter", upper: true },
  CounterText: { tier: "counter", family: "Archivo", upper: false },
  Quote: { tier: "quote", family: "Archivo", upper: false },
  Subheadline: { tier: "subheadline", family: "Inter", upper: false },
  Label: { tier: "label", family: "Inter", upper: true },
  Caption: { tier: "caption", family: "Inter", upper: false },
};

function requestsFor(scene: SceneSpec): { text: string; style: TextStyle }[] {
  const out: { text: string; style: TextStyle }[] = [];
  const push = (text: string, def: { tier: string; family: string; upper: boolean }): void => {
    const t = typography.scale[def.tier];
    const style: TextStyle = {
      family: def.family,
      sizePx: t.default,
      weight: t.weight,
      letterSpacingEm: t.letterSpacingEm,
      lineHeight: t.lineHeight,
      uppercase: def.upper,
    };
    out.push({ text, style });
    for (const w of text.split(/\s+/).filter(Boolean)) out.push({ text: w, style });
  };
  if (scene.headline) push(scene.headline.text, TEXT_TIERS.Headline);
  for (const el of scene.elements as SceneElement[]) {
    const def = TEXT_TIERS[el.primitive];
    if (!def) continue;
    const text = typeof el.text === "string" ? el.text : "";
    if (!text.trim()) continue;
    push(text, def);
  }
  return out;
}

async function main(): Promise<void> {
  const dir = projectDir("_batcha_e2e");
  const scenes = listSceneFilesAt(dir).map((s) => s.data as SceneSpec);
  const requests = scenes.flatMap(requestsFor);
  const report = await ensureTextWidths(requests);
  console.log(`measure: ${JSON.stringify(report)}`);

  for (const scene of scenes) {
    const geo = sceneRenderedGeometry(scene);
    console.log(`\n=== ${scene.sceneId} sources=${geo.sources.join(",")}`);
    for (const g of geo.groups) {
      console.log(`  group ${g.pos}: w=${g.width.toFixed(1)} available=${g.available.toFixed(1)} cap=${g.maxWidthCap.toFixed(1)} rect=${Math.round(g.rect.x0)},${Math.round(g.rect.y0)}..${Math.round(g.rect.x1)},${Math.round(g.rect.y1)}`);
    }
    for (const it of geo.items) {
      const over = { l: Math.round(-it.rendered.x0), r: Math.round(it.rendered.x1 - 1080), t: Math.round(-it.rendered.y0), b: Math.round(it.rendered.y1 - 1920) };
      const bad = over.l > 0 || over.r > 0 || over.t > 0 || over.b > 0;
      console.log(
        `  ${bad ? "CLIP" : "    "} ${it.id.slice(0, 44).padEnd(44)} s=${it.transform.scale} rendered=${Math.round(it.rendered.x0)}..${Math.round(it.rendered.x1)} y=${Math.round(it.rendered.y0)}..${Math.round(it.rendered.y1)} over=${JSON.stringify(over)} src=${it.source}`,
      );
    }
    const evPath = `${dir}/qa/frame-evidence.json`;
    if (fs.existsSync(evPath)) {
      const ev = JSON.parse(fs.readFileSync(evPath, "utf8"));
      const s = ev.sceneRollup.find((r: { sceneId: string }) => r.sceneId === scene.sceneId);
      if (s) console.log(`  RENDERED: edgeInkMax=${s.maxEdgeInk} outsideFrame=${s.contentOutsideFrame} safeOvf=${s.maxSafeAreaOverflowPx}`);
    }
  }
}

void main();
