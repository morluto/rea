import { err, ok, type Result } from "../result.js";

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
/** A MAM-compressed container replaces the whole header with "MAM" and a header size. */
const MAM_MAGIC = Buffer.from("MAM", "ascii");
const MAM_HEADER_BYTES = MAM_MAGIC.length + 4;

/** Common header: generation, signature, unknown, file size, name, hash, flags. */
const COMMON_HEADER_BYTES = 84;
const FILE_SIZE_OFFSET = 0x0c;
const EXECUTABLE_NAME_OFFSET = 0x10;
const EXECUTABLE_NAME_BYTES = 60;
const EXECUTABLE_HASH_OFFSET = 0x4c;

/**
 * File information follows the common header: a 12-byte metrics array at 0x54,
 * the FILETIME of the last run, then the run count. Version 23 appends a
 * directory strings array, which moves its FILETIME eight bytes later than
 * version 17's; the run count stays put.
 */
const RUN_TIME_OFFSETS: Readonly<Record<ParsedPrefetchVersion, number>> = {
  "17": 0x78,
  "23": 0x80,
};
const RUN_COUNT_OFFSET = 0x98;

/** One FILETIME slot occupies eight bytes; its value is not decoded. */
const RUN_TIME_SLOT_BYTES = 8;

/** Refuse to hold a whole Prefetch file above this size. */
export const PREFETCH_MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface PrefetchMetadata {
  readonly version: ParsedPrefetchVersion;
  /** Bytes the file holds. */
  readonly fileBytes: number;
  /** Bytes the header declares, or null when that field is unreadable. */
  readonly declaredFileBytes: number | null;
  /** The NUL-terminated executable name, exactly as recorded. */
  readonly executableName: string | null;
  /** The recorded name-hash, as lowercase hexadecimal, or null. */
  readonly executablePathHash: string | null;
  /** Declared number of recorded runs; v17 files do not report one. */
  readonly runCount: number | null;
  /** Declared count of last-run timestamp slots; the times themselves are not decoded. */
  readonly runTimeSlots: number | null;
  readonly limitations: readonly string[];
}

export interface PrefetchDecodeFailure {
  readonly kind: "format" | "limit" | "unsupported";
  readonly message: string;
}

const readVersionTag = (bytes: Uint8Array): PrefetchVersion | null => {
  if (bytes.length < VERSION_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = String(view.getUint32(0, true));
  return (SUPPORTED_VERSIONS as readonly string[]).includes(tag)
    ? (tag as PrefetchVersion)
    : null;
};

/**
 * Whether the first bytes carry a Prefetch generation and its "SCCA"
 * signature. Recognition never depends on the file's name.
 */
export const hasPrefetchSignature = (prefix: Uint8Array): boolean =>
  readVersionTag(prefix) !== null &&
  prefix.length >= SIGNATURE_OFFSET + SIGNATURE.length &&
  Buffer.from(
    prefix.subarray(SIGNATURE_OFFSET, SIGNATURE_OFFSET + SIGNATURE.length),
  ).equals(SIGNATURE);

/**
 * A MAM container starts at offset 0 with "MAM", an uncompressed Prefetch file
 * with its generation DWORD, so the two cannot be confused.
 */
export const isMamContainer = (bytes: Uint8Array): boolean =>
  bytes.length >= MAM_MAGIC.length &&
  Buffer.from(bytes.subarray(0, MAM_MAGIC.length)).equals(MAM_MAGIC);

/** Prefetch header fields are little-endian. */
const u32 = (view: DataView, offset: number, end: number): number | null =>
  offset + 4 <= end ? view.getUint32(offset, true) : null;

/** The executable name is a NUL-terminated UTF-16LE string in a 60-byte field. */
const utf16Name = (bytes: Uint8Array): string | null => {
  let end = 0;
  while (end + 1 < bytes.length && (bytes[end] !== 0 || bytes[end + 1] !== 0))
    end += 2;
  const text = Buffer.from(bytes.subarray(0, end)).toString("utf16le");
  return text.length === 0 ? null : text;
};

const hexHash = (value: number | null): string | null =>
  value === null ? null : value.toString(16).padStart(8, "0");

const NOT_DECODED_LIMITATION =
  "This reader reports the executable name, its name hash, the declared file size, the recorded run count and whether a last-run timestamp is present. The timestamp value, the volume list and the read-ahead file list are not decoded; their contents remain unknown.";

export const parsePrefetchFile = (
  bytes: Uint8Array,
): Result<PrefetchMetadata, PrefetchDecodeFailure> => {
  if (bytes.length > PREFETCH_MAX_FILE_BYTES)
    return err({
      kind: "limit",
      message: `The file exceeds the ${String(PREFETCH_MAX_FILE_BYTES)}-byte Prefetch allowance.`,
    });
  // A MAM container replaces the header entirely, so it has no generation. The
  // signature alone does not make a container: a file that ends inside the
  // fixed MAM header is truncated, not an intact unimplemented format.
  if (isMamContainer(bytes)) {
    if (bytes.length < MAM_HEADER_BYTES)
      return err({
        kind: "format",
        message: "The file ends inside the MAM container header.",
      });
    return err({
      kind: "unsupported",
      message:
        "The file is a MAM-compressed container, and this reader does not decode that container.",
    });
  }
  const version = readVersionTag(bytes);
  if (version === null)
    return err({ kind: "format", message: "No Prefetch generation." });
  if (!hasPrefetchSignature(bytes))
    return err({
      kind: "format",
      message: 'The Prefetch signature is not "SCCA".',
    });
  if (version !== "17" && version !== "23")
    return err({
      kind: "unsupported",
      message: `Prefetch v${version} is not one of the header generations this reader parses (17, 23).`,
    });
  if (bytes.length < COMMON_HEADER_BYTES)
    return err({
      kind: "format",
      message: "The file ends inside the Prefetch header.",
    });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength;
  const limitations: string[] = [];
  const declaredFileBytes = u32(view, FILE_SIZE_OFFSET, end);
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
  if (declaredFileBytes !== null && declaredFileBytes !== bytes.length)
    limitations.push(
      `The header declares ${String(declaredFileBytes)} bytes but the file holds ${String(bytes.length)}.`,
    );
  let runCount: number | null = null;
  // The last-run FILETIME sits at a generation-specific offset, so a capture
  // that ends inside the metrics array has no run time to report yet.
  const runTimeSlots: number | null =
    end >= RUN_TIME_OFFSETS[version] + RUN_TIME_SLOT_BYTES ? 1 : null;
  // The run count sits at the same offset in both generations; only its
  // presence depends on the file reaching the end of the file-information
  // block.
  if (end < RUN_COUNT_OFFSET + 4)
    limitations.push(
      "The file ends before the run count field, so the recorded run total is unknown.",
    );
  else runCount = u32(view, RUN_COUNT_OFFSET, end);
  if (runTimeSlots === null)
    limitations.push(
      "The file ends before the last-run timestamp, so no run time is reported.",
    );
  limitations.push(NOT_DECODED_LIMITATION);
  return ok({
    version,
    fileBytes: bytes.length,
    declaredFileBytes,
    executableName,
    executablePathHash: hexHash(u32(view, EXECUTABLE_HASH_OFFSET, end)),
    runCount,
    runTimeSlots,
    limitations,
  });
};
