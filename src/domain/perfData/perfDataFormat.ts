const MAGIC = "PERFILE2";
const MAGIC_BYTES = Buffer.from(MAGIC, "latin1");
const SWAPPED_MAGIC = Buffer.from(MAGIC_BYTES).reverse();

/** Byte order written by the recording host, or null for any other signature. */
export const perfDataByteOrder = (bytes: Buffer): boolean | null => {
  const prefix = bytes.subarray(0, MAGIC_BYTES.length);
  if (prefix.equals(MAGIC_BYTES)) return true;
  return prefix.equals(SWAPPED_MAGIC) ? false : null;
};

export const hasPerfDataMagic = (bytes: Buffer): boolean =>
  perfDataByteOrder(bytes) !== null;

export const hasTruncatedPerfDataMagic = (bytes: Buffer): boolean =>
  bytes.length < MAGIC_BYTES.length &&
  [MAGIC_BYTES, SWAPPED_MAGIC].some((spell) =>
    bytes.equals(spell.subarray(0, bytes.length)),
  );
