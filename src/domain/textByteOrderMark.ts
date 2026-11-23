/**
 * The wide Unicode encoding a byte order mark declares, or null when there is
 * none. UTF-32 is reported apart because no consumer decodes it, and it is
 * checked first because its little-endian mark begins with UTF-16's.
 */
export const byteOrderMarkEncoding = (
  bytes: Uint8Array,
): "utf-16le" | "utf-16be" | "utf-32" | null => {
  if (
    (bytes[0] === 0xff &&
      bytes[1] === 0xfe &&
      bytes[2] === 0 &&
      bytes[3] === 0) ||
    (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)
  )
    return "utf-32";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
};
