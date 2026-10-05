/**
 * Canonical code-point ordering shared across domain and application layers.
 *
 * Compares strings by Unicode code point (`<`/`>`) so graph ordering,
 * fingerprints, and deterministic tie-breaks stay stable regardless of
 * locale. Prefer this over `String.prototype.localeCompare`, which is
 * locale-dependent.
 */
export const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Deduplicate and sort strings with canonical code-point ordering. */
export const uniqueSorted = <Value extends string>(
  values: readonly Value[],
): Value[] => [...new Set(values)].sort(compareCodePoints);
