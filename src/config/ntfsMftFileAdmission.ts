import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  DEFAULT_NTFS_MFT_MAX_FILE_BYTES,
  MAXIMUM_NTFS_MFT_MAX_FILE_BYTES,
  MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
  NTFS_MFT_MAX_FILE_SETTING,
  type NtfsMftFileAdmission,
} from "../domain/windows/ntfsMft.js";

const decimalInteger = /^[1-9]\d*$/u;

/** Constraint for a rejected launch value. It names the range, not the rejected token. */
export const NTFS_MFT_FILE_ADMISSION_CONSTRAINT = `${NTFS_MFT_MAX_FILE_SETTING} must be a positive decimal integer from ${String(MINIMUM_NTFS_MFT_MAX_FILE_BYTES)} to ${String(MAXIMUM_NTFS_MFT_MAX_FILE_BYTES)} bytes; the default is ${String(DEFAULT_NTFS_MFT_MAX_FILE_BYTES)} bytes. Set ${NTFS_MFT_MAX_FILE_SETTING} in the environment that starts REA, then restart REA. There is no runtime override.`;

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
