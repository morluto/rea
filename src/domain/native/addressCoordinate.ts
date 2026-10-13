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
