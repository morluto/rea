import type { z } from "zod";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

export const parseOptionalMcpSetting = <T>(
  value: string | undefined,
  schema: z.ZodType<T>,
  setting: string,
  constraint: string,
): Result<T | undefined, ConfigurationError> => {
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
