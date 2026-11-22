import { ParseFailureError } from "./parseFailure.js";
import { err, ok, type Result } from "./result.js";

/**
 * An XML plist `<data>` literal that cannot be decoded. A missing source
 * location means this decoder cannot read the literal; the other reasons are
 * malformed content.
 */
export class XmlPlistDataError extends ParseFailureError<
  "malformed" | "unsupported"
> {
  constructor(
    readonly reason:
      | "non-ascii"
      | "markup"
      | "empty-element"
      | "source-location",
    /** UTF-16 offset within the raw data literal, when known. */
    readonly characterOffset: number | null = null,
  ) {
    const detail = `Cannot decode XML plist <data>: ${reason}`;
    super(
      reason === "source-location"
        ? {
            kind: "unsupported",
            format: "xml-plist",
            detail,
            field: "data",
            undecodedContent: true,
          }
        : { kind: "malformed", format: "xml-plist", detail, field: "data" },
    );
    this.name = "XmlPlistDataError";
  }
}

const BASE64_DIGITS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CODE_OTHER = -1;
const CODE_WHITESPACE = -2;
const CODE_PAD = -3;
const BASE64_ASCII_TABLE = (() => {
  const table = new Int8Array(128).fill(CODE_OTHER);
  for (let index = 0; index < BASE64_DIGITS.length; index += 1)
    table[BASE64_DIGITS.charCodeAt(index)] = index;
  table[0x20] = CODE_WHITESPACE; // ' '
  table[0x09] = CODE_WHITESPACE; // '\t'
  table[0x0a] = CODE_WHITESPACE; // '\n'
  table[0x0b] = CODE_WHITESPACE; // '\v'
  table[0x0c] = CODE_WHITESPACE; // '\f'
  table[0x0d] = CODE_WHITESPACE; // '\r'
  table[0x3d] = CODE_PAD; // '='
  return table;
})();

/** CFPropertyList reads raw ASCII, skips nonalphabet bytes and emits complete quartets. */
export const decodeXmlPlistData = (
  text: string,
): Result<Uint8Array, XmlPlistDataError> => {
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let offset = 0;
  let quartet = 0;
  let digits = 0;
  let padding = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 128) return err(new XmlPlistDataError("non-ascii", index));
    const entry = BASE64_ASCII_TABLE[code]!;
    let digit: number;
    if (entry === CODE_PAD) {
      padding += 1;
      digit = 0;
    } else if (entry === CODE_WHITESPACE) {
      continue;
    } else if (entry === CODE_OTHER) {
      padding = 0;
      continue;
    } else {
      padding = 0;
      digit = entry;
    }
    quartet = ((quartet << 6) | digit) & 0xffffff;
    digits += 1;
    if ((digits & 3) === 0) {
      bytes[offset++] = quartet >> 16;
      if (padding < 2) bytes[offset++] = quartet >> 8;
      if (padding === 0) bytes[offset++] = quartet;
    }
  }
  // A small decoded value must not retain a large ignored source literal.
  if (offset < bytes.length / 2) return ok(bytes.slice(0, offset));
  return ok(bytes.subarray(0, offset));
};
