import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

/**
 * Canonically encode one export-shape comparison value.
 *
 * Comparison identifiers hash the full result semantics, including each
 * change's presence object and the per-variant property inventories.
 */
export const canonicalExportShapeValue = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError(
      "JavaScript export shape comparison could not canonicalize data",
    );
  return encoded;
};

/** Derive one deterministic SHA-256 comparison identifier component. */
export const digestExportShapeValue = (value: unknown): string =>
  createHash("sha256").update(canonicalExportShapeValue(value)).digest("hex");
