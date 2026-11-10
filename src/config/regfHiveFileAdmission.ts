import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  DEFAULT_REGF_MAX_FILE_BYTES,
  MAXIMUM_REGF_MAX_FILE_BYTES,
  MINIMUM_REGF_MAX_FILE_BYTES,
  REGF_HIVE_MAX_FILE_SETTING,
  type RegfHiveFileAdmission,
} from "../domain/windows/registryHive.js";

const decimalInteger = /^[1-9]\d*$/u;

/** Constraint for a rejected launch value. It names the range, not the rejected token. */
export const REGF_HIVE_FILE_ADMISSION_CONSTRAINT = `${REGF_HIVE_MAX_FILE_SETTING} must be a positive decimal integer from ${String(MINIMUM_REGF_MAX_FILE_BYTES)} to ${String(MAXIMUM_REGF_MAX_FILE_BYTES)} bytes; the default is ${String(DEFAULT_REGF_MAX_FILE_BYTES)} bytes. Set ${REGF_HIVE_MAX_FILE_SETTING} in the environment that starts REA, then restart REA. There is no runtime override.`;

const inRange = (value: string): boolean => {
  if (!decimalInteger.test(value)) return false;
  const parsed = BigInt(value);
  return (
    parsed >= BigInt(MINIMUM_REGF_MAX_FILE_BYTES) &&
    parsed <= BigInt(MAXIMUM_REGF_MAX_FILE_BYTES)
  );
};

/** Optional whole-file ceiling for an acquired Windows registry hive. */
export const regfHiveMaxFileBytesSchema = z
  .string()
  .superRefine((value, context) => {
    if (inRange(value)) return;
    context.addIssue({
      code: "custom",
      message: REGF_HIVE_FILE_ADMISSION_CONSTRAINT,
    });
  })
  .transform(Number);

/** Resolve the ceiling from one environment value. Unset keeps the default. */
export const parseRegfHiveFileAdmission = (
  value: string | undefined,
): Result<RegfHiveFileAdmission, ConfigurationError> => {
  if (value === undefined)
    return ok({
      maximumBytes: DEFAULT_REGF_MAX_FILE_BYTES,
      source: "default",
    });
  const parsed = regfHiveMaxFileBytesSchema.safeParse(value);
  return parsed.success
    ? ok({ maximumBytes: parsed.data, source: "setting" })
    : err(
        new ConfigurationError(REGF_HIVE_FILE_ADMISSION_CONSTRAINT, {
          settings: [
            {
              setting: REGF_HIVE_MAX_FILE_SETTING,
              constraint: REGF_HIVE_FILE_ADMISSION_CONSTRAINT,
            },
          ],
        }),
      );
};
