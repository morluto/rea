import type { ProgressReporter } from "../application/ProgressReporter.js";

/** Report one lifecycle operation start through the shared monotonic boundary. */
export const reportLifecycleStart = (
  progress: ProgressReporter,
  phase: string,
  message = "started",
): Promise<void> => progress.report({ phase, completed: 0, total: 1, message });

/** Report one lifecycle operation's terminal disposition. */
export const reportLifecycleEnd = (
  progress: ProgressReporter,
  phase: string,
  succeeded: boolean,
): Promise<void> =>
  progress.report({
    phase,
    completed: 1,
    total: 1,
    message: succeeded ? "completed" : "failed",
    terminal: true,
  });
