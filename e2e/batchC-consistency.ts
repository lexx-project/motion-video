import { verifyConsistency, summarizeConsistency, readRenderRecord, readQaRecord, readFinalRecord } from "../src/core/artifacts";
import { projectDir } from "../src/core/projectStore";
import { sha256File } from "../src/core/identity";

const projects = ["_batcha_e2e", "_batchc_e2e", "_batchc_e2e_rb"];
for (const p of projects) {
  const dir = projectDir(p);
  if (!require("fs").existsSync(dir)) {
    console.log(`${p}: MISSING`);
    continue;
  }
  // a model-only fixture (no render) is not expected to have render/QA/final records
  const hasRender = require("fs").existsSync(`${dir}/renders/record.json`);
  const r = verifyConsistency(dir, { requireQa: hasRender, requireFinal: hasRender });
  const render = readRenderRecord(dir);
  const qa = readQaRecord(dir);
  const fin = readFinalRecord(dir);
  const preview = `${dir}/renders/preview.mp4`;
  const final = `${dir}/renders/final.mp4`;
  console.log(
    `${p}: consistent=${r.ok} [${summarizeConsistency(r)}]` +
      ` render=${render ? render.sha256.slice(0, 12) : "none"}` +
      ` qa->render=${qa ? qa.renderSha256.slice(0, 12) : "none"}` +
      ` final=${fin ? fin.sha256.slice(0, 12) : "none"}` +
      ` previewSha=${require("fs").existsSync(preview) ? sha256File(preview)!.slice(0, 12) : "-"}` +
      ` finalSha=${require("fs").existsSync(final) ? sha256File(final)!.slice(0, 12) : "-"}`,
  );
  if (!r.ok) for (const i of r.issues.filter((x) => x.severity === "error")) console.log(`    ERROR ${i.code}: ${i.detail}`);
}
