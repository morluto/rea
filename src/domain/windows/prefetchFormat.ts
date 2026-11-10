import { err, ok, type Result } from "../result.js";

/**
 * A Prefetch file starts with a four-byte ASCII version tag and a "S"
 * signature. 17 is Windows XP/2003, 23 Windows Vista/7; 26 and 30/31 are
 * Windows 8+ files, which are MAM-compressed as a whole.
 */
const SUPPORTED_VERSIONS = ["17", "23", "26", "30", "31"] as const;
export type PrefetchVersion = (typeof SUPPORTED_VERSIONS)[number];

/** Versions whose fixed header this reader parses. */
export type ParsedPrefetchVersion = "17" | "23";

/** The version tag occupies four bytes and the signature follows it. */
const TAG_BYTES = 4;
const SIGNATURE_OFFSET = 4;
const PREFETCH_SIGNATURE = 0x53; // "S"
/** MSCF begins at the same offset on a compressed Prefetch file. */
const MAM_MAGIC = [0x4d, 0x53, 0x43, 0x46];

/** Common header: tag, signature, unknown, file size, name, hash, unknown. */
const COMMON_HEADER_BYTES = 84;
const FILE_SIZE_OFFSET = 0x0c;
const EXECUTABLE_NAME_OFFSET = 0x10;
const EXECUTABLE_NAME_BYTES = 60;
const EXECUTABLE_HASH_OFFSET = 0x4c;
/** v23 header: 84 common bytes plus "unknown2", file information, volumes, run times. */
const V23_HEADER_BYTES = 128;
const V23_FILE_INFORMATION_OFFSET = 0x54;
const V23_VOLUMES_OFFSET = 0x5c;
const V23_VOLUME_COUNT = 0x64;
const V23_RUN_TIMES_OFFSET = 0x6c;
const V23_RUN_TIMES_SIZE = 0x70;
const V23_RUN_COUNT = 0x84;

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
  if (bytes.length < TAG_BYTES) return null;
  const tag = String.fromCharCode(
    bytes[0]!,
    bytes[1]!,
    bytes[2]!,
    bytes[3]!,
  ).trimEnd();
  return (SUPPORTED_VERSIONS as readonly string[]).includes(tag)
    ? (tag as PrefetchVersion)
    : null;
};

/**
 * Whether the first bytes carry a Prefetch version tag and "S" signature. The
 * tag is four ASCII bytes and the signature follows them, so this probe never
 * depends on the file's name.
 */
export const hasPrefetchSignature = (prefix: Uint8Array): boolean =>
  readVersionTag(prefix) !== null &&
  prefix.length > SIGNATURE_OFFSET &&
  prefix[SIGNATURE_OFFSET] === PREFETCH_SIGNATURE;

const isMamContainer = (bytes: Uint8Array): boolean =>
  bytes.length >= SIGNATURE_OFFSET + MAM_MAGIC.length &&
  MAM_MAGIC.every((value, index) => bytes[SIGNATURE_OFFSET + index] === value);

/** Prefetch header fields are little-endian. */
const u32 = (view: DataView, offset: number, end: number): number | null =>
  offset + 4 <= end ? view.getUint32(offset, true) : null;

const asciiName = (bytes: Uint8Array): string | null => {
  const nul = bytes.indexOf(0);
  const text = Buffer.from(nul < 0 ? bytes : bytes.subarray(0, nul)).toString(
    "latin1",
  );
  return text.length === 0 ? null : text;
};

const hexHash = (value: number | null): string | null =>
  value === null ? null : value.toString(16).padStart(8, "0");

const NOT_DECODED_LIMITATION =
  "This reader reports the Prefetch header only. Last-run times, volumes and the read-ahead file list are not decoded, so executions recorded by those fields remain unknown.";

export const parsePrefetchFile = (
  bytes: Uint8Array,
): Result<PrefetchMetadata, PrefetchDecodeFailure> => {
  if (bytes.length > PREFETCH_MAX_FILE_BYTES)
    return err({
      kind: "limit",
      message: `The file exceeds the ${String(PREFETCH_MAX_FILE_BYTES)}-byte Prefetch allowance.`,
    });
  const version = readVersionTag(bytes);
  if (version === null)
    return err({ kind: "format", message: "No Prefetch version tag." });
  // A compressed file carries "MSCF" where an uncompressed one writes "S".
  if (isMamContainer(bytes))
    return err({
      kind: "unsupported",
      message: `Prefetch v${version} is MAM-compressed, and this reader does not decode that container.`,
    });
  if (!hasPrefetchSignature(bytes))
    return err({
      kind: "format",
      message: "The Prefetch signature byte is not 'S'.",
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
  const executableName = asciiName(
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
  let runTimeSlots: number | null = null;
  if (version === "23") {
    if (end < V23_HEADER_BYTES)
      limitations.push(
        "The file ends inside the v23 header, so run totals are unknown.",
      );
    else {
      runCount = u32(view, V23_RUN_COUNT, end);
      const size = u32(view, V23_RUN_TIMES_SIZE, end);
      if (size === null || size % 8 !== 0)
        limitations.push(
          "The declared last-run array size is not a whole number of eight-byte slots, so its length is unknown.",
        );
      else runTimeSlots = size / 8;
    }
  } else
    limitations.push(
      "v17 headers do not report a run count, so execution totals are unknown.",
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
