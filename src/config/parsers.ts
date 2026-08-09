import { z } from "zod";
import { isAbsolute } from "node:path";

import { ConfigurationError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { electronFileRootsSchema } from "../domain/electronObservation.js";

export const parseStringArray = (
  encoded: string,
  name: string,
): Result<readonly string[], ConfigurationError> => {
  try {
    const parsed = z
      .array(z.string().min(1))
      .max(128)
      .safeParse(JSON.parse(encoded));
    return parsed.success
      ? ok(parsed.data)
      : err(
          new ConfigurationError(
            parsed.error.issues.some(({ code }) => code === "too_big")
              ? `${name} must encode at most 128 strings`
              : `${name} must encode an array of strings`,
            { cause: parsed.error },
          ),
        );
  } catch (cause: unknown) {
    return err(new ConfigurationError(`${name} must be valid JSON`, { cause }));
  }
};

/** Parse a JSON string array whose members must all be absolute paths. */
export const parseAbsoluteRoots = (
  encoded: string,
  name: string,
): Result<readonly string[], ConfigurationError> => {
  const parsed = parseStringArray(encoded, name);
  if (!parsed.ok) return parsed;
  return parsed.value.some((root) => !isAbsolute(root))
    ? err(new ConfigurationError(`${name} must encode absolute roots`))
    : parsed;
};

export const parseBrowserArray = (
  encoded: string,
  name: string,
  itemSchema: z.ZodType<string>,
  maximum: number,
): Result<readonly string[], ConfigurationError> => {
  try {
    const parsed = z
      .array(itemSchema)
      .max(maximum)
      .safeParse(JSON.parse(encoded));
    return parsed.success
      ? ok([...new Set(parsed.data)].sort())
      : err(
          new ConfigurationError(`${name} must encode valid browser scopes`, {
            cause: parsed.error,
          }),
        );
  } catch (cause: unknown) {
    return err(new ConfigurationError(`${name} must be valid JSON`, { cause }));
  }
};

export const parseElectronFileRoots = (
  encoded: string,
): Result<readonly string[], ConfigurationError> => {
  try {
    const decoded: unknown = JSON.parse(encoded);
    if (Array.isArray(decoded) && decoded.length === 0) return ok([]);
    const parsed = electronFileRootsSchema.safeParse(decoded);
    return parsed.success
      ? ok(parsed.data)
      : err(
          new ConfigurationError(
            "REA_ELECTRON_FILE_ROOTS_JSON must encode absolute roots",
            { cause: parsed.error },
          ),
        );
  } catch (cause: unknown) {
    return err(
      new ConfigurationError(
        "REA_ELECTRON_FILE_ROOTS_JSON must be valid JSON",
        { cause },
      ),
    );
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
