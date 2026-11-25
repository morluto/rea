import { defaultedNumberSettingParser } from "./optionalSetting.js";
import { z } from "zod";
import {
  DEFAULT_ASAR_MAX_LISTING_BYTES,
  MAXIMUM_ASAR_MAX_LISTING_BYTES,
} from "../domain/analysisResourceLimits.js";

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

export const parseAsarListingAdmission =
  defaultedNumberSettingParser<AsarListingAdmission>(
    ASAR_LISTING_ADMISSION_SETTING,
    asarMaxListingBytesSchema,
    constraint,
    DEFAULT_ASAR_LISTING_ADMISSION,
    (maximumBytes) => ({ maximumBytes, source: "setting" }),
  );
