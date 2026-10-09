import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";

/** Decode explicitly selected reference-source exclusion patterns. */
export const parseStringArray = (
  encoded: string,
  name: string,
): Result<readonly string[], ConfigurationError> => {
  return parseConfiguredStringArray(encoded, name, z.string().min(1));
};

/** Decode Hopper arguments while preserving meaningful empty argv entries. */
export const parseLoaderArgs = (
  encoded: string | undefined,
): Result<readonly string[], ConfigurationError> => {
  if (encoded === undefined) return ok([]);
  return parseConfiguredStringArray(
    encoded,
    "HOPPER_LOADER_ARGS_JSON",
    z.string(),
  );
};

const parseConfiguredStringArray = (
  encoded: string,
  setting: string,
  itemSchema: z.ZodString,
): Result<readonly string[], ConfigurationError> => {
  const decoded = safeParseJson(encoded);
  if (!decoded.ok)
    return err(
      configuredArrayError(setting, "must be valid JSON", decoded.cause),
    );
  const parsed = z.array(itemSchema).safeParse(decoded.value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        configuredArrayError(
          setting,
          "must encode an array of strings",
          parsed.error,
        ),
      );
};

const configuredArrayError = (
  setting: string,
  requirement: string,
  cause: unknown,
): ConfigurationError => {
  const constraint = `${setting} ${requirement}`;
  return new ConfigurationError(constraint, {
    cause,
    settings: [{ setting, constraint }],
  });
};
