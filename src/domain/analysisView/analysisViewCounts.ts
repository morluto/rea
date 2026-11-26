import { compareAsciiStrings } from "../canonicalOrdering.js";

/** Counts in canonical key order; a null origin sorts first. */
export const sortedCountEntries = <Key extends string | null>(
  counts: ReadonlyMap<Key, number>,
): [Key, number][] =>
  [...counts].sort(([left], [right]) =>
    left === right
      ? 0
      : left === null
        ? -1
        : right === null
          ? 1
          : compareAsciiStrings(left, right),
  );

export const incrementCount = <Key>(
  counts: Map<Key, number>,
  key: Key,
): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

export const countValues = <Key>(values: Iterable<Key>): Map<Key, number> => {
  const counts = new Map<Key, number>();
  for (const value of values) incrementCount(counts, value);
  return counts;
};

/** Named counts in first-observed order. */
export const namedCounts = <Name>(names: Iterable<Name>) =>
  Array.from(countValues(names), ([name, count]) => ({ name, count }));
