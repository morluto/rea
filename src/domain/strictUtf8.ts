import { isUtf8 } from "node:buffer";

/**
 * What a strict UTF-8 decode does with one leading byte order mark.
 *
 * - `strip-signature` drops it as an encoding signature. This is the WHATWG
 *   decoder default, so it is what a plain `{ fatal: true }` decoder did.
 * - `preserve` keeps it as U+FEFF, so the text matches the caller's bytes and
 *   offsets (`ignoreBOM: true`). Use it where a leading U+FEFF is content.
 *
 * Changing a site's policy changes what its consumers see (for example an
 * exact-value secret match or a JSON parser that rejects U+FEFF), so a change
 * needs a regression test at that consumer.
 */
export type Utf8BomPolicy = "preserve" | "strip-signature";

/**
 * A fatal UTF-8 decoder with an explicit BOM policy. It throws a TypeError on
 * malformed bytes. Callers that pass `{ stream: true }` need their own
 * instance, so this returns a new decoder each call.
 */
export const strictUtf8Decoder = (bom: Utf8BomPolicy): TextDecoder =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: bom === "preserve" });

const preserving = strictUtf8Decoder("preserve");
const stripping = strictUtf8Decoder("strip-signature");

/** Decode complete UTF-8 bytes; malformed input throws a TypeError. */
export const decodeStrictUtf8 = (
  bytes: Uint8Array,
  bom: Utf8BomPolicy,
): string => (bom === "preserve" ? preserving : stripping).decode(bytes);

/** Preserve a leading BOM as field data and return null on invalid UTF-8. */
export const decodeUtf8PreservingBomOrNull = (
  bytes: Uint8Array,
): string | null => {
  try {
    return decodeStrictUtf8(bytes, "preserve");
  } catch {
    return null;
  }
};

/** Whether the bytes are well-formed UTF-8, without building the string. */
export const isStrictUtf8 = (bytes: Uint8Array): boolean => isUtf8(bytes);
