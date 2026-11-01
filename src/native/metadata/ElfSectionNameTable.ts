import {
  decodeElfCompressedSection,
  type ElfCompressedSectionResult,
} from "./ElfCompressedSection.js";

export type ElfSectionNameTableResult = ElfCompressedSectionResult;

const SUBJECT = "ELF compressed section-name table";

/** Decode the ELF section-name table once for consumers that need its names. */
export const decodeElfSectionNameTable = (
  bytes: Buffer,
  flags: bigint,
  bits: 32 | 64,
  little: boolean,
  maximumDecodedBytes: number,
): ElfSectionNameTableResult =>
  decodeElfCompressedSection(
    bytes,
    flags,
    bits,
    little,
    maximumDecodedBytes,
    SUBJECT,
  );
