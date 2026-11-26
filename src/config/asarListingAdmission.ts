import { defaultedNumberSettingParser } from "./optionalSetting.js";
import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";
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

export const asarMaxListingBytesSchema = positiveDecimalIntegerSchema(
  1,
  MAXIMUM_ASAR_MAX_LISTING_BYTES,
  constraint,
);

export const parseAsarListingAdmission =
  defaultedNumberSettingParser<AsarListingAdmission>(
    ASAR_LISTING_ADMISSION_SETTING,
    asarMaxListingBytesSchema,
    constraint,
    DEFAULT_ASAR_LISTING_ADMISSION,
    (maximumBytes) => ({ maximumBytes, source: "setting" }),
  );
