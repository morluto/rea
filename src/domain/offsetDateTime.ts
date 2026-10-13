import { z } from "zod";

export interface OffsetDateTimeInstant {
  readonly epochSecond: number;
  /** Exact fractional second with insignificant trailing zeroes removed. */
  readonly fraction: string;
}

/**
 * ISO-8601 date-time that requires an explicit UTC offset.
 *
 * `z.string().datetime({ offset: true })` emits Zod's offset class as `[+-]`.
 * Annex B and `u` mode accept that, but ECMA-262 `v` mode rejects the
 * unescaped `-`, so any tool whose schema carries the pattern is unusable for a
 * client that compiles advertised patterns — schema compilation happens before
 * arguments are supplied, so the whole tools request fails rather than one call.
 *
 * The accepted set is identical to the Zod validator; only the offset class
 * escapes `-`, as `\x2d`, because an escaped `-` inside a character class is
 * removed by `oxlint --fix` as a useless escape.
 */
export const offsetDateTimeSchema = z
  .string()
  .regex(
    /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|(?:[+\x2d](?:[01]\d|2[0-3]):[0-5]\d)))$/u,
    "Use an ISO-8601 date-time with an explicit UTC offset",
  );

/** Parse an already validated offset timestamp without losing sub-millisecond precision. */
export const parseOffsetDateTimeInstant = (
  value: string,
): OffsetDateTimeInstant => {
  const match = /^(.*?)(?:\.(\d+))?(Z|[+\x2d]\d{2}:\d{2})$/u.exec(value);
  if (match === null)
    throw new TypeError("Expected a validated offset date-time.");
  const [, dateTime, fractionalDigits, offset] = match;
  if (dateTime === undefined || offset === undefined)
    throw new TypeError("Expected a validated offset date-time.");
  const wholeSecondMilliseconds = Date.parse(`${dateTime}${offset}`);
  if (
    !Number.isSafeInteger(wholeSecondMilliseconds) ||
    wholeSecondMilliseconds % 1000 !== 0
  )
    throw new TypeError(
      "Offset date-time is outside the supported time range.",
    );
  return {
    epochSecond: wholeSecondMilliseconds / 1000,
    fraction: fractionalDigits?.replace(/0+$/u, "") ?? "",
  };
};

/** Convert a Date.now-style integer into the same exact comparison shape. */
export const offsetDateTimeInstantFromEpochMilliseconds = (
  epochMilliseconds: number,
): OffsetDateTimeInstant => {
  if (!Number.isFinite(epochMilliseconds))
    throw new TypeError("Expected finite epoch milliseconds.");
  if (Math.abs(epochMilliseconds) > Number.MAX_SAFE_INTEGER)
    return { epochSecond: epochMilliseconds / 1000, fraction: "" };
  const epochSecond = Math.floor(epochMilliseconds / 1000);
  const millisecondsWithinSecond = epochMilliseconds - epochSecond * 1000;
  return {
    epochSecond,
    fraction: fractionalSecondFromMilliseconds(millisecondsWithinSecond),
  };
};

const fractionalSecondFromMilliseconds = (milliseconds: number): string => {
  if (milliseconds === 0) return "";
  const [coefficient = "", exponentText] = String(milliseconds)
    .toLowerCase()
    .split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const point = coefficient.indexOf(".");
  const decimalPosition =
    (point < 0 ? coefficient.length : point) + exponent - 3;
  const digits = coefficient.replace(".", "");
  const fraction =
    decimalPosition <= 0
      ? `0.${"0".repeat(-decimalPosition)}${digits}`
      : decimalPosition < digits.length
        ? `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`
        : `${digits}${"0".repeat(decimalPosition - digits.length)}`;
  return (
    fraction.includes(".") ? fraction.slice(fraction.indexOf(".") + 1) : ""
  ).replace(/0+$/u, "");
};

/** Compare instants exactly while treating absent fraction digits as zeroes. */
export const compareOffsetDateTimeInstants = (
  left: OffsetDateTimeInstant,
  right: OffsetDateTimeInstant,
): number => {
  if (left.epochSecond !== right.epochSecond)
    return left.epochSecond < right.epochSecond ? -1 : 1;
  const length = Math.max(left.fraction.length, right.fraction.length);
  for (let index = 0; index < length; index += 1) {
    const leftDigit = left.fraction.charCodeAt(index) || 48;
    const rightDigit = right.fraction.charCodeAt(index) || 48;
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
  }
  return 0;
};
