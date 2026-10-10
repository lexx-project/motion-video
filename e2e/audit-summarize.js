const p = require("./audit-probe.json");
for (const [k, v] of Object.entries(p)) {
  console.log("== " + k.split("/").pop());
  if (v.error) { console.log("  ERROR " + v.error); continue; }
  console.log("  regions " + JSON.stringify(v.regions));
  console.log("  comps=" + v.componentCount + " top: " + v.components.slice(0, 8).map((c) => "area" + c.n + "@" + c.x0 + "-" + c.x1 + "x" + c.y0 + "-" + c.y1).join(" | "));
  console.log("  rows " + v.rowBands.join(","));
  console.log("  cols " + v.colBands.join(","));
}
