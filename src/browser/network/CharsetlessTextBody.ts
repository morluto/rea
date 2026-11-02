import { createHash } from "node:crypto";
import { mediaTypeEssence } from "../../domain/analysisView/recordedMediaType.js";

/** Visible record of a charset inference applied to a response body. */
export interface CharsetlessTextRecovery {
  readonly declared_charset: null;
  readonly decoded_as: "utf-8";
  readonly method: "reversed-windows-1252-decode";
  readonly observed_bytes: number;
  readonly observed_sha256: string;
}

const CHARSET_PARAMETER = /;\s*charset\s*=/iu;

/** windows-1252 (WHATWG) maps all 256 bytes, the five undefined ones to C1 controls, so the map inverts exactly. */
const windows1252Bytes = ((): ReadonlyMap<string, number> => {
  const decoder = new TextDecoder("windows-1252");
  const map = new Map<string, number>();
  for (let byte = 0; byte < 256; byte += 1)
    map.set(decoder.decode(Uint8Array.of(byte)), byte);
  return map;
})();

/**
 * Chromium's DevTools returns a charset-less text response as a string it decoded
 * with a windows-1252 fallback, and Playwright's Response.body() re-encodes that
 * string as UTF-8, so UTF-8 wire bytes come back inflated. The wire bytes are not
 * exposed, so this inverts the decode, and only when the inverse is valid UTF-8
 * with multi-byte sequences; any other body is returned unchanged (`undefined`).
 * A declared charset, HTML (which sniffs its own encoding) and non-text types never match.
 */
export const recoverCharsetlessUtf8 = (
  observed: Buffer,
  contentType: string | undefined,
):
  | { readonly bytes: Buffer; readonly recovery: CharsetlessTextRecovery }
  | undefined => {
  if (contentType === undefined || CHARSET_PARAMETER.test(contentType))
    return undefined;
  const essence = mediaTypeEssence(contentType);
  if (
    essence === null ||
    !essence.startsWith("text/") ||
    essence === "text/html" ||
    essence === "text/xml"
  )
    return undefined;
  let nonAscii = false;
  for (const byte of observed)
    if (byte >= 0x80) {
      nonAscii = true;
      break;
    }
  if (!nonAscii) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      observed,
    );
  } catch {
    return undefined;
  }
  const raw = Buffer.allocUnsafe(text.length);
  let length = 0;
  for (const character of text) {
    const byte = windows1252Bytes.get(character);
    if (byte === undefined) return undefined;
    raw[length] = byte;
    length += 1;
  }
  const bytes = raw.subarray(0, length);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return undefined;
  }
  // Pure ASCII after inversion means the observed text was not a mis-decode.
  if (decoded.length === bytes.length) return undefined;
  return {
    bytes: Buffer.from(bytes),
    recovery: {
      declared_charset: null,
      decoded_as: "utf-8",
      method: "reversed-windows-1252-decode",
      observed_bytes: observed.length,
      observed_sha256: createHash("sha256").update(observed).digest("hex"),
    },
  };
};
