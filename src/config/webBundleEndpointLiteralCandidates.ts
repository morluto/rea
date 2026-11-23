import {
  DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
} from "../domain/analysisResourceLimits.js";
import { currentAnalysisSettingOverride } from "../domain/analysisOperationSnapshot.js";
import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_ADMISSION,
  WEB_BUNDLE_ENDPOINT_LITERAL_SETTING,
  type WebBundleEndpointLiteralAdmission,
} from "../domain/webBundleEndpointLiteralBudget.js";
import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

export const WEB_BUNDLE_ENDPOINT_LITERAL_CONSTRAINT = `${WEB_BUNDLE_ENDPOINT_LITERAL_SETTING} must be a positive decimal integer from ${String(MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES)} to ${String(MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES)}; the default is ${String(DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES)}.`;

/** Optional per-script ceiling for literal path and URL endpoint candidates. */
export const webBundleEndpointLiteralCandidatesSchema =
  positiveDecimalIntegerSchema(
    MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    WEB_BUNDLE_ENDPOINT_LITERAL_CONSTRAINT,
  );

/** Resolve the ceiling from one launch-environment value. Unset keeps the default. */
export const parseWebBundleEndpointLiteralAdmission = (
  value: string | undefined,
): Result<WebBundleEndpointLiteralAdmission, ConfigurationError> => {
  if (value === undefined)
    return ok(DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_ADMISSION);
  const parsed = webBundleEndpointLiteralCandidatesSchema.safeParse(value);
  return parsed.success
    ? ok({ maximumCount: parsed.data, source: "setting" })
    : err(
        new ConfigurationError(WEB_BUNDLE_ENDPOINT_LITERAL_CONSTRAINT, {
          settings: [
            {
              setting: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING,
              constraint: WEB_BUNDLE_ENDPOINT_LITERAL_CONSTRAINT,
            },
          ],
        }),
      );
};

/**
 * Resolve the per-script ceiling for one analysis. An accepted runtime override
 * replaces the launch seed. The seed is parsed here, before capture starts, so
 * a rejected value reaches the caller as a configuration error instead of a
 * per-script worker failure that a partial result reports as success.
 */
export const runtimeWebBundleEndpointLiteralAdmission = (
  environment: Readonly<Record<string, string | undefined>>,
  read?: AnalysisSettingsReader,
): Result<WebBundleEndpointLiteralAdmission, ConfigurationError> => {
  const override =
    read?.().overrides["web.bundle_endpoint_literal_candidates"] ??
    currentAnalysisSettingOverride("web.bundle_endpoint_literal_candidates");
  if (override !== undefined)
    return ok({ maximumCount: override, source: "runtime" });
  return parseWebBundleEndpointLiteralAdmission(
    environment[WEB_BUNDLE_ENDPOINT_LITERAL_SETTING],
  );
};
