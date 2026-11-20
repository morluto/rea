/** CP437 characters for bytes 0x80-0xFF. */
const CP437_HIGH_HALF =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00A0";

/**
 * Decode a legacy ZIP name with the Unicode CP437 mapping, which Python's
 * zipfile also uses: bytes below 0x80 are ASCII. zip.js shows 0x01-0x1F and
 * 0x7F as IBM PC display glyphs, which turns the macOS folder icon file
 * `Icon\r` into `Icon♪`.
 */
export const decodeZipCp437 = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) =>
    byte < 0x80
      ? String.fromCharCode(byte)
      : CP437_HIGH_HALF.charAt(byte - 0x80),
  ).join("");
