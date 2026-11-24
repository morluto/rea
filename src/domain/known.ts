/**
 * A fact its producer established, or the reason it could not. An unknown
 * fact is never a default value: a count it would have supplied is unknown,
 * not zero, and a list is unknown, not empty.
 */
export type Known<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly reason: string };

/** A fact the producer established. */
export const known = <T>(value: T): Known<T> => ({ known: true, value });

/** A fact the producer could not establish, with why. */
export const unknownBecause = (reason: string): Known<never> => ({
  known: false,
  reason,
});

/**
 * Sum counts; one unknown count makes the sum unknown, with the first
 * unknown's reason, rather than counting as zero.
 */
export const sumKnownCounts = (
  counts: readonly Known<number>[],
): Known<number> => {
  let total = 0;
  for (const count of counts) {
    if (!count.known) return count;
    total += count.value;
  }
  return known(total);
};

/** Project a fact onto a wire field where `null` means unknown. */
export const knownOrNull = <T, R>(
  fact: Known<T>,
  read: (value: T) => R,
): R | null => (fact.known ? read(fact.value) : null);
