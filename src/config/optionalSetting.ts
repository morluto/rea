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

/** Resolve a numeric setting and keep the owner's default and source metadata. */
export const defaultedNumberSettingParser = <T>(
  setting: string,
  schema: z.ZodType<number>,
  constraint: string,
  fallback: T,
  fromSetting: (value: number) => T,
) => {
  const parse = optionalSettingParser(setting, schema, constraint);
  return (value: string | undefined): Result<T, ConfigurationError> => {
    const parsed = parse(value);
    if (!parsed.ok) return parsed;
    return ok(
      parsed.value === undefined ? fallback : fromSetting(parsed.value),
    );
  };
};
