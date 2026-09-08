import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import { CdpBrowserProvider } from "./browser/CdpBrowserProvider.js";
import { parseConfig } from "./config.js";
import {
  AnalysisCapabilityUnavailableError,
  projectAnalysisError,
} from "./domain/errors.js";
import type { JsonValue } from "./domain/jsonValue.js";

/** Load the configured passive browser authority and provider for one CLI operation. */
export const browserContext = async (operation: string) => {
  const config = parseConfig(process.env);
  if (!config.ok)
    return { ok: false as const, error: browserCliError(config.error) };
  const policy = config.value.browserObservationPolicy;
  if (policy.status === "disabled")
    return {
      ok: false as const,
      error: browserCliError(
        new AnalysisCapabilityUnavailableError(
          "rea-cdp-browser",
          operation,
          "browser observation is disabled; configure exact endpoints and origins before enabling it",
        ),
      ),
    };
  const authority = await loadConfiguredPermissionAuthority(config.value);
  if (!authority.ok)
    return { ok: false as const, error: browserCliError(authority.error) };
  return {
    ok: true as const,
    authority: authority.value,
    provider: new CdpBrowserProvider(),
    allowedBrowserOrigins: policy.allowedOrigins,
  };
};

/** Project a browser operation failure consistently across CLI command groups. */
export const browserCliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "Browser observation failed",
  ...projectAnalysisError(error),
});
