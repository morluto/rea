import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import { numberOf } from "./appTaskChecks.js";

/** How far a decimal the app writes as text may drift, such as `437.80000000000001` for 437.8, and still match. */
export const DECIMAL_TOLERANCE = 0.001;

/** A decimal string as the number it spells: digits, a point and digits, as both evaluators read a numeral; undefined for anything else. */
export const decimalOf = (value: JsonValue | undefined): number | undefined => {
  if (typeof value !== "string" || !/^-?\d+\.\d+$/u.test(value))
    return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

/** Whether a decimal's number is within the tolerance of a baseline value, read as the evaluators read a number, so a check by number would pass there too. */
const nearBaseline = (number: number, before: JsonValue | undefined) => {
  const old = before === undefined ? undefined : numberOf(before);
  return old !== undefined && Math.abs(old - number) <= DECIMAL_TOLERANCE;
};

/**
 * A `value_equals` check of a value: a decimal string as its number within
 * `DECIMAL_TOLERANCE`, unless `before`, the value the check must fail on, is
 * within it too; anything else exactly.
 */
export const valueEqualsCheck = (
  file: string,
  pointer: string,
  value: JsonValue,
  before?: JsonValue,
): DesktopTaskCheckInput => {
  const number = decimalOf(value);
  return number === undefined || nearBaseline(number, before)
    ? { kind: "value_equals", file, pointer, value }
    : {
        kind: "value_equals",
        file,
        pointer,
        value: number,
        tolerance: DECIMAL_TOLERANCE,
      };
};
