import { CdpBrowserProvider } from "./browser/CdpBrowserProvider.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";
import type { JsonValue } from "./domain/jsonValue.js";

/** Build the passive browser provider; scope is supplied on each request. */
export const browserContext = () => ({ provider: new CdpBrowserProvider() });

/** Project a browser operation failure consistently across CLI command groups. */
export const browserCliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "Browser observation failed",
  ...projectAnalysisError(error),
});
