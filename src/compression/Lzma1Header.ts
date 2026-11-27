import { BinaryReader } from "../domain/binaryContainer.js";
import {
  checkLzma1AloneHeader,
  LZMA1_DICTIONARY_OFFSET,
  LZMA1_SIZE_OFFSET,
  lzma1AloneHeader,
  type Lzma1AloneHeader,
  type Lzma1Refusal,
} from "./Lzma1.js";

/**
 * Decode an LZMA-Alone header once, at the host boundary. `Lzma1.ts` stays
 * free of repository imports so a worker thread can load it; the numeric
 * fields are read here with the shared BinaryReader and handed to it.
 */
export const readLzma1AloneHeader = (
  alone: Buffer,
): Lzma1AloneHeader | Lzma1Refusal => {
  const invalid = checkLzma1AloneHeader(alone);
  if (invalid !== undefined) return invalid;
  const reader = new BinaryReader(alone, true, "LZMA-Alone");
  return lzma1AloneHeader(
    reader.u32(LZMA1_DICTIONARY_OFFSET),
    reader.word(LZMA1_SIZE_OFFSET, 64),
  );
};
