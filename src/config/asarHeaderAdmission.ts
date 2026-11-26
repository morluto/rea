import { defaultedNumberSettingParser } from "./optionalSetting.js";
import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";
import {
  DEFAULT_ASAR_MAX_HEADER_BYTES,
  MAXIMUM_ASAR_MAX_HEADER_BYTES,
} from "../domain/analysisResourceLimits.js";

import type { AsarListingAdmission } from "./asarListingAdmission.js";

export const ASAR_HEADER_ADMISSION_SETTING = "REA_ASAR_MAX_HEADER_BYTES";

/** Effective ASAR header/index admission and where its value came from. */
export interface AsarHeaderAdmission {
  readonly maximumBytes: number;
  readonly source: "default" | "setting" | "runtime";
  /** Independently resolved expanded listing policy; omission uses its default. */
  readonly listing?: AsarListingAdmission;
}

export const DEFAULT_ASAR_HEADER_ADMISSION: AsarHeaderAdmission = {
  maximumBytes: DEFAULT_ASAR_MAX_HEADER_BYTES,
  source: "default",
};

const asarMaxHeaderBytesConstraint = `${ASAR_HEADER_ADMISSION_SETTING} must be a positive decimal integer of at most ${String(MAXIMUM_ASAR_MAX_HEADER_BYTES)} bytes (256 MiB); the default is ${String(DEFAULT_ASAR_MAX_HEADER_BYTES)} bytes (16 MiB).`;

/** Optional decimal byte count for the ASAR header/index admission. */
export const asarMaxHeaderBytesSchema = positiveDecimalIntegerSchema(
  1,
  MAXIMUM_ASAR_MAX_HEADER_BYTES,
  asarMaxHeaderBytesConstraint,
);

/** Resolve the effective admission from one environment value. */
export const parseAsarHeaderAdmission =
  defaultedNumberSettingParser<AsarHeaderAdmission>(
    ASAR_HEADER_ADMISSION_SETTING,
    asarMaxHeaderBytesSchema,
    asarMaxHeaderBytesConstraint,
    DEFAULT_ASAR_HEADER_ADMISSION,
    (maximumBytes) => ({ maximumBytes, source: "setting" }),
  );
