import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

/**
 * Canonical code-point ordering shared across domain and application layers.
 *
 * Compares strings by Unicode code point so graph ordering, fingerprints, and
 * deterministic tie-breaks stay stable regardless of locale. Prefer this over
 * `String.prototype.localeCompare`, which is locale-dependent.
 *
 * Ordering by code point differs from ordering by UTF-16 code unit for astral
 * code points (above U+FFFF), whose lead surrogate is numerically below the
 * BMP tail U+E000-U+FFFF.
 */
export const compareCodePoints = (left: string, right: string): number =>
  compareUnicodeCodePoints(left, right);

/** Deduplicate and sort strings with canonical code-point ordering. */
export const uniqueSorted = <Value extends string>(
  values: readonly Value[],
): Value[] => [...new Set(values)].sort(compareCodePoints);
