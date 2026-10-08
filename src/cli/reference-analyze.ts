import path from "path";
import fs from "fs";
import { runReferenceAnalysis } from "../reference/analyze";

async function main(): Promise<void> {
  const dir = path.resolve(process.argv[2] ?? "reference/analysis");
  if (!fs.existsSync(path.join(dir, "frames-index.json"))) {
    console.error("Run `npm run reference:extract` first.");
    process.exit(1);
  }
  const findings = await runReferenceAnalysis(dir);
  const brief = {
    identity: { character: findings.identity.visualCharacter, density: findings.identity.visualDensity, confidence: findings.identity.confidence },
    typography: { font: findings.typography.fontCategory, casing: findings.typography.casing, confidence: findings.typography.confidence },
    colors: {
      background: findings.colors.background,
      textPrimary: findings.colors.textPrimary,
      accents: findings.colors.accents.map((a) => `${a.role}:${a.value}(${a.confidence})`),
      confidence: findings.colors.confidence,
    },
    composition: findings.composition.recurringGrammars,
    motion: { density: findings.motion.motionDensity, entrance: findings.motion.entrance.slice(0, 120), confidence: findings.motion.confidence },
  };
  console.log(JSON.stringify(brief, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
