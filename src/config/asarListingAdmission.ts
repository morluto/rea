import { z } from "zod";
import {
  DEFAULT_ASAR_MAX_LISTING_BYTES,
  MAXIMUM_ASAR_MAX_LISTING_BYTES,
} from "../domain/analysisResourceLimits.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

export const ASAR_LISTING_ADMISSION_SETTING = "REA_ASAR_MAX_LISTING_BYTES";

/** Expanded path and entry retention, independently of packed header admission. */
export interface AsarListingAdmission {
  readonly maximumBytes: number;
  readonly source: "default" | "setting" | "runtime";
}

export const DEFAULT_ASAR_LISTING_ADMISSION: AsarListingAdmission = {
  maximumBytes: DEFAULT_ASAR_MAX_LISTING_BYTES,
  source: "default",
};

const constraint = `${ASAR_LISTING_ADMISSION_SETTING} must be a positive decimal safe integer in bytes, at most ${String(MAXIMUM_ASAR_MAX_LISTING_BYTES)}; the default is ${String(DEFAULT_ASAR_MAX_LISTING_BYTES)} bytes.`;

export const asarMaxListingBytesSchema = z
  .string()
  .regex(/^[1-9]\d*$/u, { error: constraint })
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAXIMUM_ASAR_MAX_LISTING_BYTES));

export const parseAsarListingAdmission = (
  value: string | undefined,
): Result<AsarListingAdmission, ConfigurationError> => {
  if (value === undefined) return ok(DEFAULT_ASAR_LISTING_ADMISSION);
  const parsed = asarMaxListingBytesSchema.safeParse(value);
  return parsed.success
    ? ok({ maximumBytes: parsed.data, source: "setting" })
    : err(
        new ConfigurationError(constraint, {
          settings: [{ setting: ASAR_LISTING_ADMISSION_SETTING, constraint }],
        }),
      );
};
