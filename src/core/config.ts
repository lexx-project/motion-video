import path from "path";

/**
 * Node-only paths. NEVER import this module from render-bundle code -
 * browser-safe constants live in ./output.ts.
 */
export { OUTPUT, QA_THRESHOLDS, PIPELINE } from "./output";

export const PATHS = {
  root: process.cwd(),
  designSystem: path.join(process.cwd(), "design-system"),
  projects: path.join(process.cwd(), "projects"),
  public: path.join(process.cwd(), "public"),
  memory: path.join(process.cwd(), "projects", "_memory"),
  reference: path.join(process.cwd(), "reference"),
} as const;
