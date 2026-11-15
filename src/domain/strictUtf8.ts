import { isUtf8 } from "node:buffer";

/**
 * What a strict UTF-8 decode does with one leading byte order mark.
 *
 * - `preserve` keeps it as U+FEFF, so the text matches the caller's bytes and
 *   offsets. Use it for every input where the BOM is content or cannot occur.
 * - `strip-signature` drops it, for user-authored text formats that allow the
 *   BOM as an encoding signature (for example a JSON or mapping file saved by
 *   an editor). Each such site states why.
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

/** Whether the bytes are well-formed UTF-8, without building the string. */
export const isStrictUtf8 = (bytes: Uint8Array): boolean => isUtf8(bytes);
