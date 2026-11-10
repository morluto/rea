import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_ADMISSION,
  DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  WEB_BUNDLE_ENDPOINT_LITERAL_SETTING,
  type WebBundleEndpointLiteralAdmission,
} from "../domain/webBundleEndpointLiteralBudget.js";

const decimalInteger = /^[1-9]\d*$/u;

/** Constraint for a rejected launch value. It names the range, not the rejected token. */
export const WEB_BUNDLE_ENDPOINT_LITERAL_CONSTRAINT = `${WEB_BUNDLE_ENDPOINT_LITERAL_SETTING} must be a positive decimal integer from ${String(MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES)} to ${String(MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES)}; the default is ${String(DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES)}. Set ${WEB_BUNDLE_ENDPOINT_LITERAL_SETTING} in the environment that starts REA, then restart REA. There is no runtime override.`;

const inRange = (value: string): boolean => {
  if (!decimalInteger.test(value)) return false;
  const parsed = BigInt(value);
  return (
    parsed >= BigInt(MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES) &&
    parsed <= BigInt(MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES)
  );
};

/** Optional per-script ceiling for literal path and URL endpoint candidates. */
export const webBundleEndpointLiteralCandidatesSchema = z
  .string()
  .superRefine((value, context) => {
    if (inRange(value)) return;
    context.addIssue({
      code: "custom",
      message: WEB_BUNDLE_ENDPOINT_LITERAL_CONSTRAINT,
    });
  })
  .transform(Number);

/** Resolve the ceiling from one environment value. Unset keeps the default. */
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
