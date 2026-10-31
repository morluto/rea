import type { ProgressReporter } from "../application/ProgressReporter.js";

/** Keep request progress on stderr while stdout carries one command result. */
export const cliProgress: ProgressReporter = {
  report: async (update) => {
    process.stderr.write(`${JSON.stringify({ rea_progress: update })}\n`);
  },
};
