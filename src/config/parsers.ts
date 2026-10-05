import { z } from "zod";

import { ConfigurationError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";

export const parseStringArray = (
  encoded: string,
  name: string,
): Result<readonly string[], ConfigurationError> => {
  try {
    const parsed = z.array(z.string().min(1)).safeParse(JSON.parse(encoded));
    return parsed.success
      ? ok(parsed.data)
      : err(
          new ConfigurationError(`${name} must encode an array of strings`, {
            cause: parsed.error,
          }),
        );
  } catch (cause: unknown) {
    return err(new ConfigurationError(`${name} must be valid JSON`, { cause }));
  }
};

export const parseLoaderArgs = (
  encoded: string | undefined,
): Result<readonly string[], ConfigurationError> => {
  if (encoded === undefined) return ok([]);
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch (cause: unknown) {
    return err(
      new ConfigurationError("HOPPER_LOADER_ARGS_JSON must be valid JSON", {
        cause,
      }),
    );
  }
  const parsed = z.array(z.string()).safeParse(decoded);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError(
          "HOPPER_LOADER_ARGS_JSON must encode an array of strings",
          { cause: parsed.error },
        ),
      );
};
