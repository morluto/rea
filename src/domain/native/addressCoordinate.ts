/** Parse canonical native offsets without discarding their address space. */
export const addressCoordinate = (
  value: string,
): { readonly space: string | null; readonly offset: bigint } | null => {
  const separator = value.lastIndexOf(":0x");
  if (separator === 0) return null;
  const space = separator < 0 ? null : value.slice(0, separator);
  const offset = separator < 0 ? value : value.slice(separator + 1);
  if (!/^0x[0-9a-f]+$/u.test(offset)) return null;
  return { space, offset: BigInt(offset) };
};

/** Return a bounded byte distance between canonical addresses in one space. */
export const addressDistance = (start: string, end: string): number | null => {
  const left = addressCoordinate(start);
  const right = addressCoordinate(end);
  if (left === null || right === null || left.space !== right.space)
    return null;
  const distance = right.offset - left.offset;
  if (distance < 0n || distance > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(distance);
};
