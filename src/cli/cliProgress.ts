import type { ProgressReporter } from "../application/ProgressReporter.js";

/** Write one progress update as a stderr line, keeping stdout results parseable. */
export const writeCliProgressLine = (update: unknown): void => {
  process.stderr.write(`${JSON.stringify({ rea_progress: update })}\n`);
};

/** CLI counterpart of MCP progress notifications: each update is one stderr line. */
export const cliProgressReporter: ProgressReporter = {
  report: async (update) => {
    writeCliProgressLine(update);
  },
};
