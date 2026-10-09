import { analyzeJavaScriptApplication } from "../application/javascript/JavaScriptApplicationService.js";
import { createProgressReporter } from "../application/ProgressReporter.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Execute the shared one-shot CLI boundary for static JavaScript analysis. */
export const runCliJavaScriptApplicationAnalysis = async (
  input: unknown,
  signal?: AbortSignal,
): Promise<JsonValue> => {
  const progress = createProgressReporter(
    async (update) => {
      process.stderr.write(`${JSON.stringify({ rea_progress: update })}\n`);
    },
    { minimumIntervalMs: 0 },
  );
  const result = await analyzeJavaScriptApplication(input, {
    progress,
    ...(signal === undefined ? {} : { signal }),
  });
  return result.ok ? result.value : cliError(result.error);
};

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "JavaScript application analysis failed",
  ...projectAnalysisError(error),
});
