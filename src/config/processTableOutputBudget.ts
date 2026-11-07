import { constants } from "node:buffer";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

export const PROCESS_TABLE_MAX_BYTES_SETTING = "REA_PROCESS_TABLE_MAX_BYTES";

/** Whole-host inventory budget, independent of individual diagnostic probes. */
export const DEFAULT_PROCESS_TABLE_MAX_BYTES = 8 * 1024 * 1024;

// Each captured stream is decoded into one string before rows are parsed.
// ASCII is the worst case: one code unit per captured byte.
export const processTableMaxBytesConstraint = `${PROCESS_TABLE_MAX_BYTES_SETTING} must be a positive decimal integer from 1 to ${String(constants.MAX_STRING_LENGTH)} bytes; the default is ${String(DEFAULT_PROCESS_TABLE_MAX_BYTES)} bytes (8 MiB) per stdout/stderr stream. The maximum keeps each decoded stream within Node's single-string limit.`;

export const processTableMaxBytesSchema = positiveDecimalIntegerSchema(
  1,
  constants.MAX_STRING_LENGTH,
  processTableMaxBytesConstraint,
);

/** Parse the selected host setting without reading the ambient environment. */
export const parseProcessTableMaxBytes = (
  value: string | undefined,
): Result<number, ConfigurationError> => {
  if (value === undefined) return ok(DEFAULT_PROCESS_TABLE_MAX_BYTES);
  const parsed = processTableMaxBytesSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError(processTableMaxBytesConstraint, {
          settings: [
            {
              setting: PROCESS_TABLE_MAX_BYTES_SETTING,
              constraint: processTableMaxBytesConstraint,
            },
          ],
        }),
      );
};
