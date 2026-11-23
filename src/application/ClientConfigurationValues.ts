import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

/** Admit source mappings without Zod's record clone dropping caller keys. */
export const clientConfigurationRecordSchema = z
  .custom<Record<string, unknown>>((value) => {
    if (typeof value !== "object" || value === null) return false;
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
  })
  .transform((value) => Object.fromEntries(Object.entries(value)));

/** Compare parsed configuration values without depending on parser prototypes. */
export const clientConfigurationValuesEqual = (
  left: unknown,
  right: unknown,
): boolean =>
  isDeepStrictEqual(
    normalizeConfigurationValue(left),
    normalizeConfigurationValue(right),
  );

const normalizeConfigurationValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeConfigurationValue);
  if (typeof value !== "object" || value === null || value instanceof Date)
    return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
      .map(([key, nested]) => [key, normalizeConfigurationValue(nested)]),
  );
};

/**
 * Whether raw configuration text holds no settings to preserve. Some clients
 * create a zero-byte config file before any server is added.
 */
export const isEmptyClientConfigurationText = (text: string): boolean =>
  text.replace(/^\uFEFF/, "").trim() === "";
