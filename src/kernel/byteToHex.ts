/**
 * Two lowercase hexadecimal digits for one byte value (0 to 255), with no
 * prefix. Callers add their own notation, such as `0x`, `%` or `\x`.
 */
export const byteToHex = (byte: number): string =>
  byte.toString(16).padStart(2, "0");
