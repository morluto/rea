import { analyzeJavaScriptApplication } from "../application/javascript/JavaScriptApplicationService.js";
import { createProgressReporter } from "../application/ProgressReporter.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { CliCommandOutput } from "./streamedJsonOutput.js";

/** Execute the shared one-shot CLI boundary for static JavaScript analysis. */
export const runCliJavaScriptApplicationAnalysis = async (
  input: unknown,
  output?: CliCommandOutput,
): Promise<JsonValue | undefined> => {
  const started = performance.now();
  const progress = createProgressReporter(
    async (update) => {
      process.stderr.write(`${JSON.stringify({ rea_progress: update })}\n`);
    },
    { minimumIntervalMs: 0 },
  );
  const result = await analyzeJavaScriptApplication(input, { progress });
  const value = result.ok ? result.value : cliError(result.error);
  if (
    output !== undefined &&
    (await output.output.write(value, {
      command: output.command,
      format: output.format,
      duration: `${Math.round(performance.now() - started)}ms`,
    }))
  )
    return undefined;
  return value;
};

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "JavaScript application analysis failed",
  ...projectAnalysisError(error),
});
