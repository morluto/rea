import {
  decodeElfCompressedSection,
  readElfCompressedSectionHeader,
  type ElfCompressedSectionHeader,
  type ElfCompressedSectionResult,
} from "./elfCompressedSection.js";

const SUBJECT = "ELF compressed section-name table";

/** Read the same compression framing the decoder admits, before applying caller budgets. */
export const readElfSectionNameTableHeader = (
  bytes: Buffer,
  flags: bigint,
  bits: 32 | 64,
  little: boolean,
): ElfCompressedSectionHeader =>
  readElfCompressedSectionHeader(bytes, flags, bits, little, SUBJECT);

/** Decode section names through the shared ELF compressed-section owner. */
export const decodeElfSectionNameTable = (
  bytes: Buffer,
  flags: bigint,
  bits: 32 | 64,
  little: boolean,
  maximumDecodedBytes: number,
): ElfCompressedSectionResult =>
  decodeElfCompressedSection(
    bytes,
    flags,
    bits,
    little,
    maximumDecodedBytes,
    SUBJECT,
  );
