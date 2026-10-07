import { analyzeJavaScriptApplication } from "../application/javascript/JavaScriptApplicationService.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Execute the shared one-shot CLI boundary for static JavaScript analysis. */
export const runCliJavaScriptApplicationAnalysis = async (
  input: unknown,
): Promise<JsonValue> => {
  const result = await analyzeJavaScriptApplication(input);
  return result.ok ? result.value : cliError(result.error);
};

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "JavaScript application analysis failed",
  ...projectAnalysisError(error),
});
