import { analyzeJavaScriptApplication } from "../application/JavaScriptApplicationService.js";
import { loadConfiguredPermissionAuthority } from "../application/PermissionConfiguration.js";
import { parseConfig } from "../config.js";
import { projectAnalysisError } from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Execute the shared one-shot CLI boundary for static JavaScript analysis. */
export const runCliJavaScriptApplicationAnalysis = async (
  input: unknown,
): Promise<JsonValue> => {
  const config = parseConfig(process.env);
  if (!config.ok) return cliError(config.error);
  const authority = await loadConfiguredPermissionAuthority(config.value);
  if (!authority.ok) return cliError(authority.error);
  const result = await analyzeJavaScriptApplication(authority.value, input);
  return result.ok ? result.value : cliError(result.error);
};

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "JavaScript application analysis failed",
  ...projectAnalysisError(error),
});
