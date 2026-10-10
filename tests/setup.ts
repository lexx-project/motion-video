import { disableDiskMetricsCache } from "../src/render/measureText";

/**
 * Batch B test determinism: geometry/measurements must not depend on the git-ignored
 * `out/text-metrics.json` cache that may or may not exist on a given machine.
 * Individual tests can still inject exact values with `setTextMetrics`.
 */
disableDiskMetricsCache();
