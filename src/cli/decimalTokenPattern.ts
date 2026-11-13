import { z } from "incur";

const digits = (count: number): string =>
  count === 0 ? "" : count === 1 ? "[0-9]" : `[0-9]{${count}}`;

const digitRange = (low: number, high: number): string =>
  low === high ? String(low) : `[${low}-${high}]`;

/** Lexicographic bounds for equal-width, unsigned decimal strings. */
const sameWidthRange = (low: string, high: string): string => {
  if (low === high) return low;
  const width = low.length;
  if (low === "0".repeat(width) && high === "9".repeat(width))
    return digits(width);
  const first = Number(low[0]);
  const last = Number(high[0]);
  if (width === 1) return digitRange(first, last);
  if (
    low.slice(1) === "0".repeat(width - 1) &&
    high.slice(1) === "9".repeat(width - 1)
  )
    return `${digitRange(first, last)}${digits(width - 1)}`;
  if (first === last)
    return `${first}${sameWidthRange(low.slice(1), high.slice(1))}`;
  const branches = [
    `${first}${sameWidthRange(low.slice(1), "9".repeat(width - 1))}`,
  ];
  if (first + 1 <= last - 1)
    branches.push(`${digitRange(first + 1, last - 1)}${digits(width - 1)}`);
  branches.push(
    `${last}${sameWidthRange("0".repeat(width - 1), high.slice(1))}`,
  );
  return `(?:${branches.join("|")})`;
};

/** Keep the floor of an open-ended domain, whose tokens may grow past it. */
const openEndedPattern = (minimum: number): string => {
  if (minimum === 0) return "^[0-9]+$";
  const low = String(minimum);
  const atFloorWidth = sameWidthRange(low, "9".repeat(low.length));
  return `^0*(?:${atFloorWidth}|[1-9][0-9]{${String(low.length)},})$`;
};

/**
 * Publish the domain's numeric range on the decimal-token branch without
 * changing parser diagnostics. Refinements that are not a range stay
 * parser-only, so an advertised schema can admit a token the parser rejects;
 * it never rejects a token the parser admits.
 */
export const decimalTokenPattern = (domain: z.ZodNumber): string => {
  const schema = z.toJSONSchema(domain);
  const minimum = Math.max(
    0,
    Math.ceil(schema.minimum ?? 0),
    typeof schema.exclusiveMinimum === "number"
      ? Math.floor(schema.exclusiveMinimum) + 1
      : 0,
  );
  const maximum = Math.min(
    Math.floor(schema.maximum ?? Infinity),
    typeof schema.exclusiveMaximum === "number"
      ? Math.ceil(schema.exclusiveMaximum) - 1
      : Infinity,
  );
  // Non-integer floors and ceilings have no safe-integer range to publish.
  if (!Number.isSafeInteger(minimum)) return "^[0-9]+$";
  if (maximum === Infinity) return openEndedPattern(minimum);
  if (!Number.isSafeInteger(maximum)) return "^[0-9]+$";
  if (minimum > maximum) return "^(?!)$";
  const low = String(minimum);
  const high = String(maximum);
  const branches: string[] = [];
  for (let width = low.length; width <= high.length; width++) {
    branches.push(
      sameWidthRange(
        width === low.length ? low : `1${"0".repeat(width - 1)}`,
        width === high.length ? high : "9".repeat(width),
      ),
    );
  }
  // Tokens retain the CLI's decimal leading-zero convention.
  return `^0*(?:${branches.join("|")})$`;
};
