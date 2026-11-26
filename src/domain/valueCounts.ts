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
