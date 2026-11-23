/**
 * Find the inner slice bounds after skipping leading and trailing runs matching
 * `predicate` in a single linear pass from each edge, avoiding quadratic `$`
 * regex backtracking on long interior runs.
 */
export const edgeSpan = (
  value: string,
  predicate: (character: string) => boolean,
): { readonly start: number; readonly end: number } => {
  let start = 0;
  let end = value.length;
  while (start < end && predicate(value[start]!)) start += 1;
  while (end > start && predicate(value[end - 1]!)) end -= 1;
  return { start, end };
};

/** Remove a trailing run of characters matching `predicate` in one backward scan. */
export const trimTrailing = (
  value: string,
  predicate: (character: string) => boolean,
): string => {
  let end = value.length;
  while (end > 0 && predicate(value[end - 1]!)) end -= 1;
  return end === value.length ? value : value.slice(0, end);
};

/** Remove leading and trailing runs of characters matching `predicate` in linear time. */
export const trimEdges = (
  value: string,
  predicate: (character: string) => boolean,
): string => {
  const { start, end } = edgeSpan(value, predicate);
  return start === 0 && end === value.length ? value : value.slice(start, end);
};
