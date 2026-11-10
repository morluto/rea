import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  DEFAULT_NTFS_MFT_MAX_FILE_BYTES,
  MAXIMUM_NTFS_MFT_MAX_FILE_BYTES,
  MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
  NTFS_MFT_MAX_FILE_SETTING,
  NTFS_MFT_MAX_FILE_SETTING_ID,
  type NtfsMftFileAdmission,
} from "../domain/windows/ntfsMft.js";

const decimalInteger = /^[1-9]\d*$/u;

/** Constraint for a rejected launch value. It names the range, not the rejected token. */
export const NTFS_MFT_FILE_ADMISSION_CONSTRAINT = `${NTFS_MFT_MAX_FILE_SETTING} must be a positive decimal integer from ${String(MINIMUM_NTFS_MFT_MAX_FILE_BYTES)} to ${String(MAXIMUM_NTFS_MFT_MAX_FILE_BYTES)} bytes; the default is ${String(DEFAULT_NTFS_MFT_MAX_FILE_BYTES)} bytes.`;

const inRange = (value: string): boolean => {
  if (!decimalInteger.test(value)) return false;
  const parsed = BigInt(value);
  return (
    parsed >= BigInt(MINIMUM_NTFS_MFT_MAX_FILE_BYTES) &&
    parsed <= BigInt(MAXIMUM_NTFS_MFT_MAX_FILE_BYTES)
  );
};

/** Optional whole-file ceiling for an acquired NTFS $MFT stream. */
export const ntfsMftMaxFileBytesSchema = z
  .string()
  .superRefine((value, context) => {
    if (inRange(value)) return;
    context.addIssue({
      code: "custom",
      message: NTFS_MFT_FILE_ADMISSION_CONSTRAINT,
    });
  })
  .transform(Number);

/** Resolve the ceiling from one environment value. Unset keeps the default. */
export const parseNtfsMftFileAdmission = (
  value: string | undefined,
): Result<NtfsMftFileAdmission, ConfigurationError> => {
  if (value === undefined)
    return ok({
      maximumBytes: DEFAULT_NTFS_MFT_MAX_FILE_BYTES,
      source: "default",
    });
  const parsed = ntfsMftMaxFileBytesSchema.safeParse(value);
  return parsed.success
    ? ok({ maximumBytes: parsed.data, source: "setting" })
    : err(
        new ConfigurationError(NTFS_MFT_FILE_ADMISSION_CONSTRAINT, {
          settings: [
            {
              setting: NTFS_MFT_MAX_FILE_SETTING,
              constraint: NTFS_MFT_FILE_ADMISSION_CONSTRAINT,
            },
          ],
        }),
      );
};

/**
 * Resolve the ceiling for one call. A runtime override replaces the launch
 * seed, including an invalid one, and is read when the file is admitted.
 */
export const runtimeNtfsMftFileAdmission = (
  environment: Readonly<Record<string, string | undefined>>,
  read?: AnalysisSettingsReader,
): NtfsMftFileAdmission => {
  const parsed = parseNtfsMftFileAdmission(
    environment[NTFS_MFT_MAX_FILE_SETTING],
  );
  if (read === undefined) {
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  }
  return {
    get maximumBytes() {
      const override = read().overrides[NTFS_MFT_MAX_FILE_SETTING_ID];
      if (override !== undefined) return override;
      if (!parsed.ok) throw parsed.error;
      return parsed.value.maximumBytes;
    },
    get source() {
      const override = read().overrides[NTFS_MFT_MAX_FILE_SETTING_ID];
      if (override !== undefined) return "runtime" as const;
      if (!parsed.ok) throw parsed.error;
      return parsed.value.source;
    },
  };
};
