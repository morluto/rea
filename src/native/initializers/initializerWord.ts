import type { BinaryReader } from "../../domain/binaryContainer.js";

/** An initializer slot with no complete file-backed word has no stored value. */
export const readInitializerWord = (
  reader: BinaryReader,
  offset: number | null,
  bits: 32 | 64,
): bigint | null =>
  offset === null || offset < 0 || offset > reader.bytes.length - bits / 8
    ? null
    : reader.word(offset, bits);
