import fs from "fs";
const qa = JSON.parse(fs.readFileSync("projects/proj_ref_demo/qa/qa-summary.json", "utf8")) as {
  status: string; overallQuality: number; confidence: number; variance: number;
  reasons: string[];
  conformance?: { overall: number };
  visual: { evaluatorCount: number; scenes: { sceneId: string; scores: Record<string, number>; stats: { median: number; variance: number; confidence: number }; technicalCorrectness: string; issues: string[] }[] };
  slop: { projectSeverity: number; verdict: string };
};
console.log(`status=${qa.status} overall=${qa.overallQuality.toFixed(2)} confidence=${qa.confidence} variance=${qa.variance}`);
console.log(`conformance=${qa.conformance?.overall} slop=${qa.slop.projectSeverity}(${qa.slop.verdict}) evaluators=${qa.visual.evaluatorCount}`);
console.log("per-scene (median across 3 evaluators):");
for (const s of qa.visual.scenes) {
  const q = ["scriptRelevance","visualClarity","designConsistency","typography","composition","motionQuality","novelty"].reduce((a, k) => a + (s.scores[k] ?? 0), 0) / 7;
  console.log(`  ${s.sceneId}: q=${q.toFixed(2)} rel=${s.scores.scriptRelevance} clar=${s.scores.visualClarity} typo=${s.scores.typography} comp=${s.scores.composition} slop=${s.scores.aiSlopSeverity} | med=${s.stats.median} var=${s.stats.variance} conf=${s.stats.confidence} tech=${s.technicalCorrectness} issues=${s.issues.length}`);
}
console.log("reasons:");
for (const r of qa.reasons) console.log("  - " + r);
