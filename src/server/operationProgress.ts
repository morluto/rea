import type { CallToolResult } from "@modelcontextprotocol/server";
import type {
  ProgressReporter,
  ProgressUpdate,
} from "../ports/ProgressReporter.js";

/** Report one operation start through the shared monotonic boundary. */
export const reportOperationStart = (
  progress: ProgressReporter,
  phase: string,
  message = "started",
): Promise<void> => progress.report({ phase, completed: 0, total: 1, message });

/** Report one operation's terminal disposition. */
export const reportOperationEnd = (
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

/** Finish only after delivery, preserving a declared workflow's own final facts. */
export const createOperationProgress = (
  progress: ProgressReporter,
  phase: string,
  completionProgress?: "workflow",
) => {
  let terminal: ProgressUpdate | undefined;
  return {
    report(update: ProgressUpdate): Promise<void> {
      terminal = update.terminal === true ? update : undefined;
      return progress.report(update);
    },
    start: () => reportOperationStart(progress, phase),
    async complete(response: CallToolResult): Promise<CallToolResult> {
      const final = completionProgress === "workflow" ? terminal : undefined;
      if (final === undefined)
        await reportOperationEnd(progress, phase, response.isError !== true);
      else if (response.isError === true)
        await progress.report({
          ...final,
          phase,
          message: `failed; ${final.phase}: ${final.message}`,
        });
      return response;
    },
  };
};
