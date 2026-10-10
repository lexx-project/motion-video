import { sceneLayoutBoxes, textCollisions, subtitleCollisions } from "../src/reference/conformance";
import fs from "fs";
for (let i = 1; i <= 6; i++) {
  const id = "scene_0" + i;
  const scene = JSON.parse(fs.readFileSync(`projects/proj_p3_demo/scenes/${id}.json`, "utf8"));
  console.log("=== " + id + " headlinePos=" + (scene.headline?.position ?? "(derived:" + scene.composition + ")"));
  for (const b of sceneLayoutBoxes(scene)) {
    console.log(`   ${b.isText ? "T" : " "} ${b.id.padEnd(38)} pos=${b.pos.padEnd(11)} x=${b.box.x0.toFixed(0)}..${b.box.x1.toFixed(0)} y=${b.box.y0.toFixed(0)}..${b.box.y1.toFixed(0)}`);
  }
  console.log("   collisions:", JSON.stringify(textCollisions(scene)), "subtitle:", JSON.stringify(subtitleCollisions(scene)));
}
