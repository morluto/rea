import { compareNumber, isInteger, isSafeNumber } from "lossless-json";
import { ownedJsonValueSchema, type JsonValue } from "./jsonValue.js";
import { safeParseJson } from "./safeJson.js";

/** Project a recorded decimal without losing significant digits. A plain integer must also be safe. */
export const recordedJsonNumber = (source: string): number | null => {
  const value = Number(source);
  if (isSafeNumber(source)) return value;
  // lossless-json rejects every unsafe integer-valued float. Exact
  // decimal spellings still carry a reported number alongside their literal.
  return Number.isFinite(value) &&
    Number.isInteger(value) &&
    !isInteger(source) &&
    compareNumber(source, String(value)) === 0
    ? value
    : null;
};

/** Both the recorded spelling and the one JSON writes must remain representable. */
export const isExactJsonNumber = (
  value: number,
  source: string | undefined,
): boolean => {
  if (
    source === undefined ||
    Object.is(value, -0) ||
    recordedJsonNumber(source) === null
  )
    return false;
  const serialized = String(value);
  return source === serialized || recordedJsonNumber(serialized) !== null;
};

/** Parse JSON text whose every number survives native conversion exactly; undefined otherwise. */
export const parseExactJson = (text: string): JsonValue | undefined => {
  const parsed = safeParseJson(text, (_key, value, context) => {
    // The native parser supplies each primitive's original spelling. Share
    // HAR's exact-number policy rather than accepting an already-rounded ID.
    if (typeof value === "number" && !isExactJsonNumber(value, context?.source))
      throw new RangeError("JSON numeric conversion would lose recorded data");
    return value;
  });
  if (!parsed.ok) return undefined;
  const value = ownedJsonValueSchema.safeParse(parsed.value);
  return value.success ? value.data : undefined;
};
