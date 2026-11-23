import { crc32 } from "node:zlib";

import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
  unsupportedInput,
} from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";
import { isStrictUtf8 } from "../strictUtf8.js";

/**
 * Layouts are from Linux `include/uapi/mtd/ubi-media.h`. Every integer is
 * big-endian, and every header CRC is CRC-32 seeded with 0xFFFFFFFF without
 * the final inversion (`~crc32(bytes)` with zlib's CRC).
 *
 * Erase-counter header (64 bytes): magic "UBI#"=0, version=4, ec=8 (u64),
 * vid_hdr_offset=16, data_offset=20, image_seq=24, hdr_crc=60.
 * Volume-identifier header (64 bytes): magic "UBI!"=0, version=4,
 * vol_type=5, copy_flag=6, compat=7, vol_id=8, lnum=12, data_size=20,
 * used_ebs=24, data_pad=28, data_crc=32, sqnum=40 (u64), hdr_crc=60.
 * Volume table record (172 bytes): reserved_pebs=0, alignment=4,
 * data_pad=8, vol_type=12, upd_marker=13, name_len=14, name=16 (128 bytes),
 * flags=144, crc=168.
 */
export const UBI_EC_MAGIC = "UBI#";
export const UBI_VID_MAGIC = "UBI!";
export const UBI_HEADER_BYTES = 64;
export const UBI_VERSION = 1;
export const UBI_LAYOUT_VOLUME_ID = 0x7fff_efff;
export const UBI_MAX_VOLUMES = 128;
export const UBI_VTBL_RECORD_BYTES = 172;
export const UBI_VOLUME_NAME_MAX = 127;
/** PEB boundaries are searched on this grid; real eraseblocks are multiples of it. */
export const UBI_PEB_ALIGNMENT = 512;
/** The largest eraseblock searched for; larger NAND eraseblocks are refused. */
export const UBI_MAX_PEB_BYTES = 16 * 1024 * 1024;
export const UBI_MAX_PEBS = 262_144;
/** Names of the parser limits that carry these ceilings into refusals. */
export const UBI_PEB_SIZE_LIMIT = "UBI eraseblock size";
export const UBI_PEB_COUNT_LIMIT = "UBI eraseblock count";
/**
 * Eraseblocks, counted from the second one, searched for an erase-counter
 * header off the eraseblock grid, which would mean the size was mismeasured.
 */
export const UBI_SPACING_CHECK_PEBS = 4;

const UBI_FORMAT = "ubi-image";
const HEADER_CRC_BYTES = 60;
const VTBL_CRC_BYTES = 168;
const VOLUME_TYPE_DYNAMIC = 1;
const VOLUME_TYPE_STATIC = 2;
const VTBL_AUTORESIZE_FLAG = 0x01;

export const UBI_IMAGE_LIMITATIONS = {
  inventoryScope:
    "UBI image inventory reads erase-counter and volume-identifier headers and the volume table. Volumes are reassembled from their logical eraseblocks; UBIFS and other volume contents are not decoded, data CRCs are verified only for wear-leveling copies that compete with another copy of the same logical eraseblock, and nothing is mounted.",
  corruptPebs:
    "Physical eraseblocks with a bad header magic, version, CRC or size were skipped; corrupt_peb_count records how many.",
  volumeTableDisagreement:
    "The two volume table copies disagree; the first valid copy was used.",
  volumeTableSingleCopy:
    "Only one valid volume table copy was found; the other copy is missing or invalid.",
  ignoredLebs:
    "Logical eraseblocks whose volume has no volume table record, or whose number lies outside their volume, were ignored; ignored_leb_count records how many.",
  missingLebs:
    "A volume with missing logical eraseblocks is inventoried but not reassembled; missing bytes are not invented.",
  invalidStaticSize:
    "A static volume whose eraseblocks disagree on used_ebs, declare zero used_ebs, declare more data than a logical eraseblock holds, or hold less than a full logical eraseblock before the last one, is inventoried but not reassembled.",
  vidRecordMismatch:
    "A volume whose VID headers declare a volume type or data_pad other than its volume table record is inventoried but not reassembled.",
  interruptedCopy:
    "A newer wear-leveling copy of a logical eraseblock failed its data CRC, so the older copy was used.",
  unverifiedCopy:
    "A volume whose logical eraseblock is left with only wear-leveling copies that failed their data CRC is inventoried but not reassembled.",
  lostLebs:
    "A volume with no mapped logical eraseblock in an image with corrupt physical eraseblocks is inventoried but not reassembled, since the corrupt eraseblocks may have held its data.",
  updateMarker:
    "The volume table marks an interrupted update for this volume; its reassembled bytes may be incomplete.",
} as const;

/** Why a volume cannot be reassembled, or null when it can. */
export type UbiVolumeExtractRefusal =
  | "missing_lebs"
  | "invalid_static_size"
  | "vid_record_mismatch"
  | "unverified_copy"
  | "lost_lebs";

export const ubiVolumeExtractRefusalLimitation = (
  refusal: UbiVolumeExtractRefusal,
): string =>
  ({
    missing_lebs: UBI_IMAGE_LIMITATIONS.missingLebs,
    invalid_static_size: UBI_IMAGE_LIMITATIONS.invalidStaticSize,
    vid_record_mismatch: UBI_IMAGE_LIMITATIONS.vidRecordMismatch,
    unverified_copy: UBI_IMAGE_LIMITATIONS.unverifiedCopy,
    lost_lebs: UBI_IMAGE_LIMITATIONS.lostLebs,
  })[refusal];

/** How parsing a UBI image failed, in the shared byte-format failure algebra. */
export type UbiImageParseError =
  | ParseFailureError<"malformed">
  | ParseFailureError<"unsupported">
  | ParseFailureError<"limit">;

const malformed = (detail: string, offset?: number): UbiImageParseError =>
  malformedInput(UBI_FORMAT, detail, offset === undefined ? {} : { offset });

const u32 = (bytes: Uint8Array, at: number): number =>
  (((bytes[at] ?? 0) << 24) |
    ((bytes[at + 1] ?? 0) << 16) |
    ((bytes[at + 2] ?? 0) << 8) |
    (bytes[at + 3] ?? 0)) >>>
  0;

const u64 = (bytes: Uint8Array, at: number): bigint =>
  (BigInt(u32(bytes, at)) << 32n) | BigInt(u32(bytes, at + 4));

const ubiCrc = (bytes: Uint8Array): number => ~crc32(bytes) >>> 0;

const hasMagic = (bytes: Uint8Array, at: number, magic: string): boolean =>
  bytes.length >= at + 4 &&
  Buffer.from(bytes.buffer, bytes.byteOffset + at, 4).toString("latin1") ===
    magic;

const isErased = (bytes: Uint8Array): boolean =>
  bytes.every((byte) => byte === 0xff);

/** The erase-counter header facts every PEB of one image shares. */
export interface UbiEcHeader {
  readonly version: number;
  readonly eraseCounter: bigint;
  readonly vidHeaderOffset: number;
  readonly dataOffset: number;
  readonly imageSeq: number;
}

type EcHeaderRead =
  | { readonly state: "valid"; readonly header: UbiEcHeader }
  | { readonly state: "invalid"; readonly reason: string };

const readEcHeader = (bytes: Uint8Array): EcHeaderRead => {
  if (bytes.length < UBI_HEADER_BYTES || !hasMagic(bytes, 0, UBI_EC_MAGIC))
    return { state: "invalid", reason: "erase-counter header magic is absent" };
  const declared = u32(bytes, HEADER_CRC_BYTES);
  const computed = ubiCrc(bytes.subarray(0, HEADER_CRC_BYTES));
  if (declared !== computed)
    return {
      state: "invalid",
      reason: `erase-counter header CRC mismatch: declared 0x${declared.toString(16)}, computed 0x${computed.toString(16)}`,
    };
  return {
    state: "valid",
    header: {
      version: bytes[4] ?? 0,
      eraseCounter: u64(bytes, 8),
      vidHeaderOffset: u32(bytes, 16),
      dataOffset: u32(bytes, 20),
      imageSeq: u32(bytes, 24),
    },
  };
};

const unsupportedVersion = (version: number): string =>
  `UBI header version ${String(version)} is unsupported; this reader supports version ${String(UBI_VERSION)} only`;

export type UbiImageRecognition =
  | { readonly state: "recognized" }
  | { readonly state: "refused"; readonly reason: string };

/**
 * Recognize `UBI#` at offset 0; a bad header CRC or version, or a file too
 * short to hold the erase-counter header, is a refusal.
 */
export const recognizeUbiImage = (
  prefix: Uint8Array,
  fileSize: number,
): UbiImageRecognition | undefined => {
  if (!hasMagic(prefix, 0, UBI_EC_MAGIC)) return undefined;
  if (fileSize < UBI_HEADER_BYTES)
    return {
      state: "refused",
      reason: `UBI erase-counter header is truncated: the file holds ${String(fileSize)} of its ${String(UBI_HEADER_BYTES)} bytes`,
    };
  // A route that read fewer leading bytes than the header leaves the CRC and
  // version to the reader, which refuses them when it opens the image.
  if (prefix.length < UBI_HEADER_BYTES) return { state: "recognized" };
  const read = readEcHeader(prefix);
  if (read.state === "invalid")
    return { state: "refused", reason: `UBI ${read.reason} at offset 0` };
  return read.header.version === UBI_VERSION
    ? { state: "recognized" }
    : { state: "refused", reason: unsupportedVersion(read.header.version) };
};

/** Validate the first PEB's erase-counter header, which fixes the header layout. */
export const parseUbiFirstEcHeader = (
  bytes: Uint8Array,
  fileSize: number,
): Result<UbiEcHeader, UbiImageParseError> => {
  const read = readEcHeader(bytes);
  if (read.state === "invalid") return err(malformed(read.reason, 0));
  const { header } = read;
  if (header.version !== UBI_VERSION)
    return err(
      unsupportedInput(UBI_FORMAT, unsupportedVersion(header.version), {
        offset: 4,
        field: "version",
      }),
    );
  if (
    header.vidHeaderOffset < UBI_HEADER_BYTES ||
    header.dataOffset < header.vidHeaderOffset + UBI_HEADER_BYTES ||
    header.dataOffset >= fileSize
  )
    return err(
      malformed(
        `erase-counter header declares vid_hdr_offset ${String(header.vidHeaderOffset)} and data_offset ${String(header.dataOffset)}, which do not fit a ${String(fileSize)}-byte image`,
        16,
      ),
    );
  return ok(header);
};

/** The first file offset at which the next PEB's erase-counter header can start. */
export const ubiPebSearchStart = (first: UbiEcHeader): number =>
  (Math.floor(first.dataOffset / UBI_PEB_ALIGNMENT) + 1) * UBI_PEB_ALIGNMENT;

/**
 * As in Linux UBI attach, image_seq 0 (written by older tools) is unspecified
 * and agrees with any sequence; nonzero sequences must be equal.
 */
const imageSeqsAgree = (left: number, right: number): boolean =>
  left === 0 || right === 0 || left === right;

function* ubiEcHeaderOffsets(
  chunk: Uint8Array,
  chunkOffset: number,
  start: number,
  admit: (offset: number) => boolean,
): Generator<{ offset: number; header: UbiEcHeader }, void> {
  const aligned =
    Math.ceil(Math.max(chunkOffset, start) / UBI_PEB_ALIGNMENT) *
    UBI_PEB_ALIGNMENT;
  for (
    let offset = aligned;
    offset + UBI_HEADER_BYTES <= chunkOffset + chunk.length;
    offset += UBI_PEB_ALIGNMENT
  ) {
    const at = offset - chunkOffset;
    if (!admit(offset) || !hasMagic(chunk, at, UBI_EC_MAGIC)) continue;
    const read = readEcHeader(chunk.subarray(at, at + UBI_HEADER_BYTES));
    if (read.state === "valid") yield { offset, header: read.header };
  }
}

/** Aligned EC headers outside the data declared by the first PEB's VID. */
export const ubiPebSizeCandidates = (
  chunk: Uint8Array,
  chunkOffset: number,
  first: UbiEcHeader,
  minPebSize: number,
): Generator<{ offset: number; header: UbiEcHeader }, void> =>
  ubiEcHeaderOffsets(
    chunk,
    chunkOffset,
    Math.max(minPebSize, ubiPebSearchStart(first)),
    () => true,
  );

/**
 * A candidate that leaves a partial final PEB can still be the real size.
 * A matching EC and mapped VID whose declared data fits the candidate LEB
 * establish a block boundary before any later file-size match.
 */
export const ubiHasMappedSecondPeb = (
  vidBytes: Uint8Array,
  first: UbiEcHeader,
  header: UbiEcHeader,
  pebSize: number,
): boolean => {
  if (
    header.version !== UBI_VERSION ||
    header.vidHeaderOffset !== first.vidHeaderOffset ||
    header.dataOffset !== first.dataOffset ||
    !imageSeqsAgree(first.imageSeq, header.imageSeq)
  )
    return false;
  const minSize = ubiVidMinPebSize(vidBytes, first);
  return minSize > 0 && minSize <= pebSize;
};

/**
 * Offsets inside one `pebSize` eraseblock where an eraseblock of a smaller
 * candidate size would begin: multiples of every size on the 512-byte grid
 * that divides `pebSize`, still leaves a LEB after `dataOffset`, and passes
 * `admit`.
 */
export const ubiCandidateGridOffsets = (
  pebSize: number,
  dataOffset: number,
  admit: (smallerPebSize: number) => boolean = () => true,
): ReadonlySet<number> => {
  const offsets = new Set<number>();
  for (
    let size = UBI_PEB_ALIGNMENT;
    size < pebSize;
    size += UBI_PEB_ALIGNMENT
  ) {
    if (pebSize % size !== 0 || size <= dataOffset) continue;
    if (!admit(size)) continue;
    for (let offset = size; offset < pebSize; offset += size)
      offsets.add(offset);
  }
  return offsets;
};

/**
 * The first aligned offset in `chunk` holding a valid erase-counter header at
 * one of `candidates` inside a `pebSize` eraseblock, or null. Such a header
 * means eraseblocks between the first two headers were skipped and `pebSize`
 * is a multiple of the real size. Skipped eraseblocks leave a real size that
 * divides `pebSize`, so `candidates` is at most `ubiCandidateGridOffsets`; a
 * header at any other position no eraseblock could begin at, and is payload.
 * Once the LEBs are read, `candidates` narrows to the grids they still admit
 * (`ubiSmallerGridFit`).
 */
export const findUbiSpacingConflict = (
  chunk: Uint8Array,
  chunkOffset: number,
  first: UbiEcHeader,
  pebSize: number,
  candidates: ReadonlySet<number>,
): number | null =>
  ubiEcHeaderOffsets(chunk, chunkOffset, ubiPebSearchStart(first), (offset) =>
    candidates.has(offset % pebSize),
  ).next().value?.offset ?? null;

/** The file range searched by `findUbiSpacingConflict` for a measured size. */
export const ubiSpacingCheckRange = (
  pebSize: number,
  fileSize: number,
): { readonly start: number; readonly end: number } => ({
  start: pebSize,
  end: Math.min(fileSize, (UBI_SPACING_CHECK_PEBS + 1) * pebSize),
});

/**
 * The refusal when a valid erase-counter header lies off the measured
 * eraseblock grid: eraseblocks were skipped and the size is a multiple of the
 * real one.
 */
export const ubiSpacingConflict = (
  pebSize: number,
  headerOffset: number,
): UbiImageParseError =>
  malformed(
    `UBI erase-counter header at offset ${String(headerOffset)} contradicts the ${String(pebSize)}-byte eraseblock size found at the second erase-counter header, so the eraseblock size is ambiguous`,
    headerOffset,
  );

/** PEB and LEB sizes, derived from the distance to the second EC header. */
export interface UbiGeometry {
  readonly pebSize: number;
  readonly lebSize: number;
  readonly pebCount: number;
  readonly vidHeaderOffset: number;
  readonly dataOffset: number;
  readonly imageSeq: number;
  /** Bytes to read from each PEB start to classify it. */
  readonly headerReadBytes: number;
  readonly volumeTableSlots: number;
}

/**
 * Admit a PEB size found at `nextHeaderOffset` (null when the scan found no
 * second header within `scanned` bytes). The size must exceed data_offset,
 * divide the file size evenly, and agree with every header found in
 * `ubiSpacingCheckRange` (`conflictingHeaderOffset` is the first that does not).
 */
export const ubiGeometry = (
  first: UbiEcHeader,
  nextHeaderOffset: number | null,
  fileSize: number,
  conflictingHeaderOffset: number | null,
): Result<UbiGeometry, UbiImageParseError> => {
  if (nextHeaderOffset === null)
    return err(
      fileSize > UBI_MAX_PEB_BYTES
        ? decodeLimit(
            UBI_FORMAT,
            `UBI image has no second erase-counter header within the fixed ${String(UBI_MAX_PEB_BYTES)}-byte eraseblock ceiling`,
            { name: UBI_PEB_SIZE_LIMIT, maximum: UBI_MAX_PEB_BYTES },
          )
        : malformed(
            "UBI image has no second erase-counter header, so its eraseblock size cannot be determined",
          ),
    );
  const pebSize = nextHeaderOffset;
  if (conflictingHeaderOffset !== null)
    return err(ubiSpacingConflict(pebSize, conflictingHeaderOffset));
  if (fileSize % pebSize !== 0)
    return err(
      malformed(
        `UBI image size ${String(fileSize)} is not a multiple of the ${String(pebSize)}-byte eraseblock size found at the second erase-counter header`,
      ),
    );
  const pebCount = fileSize / pebSize;
  if (pebCount > UBI_MAX_PEBS)
    return err(
      decodeLimit(
        UBI_FORMAT,
        `UBI image eraseblock count ${String(pebCount)} exceeds the fixed ${String(UBI_MAX_PEBS)}-eraseblock ceiling`,
        {
          name: UBI_PEB_COUNT_LIMIT,
          maximum: UBI_MAX_PEBS,
          required: pebCount,
        },
      ),
    );
  const lebSize = pebSize - first.dataOffset;
  return ok({
    pebSize,
    lebSize,
    pebCount,
    vidHeaderOffset: first.vidHeaderOffset,
    dataOffset: first.dataOffset,
    imageSeq: first.imageSeq,
    headerReadBytes: first.vidHeaderOffset + UBI_HEADER_BYTES,
    volumeTableSlots: Math.min(
      UBI_MAX_VOLUMES,
      Math.floor(lebSize / UBI_VTBL_RECORD_BYTES),
    ),
  });
};

/**
 * Smaller eraseblock sizes on the 512-byte grid that divide the measured size
 * and leave a LEB: the measured size divided by each prime factor. A finer
 * size fits only if these coarser ones do, so they are the ones to probe.
 */
export const ubiSmallerPebSizes = (geometry: UbiGeometry): number[] => {
  const sizes: number[] = [];
  let rest = geometry.pebSize / UBI_PEB_ALIGNMENT;
  for (let factor = 2; factor * factor <= rest; factor += 1) {
    if (rest % factor !== 0) continue;
    sizes.push(geometry.pebSize / factor);
    while (rest % factor === 0) rest /= factor;
  }
  if (rest > 1) sizes.push(geometry.pebSize / rest);
  return sizes.filter((size) => size > geometry.dataOffset);
};

/**
 * Whether the first `headerReadBytes` at a would-be eraseblock start hold an
 * erased EC and VID header, so an erased eraseblock could begin there.
 */
export const ubiPebHeadersErased = (
  bytes: Uint8Array,
  geometry: UbiGeometry,
): boolean =>
  bytes.length >= geometry.headerReadBytes &&
  isErased(bytes.subarray(0, UBI_HEADER_BYTES)) &&
  isErased(
    bytes.subarray(
      geometry.vidHeaderOffset,
      geometry.vidHeaderOffset + UBI_HEADER_BYTES,
    ),
  );

/**
 * Offsets inside one measured eraseblock where an eraseblock of a smaller
 * candidate size would begin: multiples of every size on the 512-byte grid
 * that divides the measured size, still leaves a LEB, and passes `admit`.
 */
export const ubiSmallerGridOffsets = (
  geometry: UbiGeometry,
  admit: (smallerPebSize: number) => boolean = () => true,
): ReadonlySet<number> =>
  ubiCandidateGridOffsets(geometry.pebSize, geometry.dataOffset, admit);

/**
 * The first offset in `chunk` (read at `chunkOffset`) holding a valid
 * erase-counter header, whatever its layout, at one of `smallerGridOffsets`
 * inside a measured eraseblock, or null. Such a header begins an eraseblock
 * the measured size would merge into its neighbor's data.
 */
export const findUbiSmallerGridHeader = (
  chunk: Uint8Array,
  chunkOffset: number,
  first: UbiEcHeader,
  geometry: UbiGeometry,
  smallerGridOffsets: ReadonlySet<number>,
): number | null =>
  findUbiSpacingConflict(
    chunk,
    chunkOffset,
    first,
    geometry.pebSize,
    smallerGridOffsets,
  );

/**
 * Whether the image still reads as eraseblocks of `smallerPebSize`: every
 * mapped LEB's declared data and padding fit the smaller LEB, as Linux UBI
 * requires of a VID header (padding shorter than the LEB, as `classifyUbiPeb`
 * and a volume table alignment no larger than the LEB also demand, and data
 * within what the padding leaves), and a volume table copy (`tableCopies`,
 * read at the layout volume's LEB 0 and LEB 1) stays valid, its data_pad
 * matching the smaller LEB size. A size that fails either is ruled out
 * whatever its header positions hold.
 */
export const ubiSmallerPebSizeHoldsLebs = (
  geometry: UbiGeometry,
  pebs: readonly UbiPeb[],
  smallerPebSize: number,
  tableCopies: readonly [Uint8Array | null, Uint8Array | null],
): boolean => {
  const lebSize = smallerPebSize - geometry.dataOffset;
  if (
    !pebs.every(
      (peb) =>
        peb.state !== "mapped" ||
        (peb.vid.dataPad < lebSize &&
          peb.vid.dataSize <= lebSize - peb.vid.dataPad),
    )
  )
    return false;
  const smaller: UbiGeometry = {
    ...geometry,
    pebSize: smallerPebSize,
    lebSize,
    pebCount: (geometry.pebCount * geometry.pebSize) / smallerPebSize,
    volumeTableSlots: Math.min(
      UBI_MAX_VOLUMES,
      Math.floor(lebSize / UBI_VTBL_RECORD_BYTES),
    ),
  };
  const tableBytes = ubiVolumeTableBytes(smaller);
  const [left, right] = tableCopies;
  return parseUbiVolumeTable(
    [
      left?.subarray(0, tableBytes) ?? null,
      right?.subarray(0, tableBytes) ?? null,
    ],
    smaller,
  ).ok;
};

/**
 * Smaller-grid offsets that `ubiSmallerPebSizeHoldsLebs` admits. A header
 * anywhere else lies in LEB data no smaller eraseblock could begin at, such
 * as a nested UBI image inside a volume, so it does not contradict the
 * measured size.
 */
export const ubiSmallerGridFit = (
  geometry: UbiGeometry,
  pebs: readonly UbiPeb[],
  tableCopies: readonly [Uint8Array | null, Uint8Array | null],
): { readonly plausible: ReadonlySet<number> } => ({
  plausible: ubiSmallerGridOffsets(geometry, (size) =>
    ubiSmallerPebSizeHoldsLebs(geometry, pebs, size, tableCopies),
  ),
});

/**
 * The refusal when every header position of `smallerPebSize` off the measured
 * grid is erased: the image is equally a run of `smallerPebSize` eraseblocks
 * with erased ones between, and the bytes cannot say which.
 */
export const ubiAmbiguousPebSize = (
  geometry: UbiGeometry,
  smallerPebSize: number,
): UbiImageParseError =>
  malformed(
    `UBI image also fits a ${String(smallerPebSize)}-byte eraseblock size, because every header position on that grid between the ${String(geometry.pebSize)}-byte eraseblocks is erased, so the eraseblock size is ambiguous`,
  );

export interface UbiVidHeader {
  readonly volType: number;
  readonly copyFlag: number;
  readonly compat: number;
  readonly volId: number;
  readonly lnum: number;
  readonly dataSize: number;
  readonly usedEbs: number;
  readonly dataPad: number;
  readonly dataCrc: number;
  readonly sqnum: bigint;
}

/** Erase-counter header facts of one PEB. */
export interface UbiPebEcFacts {
  readonly eraseCounter: bigint;
  readonly imageSeq: number;
}

/** One physical eraseblock as its headers describe it. */
export type UbiPeb =
  | { readonly state: "erased" }
  | {
      readonly state: "free";
      readonly eraseCounter: bigint;
      readonly imageSeq: number;
    }
  | {
      readonly state: "corrupt";
      readonly reason: string;
      /** The erase-counter facts, when only the VID header is corrupt. */
      readonly ec: UbiPebEcFacts | null;
    }
  | {
      readonly state: "mapped";
      readonly eraseCounter: bigint;
      readonly imageSeq: number;
      readonly vid: UbiVidHeader;
    };

type VidHeaderRead =
  | { readonly state: "valid"; readonly vid: UbiVidHeader }
  | { readonly state: "invalid"; readonly reason: string };

const readVidHeader = (vidBytes: Uint8Array): VidHeaderRead => {
  if (
    vidBytes.length < UBI_HEADER_BYTES ||
    !hasMagic(vidBytes, 0, UBI_VID_MAGIC)
  )
    return { state: "invalid", reason: "VID header magic is absent" };
  const declared = u32(vidBytes, HEADER_CRC_BYTES);
  const computed = ubiCrc(vidBytes.subarray(0, HEADER_CRC_BYTES));
  if (declared !== computed)
    return {
      state: "invalid",
      reason: `VID header CRC mismatch: declared 0x${declared.toString(16)}, computed 0x${computed.toString(16)}`,
    };
  if ((vidBytes[4] ?? 0) !== UBI_VERSION)
    return { state: "invalid", reason: unsupportedVersion(vidBytes[4] ?? 0) };
  return {
    state: "valid",
    vid: {
      volType: vidBytes[5] ?? 0,
      copyFlag: vidBytes[6] ?? 0,
      compat: vidBytes[7] ?? 0,
      volId: u32(vidBytes, 8),
      lnum: u32(vidBytes, 12),
      dataSize: u32(vidBytes, 20),
      usedEbs: u32(vidBytes, 24),
      dataPad: u32(vidBytes, 28),
      dataCrc: u32(vidBytes, 32),
      sqnum: u64(vidBytes, 40),
    },
  };
};

const isVolumeType = (volType: number): boolean =>
  volType === VOLUME_TYPE_DYNAMIC || volType === VOLUME_TYPE_STATIC;

/**
 * The file offset of the first PEB's VID header when it lies inside both the
 * file and the fixed eraseblock ceiling, or null. A header past the ceiling
 * belongs to no admissible eraseblock, so it is never read: the eraseblock
 * search then reaches its bounded refusal without buffering up to the
 * declared offset.
 */
export const ubiFirstVidHeaderOffset = (
  first: UbiEcHeader,
  fileSize: number,
): number | null =>
  first.vidHeaderOffset + UBI_HEADER_BYTES <=
  Math.min(fileSize, UBI_MAX_PEB_BYTES)
    ? first.vidHeaderOffset
    : null;

/**
 * The smallest eraseblock size that fits the VID header, or 0 when the
 * header is invalid. As `classifyUbiPeb` requires, the LEB must hold data_pad
 * plus data_size and more than data_pad.
 */
export const ubiVidMinPebSize = (
  vidBytes: Uint8Array,
  ec: UbiEcHeader,
): number => {
  const read = readVidHeader(vidBytes.subarray(0, UBI_HEADER_BYTES));
  if (read.state === "invalid" || !isVolumeType(read.vid.volType)) return 0;
  const { dataPad, dataSize } = read.vid;
  return ec.dataOffset + dataPad + Math.max(dataSize, 1);
};

/**
 * Classify one PEB from its first `headerReadBytes`. A valid header with a
 * different layout is an inconsistent image, not a skipped eraseblock; image
 * sequences are compared across all PEBs by `checkUbiPebs`.
 */
export const classifyUbiPeb = (
  bytes: Uint8Array,
  index: number,
  geometry: UbiGeometry,
): Result<UbiPeb, UbiImageParseError> => {
  const ecBytes = bytes.subarray(0, UBI_HEADER_BYTES);
  const vidBytes = bytes.subarray(
    geometry.vidHeaderOffset,
    geometry.vidHeaderOffset + UBI_HEADER_BYTES,
  );
  if (isErased(ecBytes))
    return ok(
      isErased(vidBytes)
        ? { state: "erased" }
        : {
            state: "corrupt",
            reason: "erased erase-counter header before a written VID header",
            ec: null,
          },
    );
  const ec = readEcHeader(ecBytes);
  if (ec.state === "invalid")
    return ok({ state: "corrupt", reason: ec.reason, ec: null });
  if (ec.header.version !== UBI_VERSION)
    return ok({
      state: "corrupt",
      reason: unsupportedVersion(ec.header.version),
      ec: null,
    });
  if (
    ec.header.vidHeaderOffset !== geometry.vidHeaderOffset ||
    ec.header.dataOffset !== geometry.dataOffset
  )
    return err(
      malformed(
        `UBI eraseblock ${String(index)} declares vid_hdr_offset ${String(ec.header.vidHeaderOffset)} and data_offset ${String(ec.header.dataOffset)}, which differ from eraseblock 0`,
        index * geometry.pebSize,
      ),
    );
  const { eraseCounter, imageSeq } = ec.header;
  if (isErased(vidBytes)) return ok({ state: "free", eraseCounter, imageSeq });
  const facts: UbiPebEcFacts = { eraseCounter, imageSeq };
  const read = readVidHeader(vidBytes);
  if (read.state === "invalid")
    return ok({ state: "corrupt", reason: read.reason, ec: facts });
  const { vid } = read;
  if (
    !isVolumeType(vid.volType) ||
    vid.dataPad >= geometry.lebSize ||
    vid.dataSize > geometry.lebSize - vid.dataPad
  )
    return ok({
      state: "corrupt",
      reason: `VID header declares vol_type ${String(vid.volType)}, data_size ${String(vid.dataSize)} and data_pad ${String(vid.dataPad)}, which do not fit a ${String(geometry.lebSize)}-byte logical eraseblock`,
      ec: facts,
    });
  return ok({ state: "mapped", eraseCounter, imageSeq, vid });
};

/** The valid erase-counter facts of a PEB, including one with a corrupt VID. */
const pebEcFacts = (peb: UbiPeb): UbiPebEcFacts | null =>
  peb.state === "corrupt" ? peb.ec : peb.state === "erased" ? null : peb;

/**
 * Linux attach-time checks across classified PEBs. Every nonzero image_seq
 * must agree (zero is unspecified), and two copies of one LEB must not share
 * a sqnum, since neither is then newer. Returns the geometry with the agreed
 * image sequence, or 0 when every PEB declares 0.
 */
export const checkUbiPebs = (
  geometry: UbiGeometry,
  pebs: readonly UbiPeb[],
): Result<UbiGeometry, UbiImageParseError> => {
  let imageSeq = 0;
  const sqnums = new Map<string, number>();
  for (const [index, peb] of pebs.entries()) {
    const ec = pebEcFacts(peb);
    if (ec === null) continue;
    if (!imageSeqsAgree(imageSeq, ec.imageSeq))
      return err(
        malformed(
          `UBI eraseblock ${String(index)} declares image_seq ${String(ec.imageSeq)}, which differs from image_seq ${String(imageSeq)} of earlier eraseblocks`,
          index * geometry.pebSize,
        ),
      );
    if (imageSeq === 0) imageSeq = ec.imageSeq;
    if (peb.state !== "mapped") continue;
    const { volId, lnum, sqnum } = peb.vid;
    const key = `${String(volId)}/${String(lnum)}/${String(sqnum)}`;
    const other = sqnums.get(key);
    if (other !== undefined)
      return err(
        malformed(
          `UBI eraseblocks ${String(other)} and ${String(index)} both hold LEB ${String(lnum)} of volume ${String(volId)} with sqnum ${String(sqnum)}, so neither copy is newer`,
          index * geometry.pebSize,
        ),
      );
    sqnums.set(key, index);
  }
  return ok({ ...geometry, imageSeq });
};

/** One volume table record that reserves eraseblocks. */
export interface UbiVolumeRecord {
  readonly id: number;
  readonly reservedPebs: number;
  readonly alignment: number;
  readonly dataPad: number;
  readonly type: "dynamic" | "static";
  readonly updateMarker: boolean;
  /** The name as UTF-8; invalid sequences become U+FFFD. */
  readonly name: string;
  /** The stored name bytes, when UTF-8 decoding was lossy; otherwise null. */
  readonly nameBytesHex: string | null;
  readonly flags: number;
}

type VolumeTableCopy =
  | { readonly valid: true; readonly records: readonly UbiVolumeRecord[] }
  | { readonly valid: false; readonly reason: string };

const decodeVolumeName = (
  bytes: Uint8Array,
): { readonly name: string; readonly nameBytesHex: string | null } => {
  const stored = Buffer.from(bytes);
  return {
    name: stored.toString("utf8"),
    nameBytesHex: isStrictUtf8(stored) ? null : stored.toString("hex"),
  };
};

const parseVolumeTableCopy = (
  bytes: Uint8Array,
  geometry: UbiGeometry,
): VolumeTableCopy => {
  const records: UbiVolumeRecord[] = [];
  const empty = new Uint8Array(VTBL_CRC_BYTES);
  const emptyCrc = ubiCrc(empty);
  for (let id = 0; id < geometry.volumeTableSlots; id += 1) {
    const record = bytes.subarray(
      id * UBI_VTBL_RECORD_BYTES,
      (id + 1) * UBI_VTBL_RECORD_BYTES,
    );
    if (record.length < UBI_VTBL_RECORD_BYTES)
      return { valid: false, reason: `record ${String(id)} is truncated` };
    const crc = u32(record, VTBL_CRC_BYTES);
    if (crc !== ubiCrc(record.subarray(0, VTBL_CRC_BYTES)))
      return { valid: false, reason: `record ${String(id)} CRC mismatch` };
    const reservedPebs = u32(record, 0);
    if (reservedPebs === 0) {
      if (
        crc !== emptyCrc ||
        !record.subarray(0, VTBL_CRC_BYTES).every((byte) => byte === 0)
      )
        return {
          valid: false,
          reason: `empty record ${String(id)} is not all zero`,
        };
      continue;
    }
    const alignment = u32(record, 4);
    const dataPad = u32(record, 8);
    const volType = record[12] ?? 0;
    const updateMarker = record[13] ?? 0;
    const nameLength = ((record[14] ?? 0) << 8) | (record[15] ?? 0);
    if (
      (volType !== VOLUME_TYPE_DYNAMIC && volType !== VOLUME_TYPE_STATIC) ||
      updateMarker > 1 ||
      alignment === 0 ||
      alignment > geometry.lebSize ||
      dataPad !== geometry.lebSize % alignment ||
      nameLength === 0 ||
      nameLength > UBI_VOLUME_NAME_MAX
    )
      return {
        valid: false,
        reason: `record ${String(id)} declares fields outside the UBI layout`,
      };
    records.push({
      id,
      reservedPebs,
      alignment,
      dataPad,
      type: volType === VOLUME_TYPE_STATIC ? "static" : "dynamic",
      updateMarker: updateMarker === 1,
      ...decodeVolumeName(record.subarray(16, 16 + nameLength)),
      flags: record[144] ?? 0,
    });
  }
  return { valid: true, records };
};

/** Bytes of one volume table copy: its slots, from the start of the LEB data. */
export const ubiVolumeTableBytes = (geometry: UbiGeometry): number =>
  geometry.volumeTableSlots * UBI_VTBL_RECORD_BYTES;

export interface UbiVolumeTable {
  readonly records: readonly UbiVolumeRecord[];
  readonly copiesFound: number;
  readonly copiesValid: number;
  /** Null unless both copies were found and valid. */
  readonly copiesAgree: boolean | null;
  readonly sourceLnum: 0 | 1;
  readonly limitations: readonly string[];
}

/**
 * Choose the volume table from the layout volume's LEB 0 and LEB 1 copies
 * (null when absent). The first valid copy wins; disagreement is named.
 */
export const parseUbiVolumeTable = (
  copies: readonly [Uint8Array | null, Uint8Array | null],
  geometry: UbiGeometry,
): Result<UbiVolumeTable, UbiImageParseError> => {
  const parsed = copies.map((bytes) =>
    bytes === null ? null : parseVolumeTableCopy(bytes, geometry),
  );
  const copiesFound = parsed.filter((copy) => copy !== null).length;
  const validIndex = parsed.findIndex((copy) => copy?.valid === true);
  if (validIndex === -1) {
    const reasons = parsed
      .map((copy, lnum) =>
        copy === null
          ? `copy ${String(lnum)} is missing`
          : copy.valid
            ? null
            : `copy ${String(lnum)}: ${copy.reason}`,
      )
      .filter((reason) => reason !== null);
    return err(
      malformed(`UBI image has no valid volume table (${reasons.join("; ")})`),
    );
  }
  const copiesValid = parsed.filter((copy) => copy?.valid === true).length;
  const [left, right] = copies;
  const copiesAgree =
    copiesValid === 2 && left !== null && right !== null
      ? Buffer.from(left).equals(Buffer.from(right))
      : null;
  const chosen = parsed[validIndex] as Extract<
    VolumeTableCopy,
    { valid: true }
  >;
  return ok({
    records: chosen.records,
    copiesFound,
    copiesValid,
    copiesAgree,
    sourceLnum: validIndex === 0 ? 0 : 1,
    limitations: [
      ...(copiesValid < 2 ? [UBI_IMAGE_LIMITATIONS.volumeTableSingleCopy] : []),
      ...(copiesAgree === false
        ? [UBI_IMAGE_LIMITATIONS.volumeTableDisagreement]
        : []),
    ],
  });
};

/** One logical eraseblock's stored data as a file range. */
export interface UbiLebRange {
  readonly lnum: number;
  readonly peb: number;
  readonly offset: number;
  readonly length: number;
}

export interface UbiVolume {
  readonly id: number;
  readonly name: string;
  readonly nameBytesHex: string | null;
  readonly path: string;
  readonly type: "dynamic" | "static";
  readonly reservedPebs: number;
  readonly alignment: number;
  readonly dataPad: number;
  readonly updateMarker: boolean;
  readonly flags: number;
  readonly autoresize: boolean;
  readonly usableLebSize: number;
  /** used_ebs from a static volume's VID headers; null for dynamic volumes. */
  readonly usedEbs: number | null;
  readonly mappedLebCount: number;
  readonly staleLebCopyCount: number;
  readonly missingLebCount: number;
  readonly firstMissingLeb: number | null;
  /** Reassembled size, or null when the volume is refused. */
  readonly dataBytes: number | null;
  readonly ranges: readonly UbiLebRange[];
  readonly extractRefusal: UbiVolumeExtractRefusal | null;
  readonly limitations: readonly string[];
}

export interface UbiImage {
  readonly geometry: UbiGeometry;
  readonly mappedPebCount: number;
  readonly freePebCount: number;
  readonly erasedPebCount: number;
  readonly corruptPebCount: number;
  readonly layoutPebCount: number;
  readonly staleLebCopyCount: number;
  /** LEBs whose newer copy failed its data CRC, so the older copy won. */
  readonly interruptedCopyCount: number;
  readonly ignoredLebCount: number;
  readonly minEraseCounter: number | null;
  readonly maxEraseCounter: number | null;
  readonly volumeTable: UbiVolumeTable;
  readonly volumes: readonly UbiVolume[];
  readonly limitations: readonly string[];
}

interface WinningLeb {
  readonly peb: number;
  readonly vid: UbiVidHeader;
  /**
   * The LEB had competing copies and the winner is a wear-leveling copy whose
   * data CRC failed, so no copy of it passed verification.
   */
  readonly unverified: boolean;
}

/**
 * Mapped PEBs whose copy_flag marks a wear-leveling copy of a LEB that has
 * another copy. Their data CRC decides which copy wins, so the caller reads
 * `vid.dataSize` bytes at their data offset and checks `ubiCopyDataMatches`.
 */
export const ubiCopiesToVerify = (pebs: readonly UbiPeb[]): number[] => {
  const copies = new Map<string, number>();
  const key = (vid: UbiVidHeader): string =>
    `${String(vid.volId)}/${String(vid.lnum)}`;
  for (const peb of pebs)
    if (peb.state === "mapped")
      copies.set(key(peb.vid), (copies.get(key(peb.vid)) ?? 0) + 1);
  const indices: number[] = [];
  pebs.forEach((peb, index) => {
    if (
      peb.state === "mapped" &&
      peb.vid.copyFlag !== 0 &&
      (copies.get(key(peb.vid)) ?? 0) > 1
    )
      indices.push(index);
  });
  return indices;
};

/** Whether a copied LEB's data, `vid.dataSize` bytes, matches its data CRC. */
export const ubiCopyDataMatches = (
  data: Uint8Array,
  vid: UbiVidHeader,
): boolean => data.length === vid.dataSize && ubiCrc(data) === vid.dataCrc;

/**
 * Per volume and LEB number, the winning copy, and stale copies. As in Linux
 * UBI, the higher sqnum wins unless its copy_flag is set and its PEB is not in
 * `verifiedCopies`: an interrupted copy loses to the older one. Equal sqnums
 * are refused earlier by `checkUbiPebs`. When the surviving copy is itself a
 * failed wear-leveling copy, the LEB is marked unverified.
 */
const winningLebs = (
  pebs: readonly UbiPeb[],
  verifiedCopies: ReadonlySet<number>,
): {
  readonly lebs: Map<number, Map<number, WinningLeb>>;
  readonly stale: Map<number, number>;
  readonly interrupted: number;
} => {
  const lebs = new Map<number, Map<number, WinningLeb>>();
  const stale = new Map<number, number>();
  let interrupted = 0;
  pebs.forEach((peb, index) => {
    if (peb.state !== "mapped") return;
    const { vid } = peb;
    const volume = lebs.get(vid.volId) ?? new Map<number, WinningLeb>();
    lebs.set(vid.volId, volume);
    const current = volume.get(vid.lnum);
    const candidate = { peb: index, vid, unverified: false };
    if (current === undefined) {
      volume.set(vid.lnum, candidate);
      return;
    }
    stale.set(vid.volId, (stale.get(vid.volId) ?? 0) + 1);
    const [newer, older] =
      vid.sqnum > current.vid.sqnum
        ? [candidate, current]
        : [current, candidate];
    const winner =
      newer.vid.copyFlag !== 0 && !verifiedCopies.has(newer.peb)
        ? older
        : newer;
    if (winner === older) interrupted += 1;
    volume.set(vid.lnum, {
      ...winner,
      unverified: winner.vid.copyFlag !== 0 && !verifiedCopies.has(winner.peb),
    });
  });
  return { lebs, stale, interrupted };
};

/**
 * The layout volume's usable LEB 0 and LEB 1 PEBs, as `winningLebs` selects
 * them. A layout LEB whose surviving winner is an unverified wear-leveling
 * copy (its data CRC failed with no verified copy to fall back to) returns
 * null so it is excluded before choosing the volume table.
 */
export const ubiLayoutVolumePebs = (
  pebs: readonly UbiPeb[],
  verifiedCopies: ReadonlySet<number>,
): readonly [number | null, number | null] => {
  const layout = winningLebs(pebs, verifiedCopies).lebs.get(
    UBI_LAYOUT_VOLUME_ID,
  );
  const usable = (lnum: 0 | 1): number | null => {
    const winner = layout?.get(lnum);
    return winner === undefined || winner.unverified ? null : winner.peb;
  };
  return [usable(0), usable(1)];
};

const volumePath = (name: string, id: number, used: Set<string>): string => {
  const stem =
    name.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^\.+/u, "") ||
    `volume-${String(id)}`;
  let candidate = stem;
  for (let suffix = 1; used.has(candidate); suffix += 1)
    candidate = `${stem}-${String(suffix)}`;
  used.add(candidate);
  return `volumes/${candidate}`;
};

const assembleVolume = (
  record: UbiVolumeRecord,
  lebs: ReadonlyMap<number, WinningLeb>,
  staleLebCopyCount: number,
  geometry: UbiGeometry,
  path: string,
  corruptPebsPresent: boolean,
): { readonly volume: UbiVolume; readonly ignored: number } => {
  const usableLebSize = geometry.lebSize - record.dataPad;
  const inRange = [...lebs.entries()]
    .filter(([lnum]) => lnum < record.reservedPebs)
    .sort(([left], [right]) => left - right);
  let ignored = lebs.size - inRange.length;
  // No surviving header cannot establish emptiness when a corrupt PEB may
  // have held the volume's only LEBs.
  const lost = inRange.length === 0 && corruptPebsPresent;
  const usedEbsValues = new Set(inRange.map(([, leb]) => leb.vid.usedEbs));
  const usedEbs =
    record.type === "static"
      ? usedEbsValues.size === 0
        ? lost
          ? null
          : 0
        : usedEbsValues.size === 1
          ? [...usedEbsValues][0]!
          : null
      : null;
  const vidType =
    record.type === "static" ? VOLUME_TYPE_STATIC : VOLUME_TYPE_DYNAMIC;
  let refusal: UbiVolumeExtractRefusal | null = inRange.some(
    ([, leb]) =>
      leb.vid.volType !== vidType || leb.vid.dataPad !== record.dataPad,
  )
    ? "vid_record_mismatch"
    : inRange.some(([, leb]) => leb.unverified)
      ? "unverified_copy"
      : lost
        ? "lost_lebs"
        : null;
  let contentLebs: number;
  if (record.type === "static") {
    const lastLnum = (usedEbs ?? 0) - 1;
    if (
      refusal === null &&
      (usedEbs === null ||
        (usedEbs === 0 && inRange.length > 0) ||
        usedEbs > record.reservedPebs ||
        inRange.some(
          ([lnum, leb]) =>
            leb.vid.dataSize > usableLebSize ||
            (lnum < lastLnum && leb.vid.dataSize !== usableLebSize),
        ))
    )
      refusal = "invalid_static_size";
    contentLebs = usedEbs ?? 0;
    const beyond = inRange.filter(([lnum]) => lnum >= contentLebs).length;
    ignored += refusal === null ? beyond : 0;
  } else {
    contentLebs = inRange.length === 0 ? 0 : inRange.at(-1)![0] + 1;
  }
  const ranges: UbiLebRange[] = [];
  let missingLebCount = 0;
  let firstMissingLeb: number | null = null;
  // Count gaps from the sorted mapped LEBs regardless of earlier refusal;
  // bound the span by reservedPebs so an over-large on-disk used_ebs cannot
  // inflate it, and only collect ranges when extraction is still allowed.
  const gapSpan = Math.min(contentLebs, record.reservedPebs);
  let expected = 0;
  for (const [lnum, leb] of inRange) {
    if (lnum >= gapSpan) break;
    if (lnum > expected) {
      missingLebCount += lnum - expected;
      firstMissingLeb ??= expected;
    }
    expected = lnum + 1;
    if (refusal === null) {
      ranges.push({
        lnum,
        peb: leb.peb,
        offset: leb.peb * geometry.pebSize + geometry.dataOffset,
        length: record.type === "static" ? leb.vid.dataSize : usableLebSize,
      });
    }
  }
  if (expected < gapSpan) {
    missingLebCount += gapSpan - expected;
    firstMissingLeb ??= expected;
  }
  if (refusal === null && missingLebCount > 0) refusal = "missing_lebs";
  const dataBytes =
    refusal === null
      ? ranges.reduce((total, range) => total + range.length, 0)
      : null;
  return {
    ignored,
    volume: {
      id: record.id,
      name: record.name,
      nameBytesHex: record.nameBytesHex,
      path,
      type: record.type,
      reservedPebs: record.reservedPebs,
      alignment: record.alignment,
      dataPad: record.dataPad,
      updateMarker: record.updateMarker,
      flags: record.flags,
      autoresize: (record.flags & VTBL_AUTORESIZE_FLAG) !== 0,
      usableLebSize,
      usedEbs,
      mappedLebCount: inRange.length,
      staleLebCopyCount,
      missingLebCount,
      firstMissingLeb,
      dataBytes,
      ranges: refusal === null ? ranges : [],
      extractRefusal: refusal,
      limitations: [
        ...(refusal === null
          ? []
          : [ubiVolumeExtractRefusalLimitation(refusal)]),
        ...(record.updateMarker ? [UBI_IMAGE_LIMITATIONS.updateMarker] : []),
      ],
    },
  };
};

const counterRange = (
  pebs: readonly UbiPeb[],
): { readonly min: number | null; readonly max: number | null } => {
  let min: bigint | null = null;
  let max: bigint | null = null;
  for (const peb of pebs) {
    const ec = pebEcFacts(peb);
    if (ec === null) continue;
    if (min === null || ec.eraseCounter < min) min = ec.eraseCounter;
    if (max === null || ec.eraseCounter > max) max = ec.eraseCounter;
  }
  const safe = (value: bigint | null): number | null =>
    value === null || value > BigInt(Number.MAX_SAFE_INTEGER)
      ? null
      : Number(value);
  return { min: safe(min), max: safe(max) };
};

/**
 * Map each volume table record to its winning LEBs and file ranges.
 * `verifiedCopies` holds the PEBs from `ubiCopiesToVerify` whose data matched.
 */
export const assembleUbiImage = (
  geometry: UbiGeometry,
  pebs: readonly UbiPeb[],
  volumeTable: UbiVolumeTable,
  verifiedCopies: ReadonlySet<number>,
): UbiImage => {
  const { lebs, stale, interrupted } = winningLebs(pebs, verifiedCopies);
  const used = new Set<string>();
  let ignoredLebCount = 0;
  const known = new Set(volumeTable.records.map((record) => record.id));
  for (const [volId, volume] of lebs)
    if (volId !== UBI_LAYOUT_VOLUME_ID && !known.has(volId))
      ignoredLebCount += volume.size;
  const count = (state: UbiPeb["state"]): number =>
    pebs.filter((peb) => peb.state === state).length;
  const corruptPebCount = count("corrupt");
  const volumes = volumeTable.records.map((record) => {
    const assembled = assembleVolume(
      record,
      lebs.get(record.id) ?? new Map(),
      stale.get(record.id) ?? 0,
      geometry,
      volumePath(record.name, record.id, used),
      corruptPebCount > 0,
    );
    ignoredLebCount += assembled.ignored;
    return assembled.volume;
  });
  const { min, max } = counterRange(pebs);
  return {
    geometry,
    mappedPebCount: count("mapped"),
    freePebCount: count("free"),
    erasedPebCount: count("erased"),
    corruptPebCount,
    layoutPebCount: pebs.filter(
      (peb) => peb.state === "mapped" && peb.vid.volId === UBI_LAYOUT_VOLUME_ID,
    ).length,
    staleLebCopyCount: [...stale.values()].reduce(
      (total, value) => total + value,
      0,
    ),
    interruptedCopyCount: interrupted,
    ignoredLebCount,
    minEraseCounter: min,
    maxEraseCounter: max,
    volumeTable,
    volumes,
    limitations: [
      ...volumeTable.limitations,
      ...(corruptPebCount > 0 ? [UBI_IMAGE_LIMITATIONS.corruptPebs] : []),
      ...(ignoredLebCount > 0 ? [UBI_IMAGE_LIMITATIONS.ignoredLebs] : []),
      ...(interrupted > 0 ? [UBI_IMAGE_LIMITATIONS.interruptedCopy] : []),
      ...new Set(volumes.flatMap((volume) => volume.limitations)),
    ],
  };
};
