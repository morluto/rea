import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  DEFAULT_REGF_MAX_FILE_BYTES,
  MAXIMUM_REGF_MAX_FILE_BYTES,
  MINIMUM_REGF_MAX_FILE_BYTES,
  REGF_HIVE_MAX_FILE_SETTING,
  REGF_HIVE_MAX_FILE_SETTING_ID,
  type RegfHiveFileAdmission,
} from "../domain/windows/registryHive.js";

const decimalInteger = /^[1-9]\d*$/u;

/** Constraint for a rejected launch value. It names the range, not the rejected token. */
export const REGF_HIVE_FILE_ADMISSION_CONSTRAINT = `${REGF_HIVE_MAX_FILE_SETTING} must be a positive decimal integer from ${String(MINIMUM_REGF_MAX_FILE_BYTES)} to ${String(MAXIMUM_REGF_MAX_FILE_BYTES)} bytes; the default is ${String(DEFAULT_REGF_MAX_FILE_BYTES)} bytes.`;

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

/**
 * Resolve the ceiling for one call. A runtime override replaces the launch
 * seed, including an invalid one, and is read when the file is admitted.
 */
export const runtimeRegfHiveFileAdmission = (
  environment: Readonly<Record<string, string | undefined>>,
  read?: AnalysisSettingsReader,
): RegfHiveFileAdmission => {
  const parsed = parseRegfHiveFileAdmission(
    environment[REGF_HIVE_MAX_FILE_SETTING],
  );
  if (read === undefined) {
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  }
  return {
    get maximumBytes() {
      const override = read().overrides[REGF_HIVE_MAX_FILE_SETTING_ID];
      if (override !== undefined) return override;
      if (!parsed.ok) throw parsed.error;
      return parsed.value.maximumBytes;
    },
    get source() {
      const override = read().overrides[REGF_HIVE_MAX_FILE_SETTING_ID];
      if (override !== undefined) return "runtime" as const;
      if (!parsed.ok) throw parsed.error;
      return parsed.value.source;
    },
  };
};
