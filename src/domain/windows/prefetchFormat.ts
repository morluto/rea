import type { Result } from "../result.js";
import { BinaryReader } from "../binaryContainer.js";
import {
  captureParseFailure,
  malformedInput,
  truncatedInput,
  unsupportedInput,
  type ParseFailureError,
} from "../parseFailure.js";
import { z } from "zod";

/**
 * An uncompressed Prefetch file starts with a little-endian DWORD generation
 * and the four-byte "SCCA" signature. 17 is Windows XP/2003, 23 Windows
 * Vista/7. v26 keeps the uncompressed layout on Windows 8/8.1; MAM wrapping
 * arrives with v30/31 (Windows 10+).
 */
const SUPPORTED_VERSIONS = ["17", "23", "26", "30", "31"] as const;
export type PrefetchVersion = (typeof SUPPORTED_VERSIONS)[number];

/** Versions whose fixed header this reader parses. */
export type ParsedPrefetchVersion = "17" | "23";

const VERSION_BYTES = 4;
const SIGNATURE_OFFSET = 4;
const SIGNATURE = Buffer.from("SCCA", "ascii");
const FORMAT = "windows-prefetch";
/** A MAM-compressed container replaces the whole header with "MAM" and a header size. */
const MAM_MAGIC = Buffer.from("MAM", "ascii");
// "MAM", the compression byte, and the uncompressed-size DWORD. The
// compression byte is required, not merely the magic: `hasMamMagic` already
// keys on it, so a capture shorter than this is a truncated container.
const MAM_HEADER_BYTES = MAM_MAGIC.length + 1 + 4;

/** Common header: generation, signature, unknown, file size, name, hash, flags. */
const COMMON_HEADER_BYTES = 84;
const FILE_SIZE_OFFSET = 0x0c;
const EXECUTABLE_NAME_OFFSET = 0x10;
const EXECUTABLE_NAME_BYTES = 60;
const EXECUTABLE_HASH_OFFSET = 0x4c;

/**
 * File information follows the common header at 0x54: the FILETIME of the last
 * run, then the run count. Version 23's file information is longer than version
 * 17's (156 bytes against 68), so both the FILETIME and the run count sit eight
 * bytes later. The run count is generation-specific; reading v17 at v23's
 * offset reports unrelated file-metrics bytes.
 */
const RUN_TIME_OFFSETS: Readonly<Record<ParsedPrefetchVersion, number>> = {
  "17": 0x78,
  "23": 0x80,
};
const RUN_COUNT_OFFSETS: Readonly<Record<ParsedPrefetchVersion, number>> = {
  "17": 0x90,
  "23": 0x98,
};

/** One FILETIME slot occupies eight bytes; its value is not decoded. */
const RUN_TIME_SLOT_BYTES = 8;

/**
 * Smallest capture that can report each run fact: the run count needs its DWORD
 * whole, and both the run count and the last-run FILETIME are generation-specific.
 */
export const PREFETCH_RUN_COUNT_BYTES: Readonly<
  Record<ParsedPrefetchVersion, number>
> = {
  "17": RUN_COUNT_OFFSETS["17"] + 4,
  "23": RUN_COUNT_OFFSETS["23"] + 4,
};
export const PREFETCH_RUN_TIME_BYTES: Readonly<
  Record<ParsedPrefetchVersion, number>
> = {
  "17": RUN_TIME_OFFSETS["17"] + RUN_TIME_SLOT_BYTES,
  "23": RUN_TIME_OFFSETS["23"] + RUN_TIME_SLOT_BYTES,
};

/** All supported header fields fit in the first 156 bytes. */
export const PREFETCH_HEADER_READ_BYTES = Math.max(
  ...Object.values(PREFETCH_RUN_COUNT_BYTES),
);

export interface PrefetchMetadata {
  readonly version: ParsedPrefetchVersion;
  /** Bytes the file holds. */
  readonly fileBytes: number;
  /** Bytes the header declares. The common header is required, so this is readable. */
  readonly declaredFileBytes: number;
  /** The NUL-terminated executable name, exactly as recorded. */
  readonly executableName: string | null;
  /** The recorded name-hash, as lowercase hexadecimal. The common header is
   * required, so the hash word is reachable and this is never null. */
  readonly executablePathHash: string;
  /** Declared number of recorded runs, if the capture reaches the field. */
  readonly runCount: number | null;
  /**
   * One last-run timestamp slot when the capture reaches it. The timestamp
   * itself is not decoded.
   */
  readonly runTimeSlots: 1 | null;
  readonly limitations: readonly string[];
}

/** Keep the exact range even when recognition receives a sliced view. */
const readerFor = (bytes: Uint8Array): BinaryReader =>
  new BinaryReader(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    true,
    FORMAT,
  );

const readVersionTag = (reader: BinaryReader): PrefetchVersion | null => {
  if (reader.bytes.length < VERSION_BYTES) return null;
  const tag = String(reader.u32(0));
  return (SUPPORTED_VERSIONS as readonly string[]).includes(tag)
    ? (tag as PrefetchVersion)
    : null;
};

/**
 * Whether the first bytes carry a Prefetch generation and its "SCCA"
 * signature. Recognition never depends on the file's name.
 */
export const hasPrefetchSignature = (prefix: Uint8Array): boolean => {
  const reader = readerFor(prefix);
  return readVersionTag(reader) !== null && hasScca(reader.bytes);
};

const hasScca = (bytes: Buffer): boolean =>
  bytes
    .subarray(SIGNATURE_OFFSET, SIGNATURE_OFFSET + SIGNATURE.length)
    .equals(SIGNATURE);

/**
 * A MAM container starts at offset 0 with "MAM" and the container version byte
 * the wrapper writes, an uncompressed Prefetch file with its version DWORD, so
 * the two cannot be confused. The three ASCII bytes alone are not enough: any
 * file whose first bytes spell "MAM" would otherwise acquire Prefetch
 * provenance from a header it does not carry.
 */
const MAM_VERSION_OFFSET = MAM_MAGIC.length;
/** The compression byte carries the algorithm in its low bits; the high bit is
 * an optional checksum flag, so the container is still XPRESS Huffman. */
const MAM_ALGORITHM_MASK = 0x7f;
const MAM_VERSION = 4;
/** Set alongside the checksum bytes the wrapper appends after the size. */
const MAM_CHECKSUM_FLAG = 0x80;
const MAM_CHECKSUM_BYTES = 4;
const hasMamMagic = (bytes: Uint8Array): boolean =>
  bytes.length > MAM_MAGIC.length &&
  Buffer.from(bytes.subarray(0, MAM_MAGIC.length)).equals(MAM_MAGIC) &&
  ((bytes[MAM_VERSION_OFFSET] ?? 0) & MAM_ALGORITHM_MASK) === MAM_VERSION;

/** Fixed bytes a container header holds before its payload, checksum included. */
const mamHeaderBytes = (bytes: Uint8Array): number =>
  MAM_HEADER_BYTES +
  (((bytes[MAM_VERSION_OFFSET] ?? 0) & MAM_CHECKSUM_FLAG) === 0
    ? 0
    : MAM_CHECKSUM_BYTES);

/**
 * Whether a prefix carries MAM ownership. The four-byte signature is enough:
 * a capture that ends inside the fixed header is a truncated container, and
 * `parsePrefetchHeader()` reports that truncation. Requiring the whole header
 * here would instead route it to executable parsing, where the reader's
 * "ends inside the MAM container header" failure is unreachable.
 */
export const hasMamSignature = hasMamMagic;

/**
 * The observed capture size comes from the verified file descriptor. The
 * common header must be present for a successful parse.
 */
export const prefetchFileBytesSchema = z
  .number()
  .int()
  .min(COMMON_HEADER_BYTES);

/** The executable name is a NUL-terminated UTF-16LE string in a 60-byte field. */
const utf16Name = (bytes: Buffer): string | null => {
  let end = 0;
  while (end + 1 < bytes.length && (bytes[end] !== 0 || bytes[end + 1] !== 0))
    end += 2;
  const text = bytes.toString("utf16le", 0, end);
  return text.length === 0 ? null : text;
};

/** The caller has already established that the common header is present. */
const hexHash = (value: number): string => value.toString(16).padStart(8, "0");

const NOT_DECODED_LIMITATION =
  "This reader reports the executable name, its name hash, the declared file size, the recorded run count and whether a last-run timestamp is present. The timestamp value, the volume list and the read-ahead file list are not decoded; their contents remain unknown.";

export const parsePrefetchHeader = (
  header: Uint8Array,
  fileBytes: number,
): Result<PrefetchMetadata, ParseFailureError> =>
  captureParseFailure(() => decodePrefetchHeader(readerFor(header), fileBytes));

const decodePrefetchHeader = (
  reader: BinaryReader,
  fileBytes: number,
): PrefetchMetadata => {
  const { bytes } = reader;
  // A MAM container replaces the header entirely, so it has no generation. The
  // signature alone does not make a container: a file that ends inside the
  // fixed MAM header is truncated, not an intact unimplemented format.
  if (hasMamMagic(bytes)) {
    const headerBytes = mamHeaderBytes(bytes);
    if (bytes.length < headerBytes)
      throw truncatedInput(
        FORMAT,
        "The file ends inside the MAM container header.",
        {
          extent: {
            availableBytes: bytes.length,
            requiredBytes: headerBytes,
          },
        },
      );
    throw unsupportedInput(
      FORMAT,
      "The file is a MAM-compressed container, and this reader does not decode that container.",
      { undecodedContent: true },
    );
  }
  const version = readVersionTag(reader);
  if (version === null) throw malformedInput(FORMAT, "No Prefetch generation.");
  if (!hasScca(bytes))
    throw malformedInput(FORMAT, 'The Prefetch signature is not "SCCA".');
  if (bytes.length < COMMON_HEADER_BYTES)
    throw truncatedInput(FORMAT, "The file ends inside the Prefetch header.", {
      extent: {
        availableBytes: bytes.length,
        requiredBytes: COMMON_HEADER_BYTES,
      },
    });
  if (version !== "17" && version !== "23")
    throw unsupportedInput(
      FORMAT,
      `Prefetch v${version} is not one of the header generations this reader parses (17, 23).`,
      { undecodedContent: true },
    );
  const end = bytes.byteLength;
  const limitations: string[] = [];
  // The common-header check above guarantees the DWORD at 0x0c is present, so a
  // successful parse always reports a declared size.
  const declaredFileBytes = reader.u32(FILE_SIZE_OFFSET);
  const executableName = utf16Name(
    bytes.subarray(
      EXECUTABLE_NAME_OFFSET,
      EXECUTABLE_NAME_OFFSET + EXECUTABLE_NAME_BYTES,
    ),
  );
  if (executableName === null)
    limitations.push(
      "The header records no executable name, so the recorded program is unknown.",
    );
  if (declaredFileBytes !== fileBytes)
    limitations.push(
      `The header declares ${String(declaredFileBytes)} bytes but the file holds ${String(fileBytes)}.`,
    );
  let runCount: number | null = null;
  // The last-run FILETIME sits at a generation-specific offset, so a capture
  // that ends inside the metrics array has no run time to report yet.
  const runTimeSlots: 1 | null =
    end >= PREFETCH_RUN_TIME_BYTES[version] ? 1 : null;
  // The run count is generation-specific, like the last-run FILETIME: version
  // 23's file information is longer, so both fields shift. A capture that ends
  // before the field has no run total to report.
  if (end < PREFETCH_RUN_COUNT_BYTES[version])
    limitations.push(
      "The file ends before the run count field, so the recorded run total is unknown.",
    );
  else runCount = reader.u32(RUN_COUNT_OFFSETS[version]);
  if (runTimeSlots === null)
    limitations.push(
      "The file ends before the last-run timestamp, so no run time is reported.",
    );
  limitations.push(NOT_DECODED_LIMITATION);
  return {
    version,
    fileBytes,
    declaredFileBytes,
    executableName,
    executablePathHash: hexHash(reader.u32(EXECUTABLE_HASH_OFFSET)),
    runCount,
    runTimeSlots,
    limitations,
  };
};
