import { ParseFailureError } from "./parseFailure.js";
import { byteOrderMarkEncoding } from "./textByteOrderMark.js";
import { strictUtf8Decoder } from "./strictUtf8.js";

const XML_PLIST_FORMAT = "xml-plist";
const MAX_DECLARED_ENCODING_CHARS = 64;

/**
 * XML plist text that cannot be decoded. An unsupported encoding holds text
 * this decoder cannot read; invalid bytes and a contradicted declaration are
 * malformed.
 */
export class XmlPlistTextDecodeError extends ParseFailureError<
  "malformed" | "unsupported"
> {
  constructor(
    readonly reason:
      | "invalid-bytes"
      | "unsupported-encoding"
      | "encoding-mismatch",
    message: string,
    readonly declaredEncoding?: string,
    options?: ErrorOptions,
  ) {
    super(
      reason === "unsupported-encoding"
        ? {
            kind: "unsupported",
            format: XML_PLIST_FORMAT,
            detail: message,
            undecodedContent: true,
          }
        : { kind: "malformed", format: XML_PLIST_FORMAT, detail: message },
      options,
    );
    this.name = "XmlPlistTextDecodeError";
  }
}

const XML_PLIST_DECODERS = {
  "utf-8": strictUtf8Decoder("strip-signature"),
  "utf-16le": new TextDecoder("utf-16le", { fatal: true }),
  "utf-16be": new TextDecoder("utf-16be", { fatal: true }),
} as const;

export type SupportedXmlPlistEncoding = "utf-8" | "utf-16le" | "utf-16be";

/** Detected encoding facts reusable by the final decode step without rescanning bytes. */
export interface XmlPlistTextEncodingInspection {
  readonly encoding: SupportedXmlPlistEncoding;
  readonly declarationVerified: boolean;
}

const hasUtf8Bom = (bytes: Uint8Array): boolean =>
  bytes.length >= 3 &&
  bytes[0] === 0xef &&
  bytes[1] === 0xbb &&
  bytes[2] === 0xbf;

const isAsciiWhitespace = (code: number): boolean =>
  code === 0x20 || (code >= 0x09 && code <= 0x0d);

const isAsciiWord = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x5f;

const XML_DECL_PREFIX = [0x3c, 0x3f, 0x78, 0x6d, 0x6c] as const; // <?xml
const ENCODING_ATTR = [0x65, 0x6e, 0x63, 0x6f, 0x64, 0x69, 0x6e, 0x67] as const; // encoding

/**
 * Scan the XML declaration's encoding attribute directly from bytes without
 * allocating a string for the declaration. Supports UTF-8 (optional BOM) and
 * BOM-marked UTF-16LE/UTF-16BE.
 */
const scanXmlDeclarationEncoding = (
  bytes: Uint8Array,
  encoding: SupportedXmlPlistEncoding,
): { readonly complete: boolean; readonly declared?: string } => {
  const utf8 = encoding === "utf-8";
  const byteStart = utf8 ? (hasUtf8Bom(bytes) ? 3 : 0) : 2;
  const stride = utf8 ? 1 : 2;
  const count = Math.floor(Math.max(0, bytes.length - byteStart) / stride);
  if (count < XML_DECL_PREFIX.length + 3) return { complete: false };
  const codeAt = (index: number): number => {
    const at = byteStart + index * stride;
    if (utf8) return bytes[at]!;
    return encoding === "utf-16le"
      ? bytes[at]! | (bytes[at + 1]! << 8)
      : (bytes[at]! << 8) | bytes[at + 1]!;
  };
  for (let index = 0; index < XML_DECL_PREFIX.length; index += 1)
    if (codeAt(index) !== XML_DECL_PREFIX[index]) return { complete: false };
  if (!isAsciiWhitespace(codeAt(XML_DECL_PREFIX.length)))
    return { complete: false };

  let declared: string | undefined;
  let seenQuestion = false;
  let cursor = XML_DECL_PREFIX.length + 1;
  while (cursor < count) {
    const code = codeAt(cursor);
    if (utf8 && code > 0x7f) return { complete: false };
    if (code === 0x3f) {
      if (cursor + 1 < count && codeAt(cursor + 1) === 0x3e)
        return declared === undefined
          ? { complete: true }
          : { complete: true, declared };
      seenQuestion = true;
      cursor += 1;
      continue;
    }
    if (
      !seenQuestion &&
      declared === undefined &&
      code === ENCODING_ATTR[0] &&
      !isAsciiWord(codeAt(cursor - 1)) &&
      cursor + ENCODING_ATTR.length <= count
    ) {
      let matched = true;
      for (let offset = 1; offset < ENCODING_ATTR.length; offset += 1)
        if (codeAt(cursor + offset) !== ENCODING_ATTR[offset]) {
          matched = false;
          break;
        }
      if (matched) {
        let probe = cursor + ENCODING_ATTR.length;
        while (probe < count && isAsciiWhitespace(codeAt(probe))) probe += 1;
        if (probe >= count) return { complete: false };
        if (codeAt(probe) !== 0x3d) {
          cursor = probe;
          continue;
        }
        probe += 1;
        while (probe < count && isAsciiWhitespace(codeAt(probe))) probe += 1;
        if (probe >= count) return { complete: false };
        const quote = codeAt(probe);
        if (quote !== 0x22 && quote !== 0x27) {
          cursor = probe;
          continue;
        }
        probe += 1;
        const valueStart = probe;
        let value = "";
        let truncated = false;
        let sawQuestionInValue = false;
        while (probe < count) {
          const ch = codeAt(probe);
          if (utf8 && ch > 0x7f) return { complete: false };
          if (ch === quote) break;
          if (ch === 0x22 || ch === 0x27) break;
          if (ch === 0x3f) {
            if (probe + 1 < count && codeAt(probe + 1) === 0x3e)
              return { complete: true };
            sawQuestionInValue = true;
          }
          if (value.length < MAX_DECLARED_ENCODING_CHARS)
            value += String.fromCharCode(ch);
          else truncated = true;
          probe += 1;
        }
        if (probe >= count) return { complete: false };
        if (codeAt(probe) === quote && probe > valueStart) {
          declared = truncated ? `${value}...` : value;
          cursor = probe + 1;
          continue;
        }
        if (sawQuestionInValue) seenQuestion = true;
        cursor = probe + 1;
        continue;
      }
    }
    cursor += 1;
  }
  return { complete: false };
};

/** Inspect XML plist BOM and declaration encoding directly from bytes without decoding the declaration. */
export const inspectXmlPlistTextEncoding = (
  bytes: Uint8Array,
): XmlPlistTextEncodingInspection => {
  const marked = byteOrderMarkEncoding(bytes);
  if (marked === "utf-32")
    throw new XmlPlistTextDecodeError(
      "unsupported-encoding",
      "Unsupported XML encoding: UTF-32. Supported encodings are UTF-8 and BOM-marked UTF-16 in either byte order.",
      "UTF-32",
    );
  const encoding = marked ?? "utf-8";
  const prolog = scanXmlDeclarationEncoding(bytes, encoding);
  if (prolog.complete) {
    verifyEncodingDeclaration(prolog.declared, encoding);
    return { encoding, declarationVerified: true };
  }
  return { encoding, declarationVerified: false };
};

/** Mathematically guaranteed lower bound on decoded UTF-16 code units. */
export const minimumXmlPlistCodeUnits = (
  encoding: SupportedXmlPlistEncoding,
  bytes: Uint8Array,
): number => {
  if (encoding === "utf-8") {
    const bom = hasUtf8Bom(bytes) ? 3 : 0;
    // 1..3 UTF-8 bytes yield 1 UTF-16 code unit; 4 UTF-8 bytes yield 2 (ratio 1/2 > 1/3).
    return Math.floor(Math.max(0, bytes.length - bom) / 3);
  }
  return Math.floor(Math.max(0, bytes.length - 2) / 2);
};

/** Decode BOM-aware XML plist text, reusing prior encoding inspection when supplied. */
export const decodeXmlPlistText = (
  bytes: Uint8Array,
  inspected?: XmlPlistTextEncodingInspection,
): string => {
  const { encoding, declarationVerified } =
    inspected ?? inspectXmlPlistTextEncoding(bytes);
  let text: string;
  try {
    text = XML_PLIST_DECODERS[encoding].decode(bytes);
  } catch (cause: unknown) {
    throw new XmlPlistTextDecodeError(
      "invalid-bytes",
      "XML text bytes are invalid for the detected encoding",
      undefined,
      { cause },
    );
  }
  if (!declarationVerified)
    verifyEncodingDeclaration(declaredEncoding(text), encoding);
  return text;
};

const declaredEncoding = (text: string): string | undefined =>
  /^<\?xml\s[^?]*\bencoding\s*=\s*(["'])([^"']+)\1/u.exec(text)?.[2];

const verifyEncodingDeclaration = (
  declaration: string | undefined,
  encoding: string,
): void => {
  const declared = declaration?.toLowerCase();
  if (
    declared !== undefined &&
    !["utf-8", "utf-16", "utf-16le", "utf-16be"].includes(declared)
  )
    throw new XmlPlistTextDecodeError(
      "unsupported-encoding",
      `Unsupported XML encoding declaration: ${declaration}. Supported encodings are UTF-8 and BOM-marked UTF-16 in either byte order.`,
      declaration,
    );
  if (
    declared !== undefined &&
    declared !== encoding &&
    !(encoding !== "utf-8" && declared === "utf-16")
  )
    throw new XmlPlistTextDecodeError(
      "encoding-mismatch",
      "XML encoding declaration disagrees with its bytes",
      declaration,
    );
};
