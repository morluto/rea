import {
  decodeElfCompressedSection,
  decodeElfCompressedSectionCooperative,
  readElfCompressedSectionHeader,
  type ElfCompressedSectionHeader,
  type ElfCompressedSectionResult,
} from "./elfCompressedSection.js";
import type { ZstandardFramePause } from "../compression/zstandardExactFrame.js";

const SUBJECT = "ELF compressed section-name table";

/** Read the same compression framing the decoder admits, before applying caller budgets. */
export const readElfSectionNameTableHeader = (
  bytes: Buffer,
  flags: bigint,
  bits: 32 | 64,
  little: boolean,
): ElfCompressedSectionHeader =>
  readElfCompressedSectionHeader(bytes, flags, bits, little, SUBJECT);

/** One section-name table a directory or note driver asks the owner to decode. */
export interface ElfSectionNameDecodeRequest {
  readonly raw: Buffer;
  readonly flags: bigint;
  readonly bits: 32 | 64;
  readonly little: boolean;
  readonly maximumDecodedBytes: number;
}

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

/** Cooperative section-name decode. `pause` observes the caller's abort signal. */
export const decodeElfSectionNameTableCooperative = (
  bytes: Buffer,
  flags: bigint,
  bits: 32 | 64,
  little: boolean,
  maximumDecodedBytes: number,
  pause: ZstandardFramePause,
): Promise<ElfCompressedSectionResult> =>
  decodeElfCompressedSectionCooperative(
    bytes,
    flags,
    bits,
    little,
    maximumDecodedBytes,
    SUBJECT,
    pause,
  );

export const decodeElfSectionNameRequest = (
  request: ElfSectionNameDecodeRequest,
): ElfCompressedSectionResult =>
  decodeElfSectionNameTable(
    request.raw,
    request.flags,
    request.bits,
    request.little,
    request.maximumDecodedBytes,
  );

export const decodeElfSectionNameRequestCooperative = (
  request: ElfSectionNameDecodeRequest,
  pause: ZstandardFramePause,
): Promise<ElfCompressedSectionResult> =>
  decodeElfSectionNameTableCooperative(
    request.raw,
    request.flags,
    request.bits,
    request.little,
    request.maximumDecodedBytes,
    pause,
  );
