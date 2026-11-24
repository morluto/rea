import type { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

/** Parse an optional launch setting with its owner's schema and diagnostic. */
export const optionalSettingParser =
  <T>(setting: string, schema: z.ZodType<T>, constraint: string) =>
  (value: string | undefined): Result<T | undefined, ConfigurationError> => {
    if (value === undefined) return ok(undefined);
    const parsed = schema.safeParse(value);
    return parsed.success
      ? ok(parsed.data)
      : err(
          new ConfigurationError(constraint, {
            settings: [{ setting, constraint }],
          }),
        );
  };
