import type { JsonValue } from "../domain/jsonValue.js";
import {
  jsonValueSchema,
  jsonValueValidationIssue,
} from "../domain/jsonValue.js";

/**
 * Parse trimmed command output as JSON for a lenient projection.
 *
 * The raw output stays authoritative; this returns `undefined` whenever the
 * output is not valid JSON (empty output, prose, or a command without a `j`
 * suffix) so callers can fall back to the raw text.
 */
export const projectRadare2JsonOutput = (
  output: string,
): { readonly parsed: JsonValue } | undefined => {
  const trimmed = output.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return { parsed: JSON.parse(trimmed) as JsonValue };
  } catch {
    return undefined;
  }
};

const SUMMARY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  aflj: ["name", "addr", "size"],
  // Real `izzj` emits vaddr/paddr (verified on radare2 6.2.4); there is no
  // `addr` field, and the two addresses have distinct meanings (virtual vs
  // file offset).
  izzj: ["string", "vaddr", "paddr", "length"],
};

/**
 * Reduce a known listing command's parsed output to the fields agents
 * consume most. The full parsed value stays in `parsed`; this is an
 * additive token-saving view, never a replacement.
 */
export const projectRadare2Summary = (
  command: string,
  parsed: JsonValue,
): JsonValue[] | undefined => {
  const fields = SUMMARY_FIELDS[command.trim()];
  if (fields === undefined || !Array.isArray(parsed)) return undefined;
  return parsed.map((entry): JsonValue => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return entry;
    const source = entry as Record<string, unknown>;
    return Object.fromEntries(
      fields
        .filter((field) => source[field] !== undefined)
        .map((field) => [field, source[field] as JsonValue]),
    ) as { [key: string]: JsonValue };
  });
};

/**
 * True when every numeric literal outside JSON strings survives a round
 * trip. String contents are skipped: digits inside strings (leading-zero
 * dates, character-set names) are not JSON numbers and must not fail the
 * scan.
 */
const jsonNumberLiteralsRoundTrip = (output: string): boolean => {
  let index = 0;
  while (index < output.length) {
    const character = output[index];
    if (character === '"') {
      index += 1;
      while (index < output.length) {
        if (output[index] === "\\") index += 2;
        else if (output[index] === '"') {
          index += 1;
          break;
        } else index += 1;
      }
      continue;
    }
    if (character !== "-" && (character! < "0" || character! > "9")) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < output.length && /[\d.eE+-]/u.test(output[index]!)) {
      // A sign or exponent only continues a JSON number when it follows
      // digits; the scan below re-checks the collected literal by parsing.
      index += 1;
    }
    const literal = output.slice(start, index);
    if (!numberLiteralIsFaithful(literal)) return false;
  }
  return true;
};

/**
 * True when a JSON number literal keeps its numeric value through
 * `JSON.parse`. Alternate spellings of exactly representable values
 * (`1.0`, `1e3`, trailing-zero decimals) are faithful; integers beyond
 * `Number.MAX_SAFE_INTEGER` and non-finite results are not. Decimal and
 * exponent literals only need finiteness: their parsed value is the
 * nearest double by JSON semantics, identical to any other consumer.
 */
const numberLiteralIsFaithful = (literal: string): boolean => {
  try {
    const value = JSON.parse(literal) as unknown;
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (/^-?[0-9]+$/u.test(literal)) return BigInt(literal) === BigInt(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Build the delivery-only evidence views (`parsed`, and `summary` for known
 * listings) from one command's effective output. These fields must be part
 * of the Evidence at construction time: evidence identifiers are
 * content-addressed, so attaching them later would invalidate the record.
 */
export const projectRadare2DeliveryViews = (
  command: string,
  output: string,
): {
  readonly parsed?: JsonValue;
  readonly summary?: ReadonlyArray<JsonValue>;
} => {
  const projection = projectRadare2JsonOutput(output);
  if (projection === undefined) return {};
  // JSON.parse accepts values the Evidence projection cannot represent
  // faithfully: non-finite numbers ("1e400" -> Infinity) and integers beyond
  // Number.MAX_SAFE_INTEGER (9007199254740993 silently rounds). An
  // unfaithful value must degrade to the raw output instead of shipping a
  // distorted projection.
  if (!jsonValueSchema.safeParse(projection.parsed).success) return {};
  if (!jsonNumberLiteralsRoundTrip(output)) return {};
  // Evidence validates `raw_result` as its own JSON value, so a delivery view is
  // validated one level deeper there. Reserve that level: a value exactly at the
  // depth limit would otherwise pass this check and make Evidence creation
  // throw, turning one command into a stopped session instead of a raw fallback.
  if (jsonValueValidationIssue({ parsed: projection.parsed }) !== undefined)
    return {};
  const summary = projectRadare2Summary(command, projection.parsed);
  return {
    parsed: projection.parsed,
    ...(summary === undefined ? {} : { summary }),
  };
};
