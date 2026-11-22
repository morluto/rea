/** Compare strings lexicographically by Unicode code point, independent of locale. */
export const compareUnicodeCodePoints = (
  left: string,
  right: string,
): number => {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex) ?? 0;
    const rightPoint = right.codePointAt(rightIndex) ?? 0;
    const difference = leftPoint - rightPoint;
    if (difference !== 0) return difference;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  if (leftIndex === left.length && rightIndex === right.length) return 0;
  return leftIndex === left.length ? -1 : 1;
};

/**
 * JSON tuple key for deduplication/sorting. Unlike `\0`-joins, it preserves
 * boundaries when string components contain NUL. Callers must account for JSON
 * serialization semantics, such as undefined array elements becoming null.
 */
export const compositeKey = (parts: readonly unknown[]): string =>
  JSON.stringify(parts);
