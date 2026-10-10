import fs from "fs";
for (let i = 1; i <= 6; i++) {
  const id = "scene_0" + i;
  const scene = JSON.parse(fs.readFileSync(`projects/proj_p3_demo/scenes/${id}.json`, "utf8"));
  const sb = scene.storyboard;
  if (!sb) { console.log(id, "NO STORYBOARD"); continue; }
  const elNames = scene.elements.map((e: any) => `${e.primitive}${e.text ? ":" + String(e.text).slice(0, 12) : ""}${e.purpose ? " (" + String(e.purpose).slice(0, 40) + ")" : ""}`);
  console.log("=== " + id + "  semanticObjects=" + sb.semanticObjects.length + " elements=" + scene.elements.length + " relationships=" + sb.relationships.length);
  for (const o of sb.semanticObjects) console.log("   SB-obj: " + o.objectType + " | " + o.semanticRole.slice(0, 90));
  for (const e of elNames) console.log("   EL: " + e);
  console.log("   motionBeats=" + sb.motionBeats.length + " narrativeSteps=" + sb.visualNarrative.length + " atSeconds=" + JSON.stringify(sb.motionBeats.map((m: any) => m.atSeconds)));
}
