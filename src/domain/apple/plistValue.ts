import { z } from "zod";

import type { JsonValue } from "../jsonValue.js";

const MAX_PLIST_DEPTH = 128;

/** A decoded plist projected into JSON, with values JSON cannot express. */
export interface ProjectedPlistValue {
  readonly value: JsonValue;
  /** Reals decoded as NaN, which the decoder also uses for ±infinity. */
  readonly unknownRealCount: number;
}

/**
 * Project a decoded plist into JSON. Data and dates become explicit
 * `$plist_type` objects; a non-finite real becomes an explicit unknown
 * because the XML decoder reports NaN and ±infinity alike.
 */
export const projectPlistValue = (value: unknown): ProjectedPlistValue => {
  let unknownRealCount = 0;
  const project = (item: unknown, depth: number): JsonValue => {
    if (depth > MAX_PLIST_DEPTH)
      throw new RangeError(
        `Plist exceeds ${String(MAX_PLIST_DEPTH)} nesting levels`,
      );
    if (item instanceof Uint8Array)
      return {
        $plist_type: "data",
        base64: Buffer.from(item).toString("base64"),
      };
    if (item instanceof Date)
      return { $plist_type: "date", iso8601: item.toISOString() };
    if (typeof item === "number" && !Number.isFinite(item)) {
      unknownRealCount += 1;
      return { $plist_type: "real", value: null };
    }
    if (Array.isArray(item))
      return item.map((entry: unknown) => project(entry, depth + 1));
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [
          key,
          project(entry, depth + 1),
        ]),
      );
    return z.union([z.string(), z.number(), z.boolean(), z.null()]).parse(item);
  };
  const projected = project(value, 0);
  return { value: projected, unknownRealCount };
};
