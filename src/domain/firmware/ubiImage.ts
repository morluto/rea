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
const UBI_EC_MAGIC = "UBI#";
const UBI_VID_MAGIC = "UBI!";
const UBI_HEADER_BYTES = 64;
const UBI_VERSION = 1;
export const UBI_LAYOUT_VOLUME_ID = 0x7fff_efff;
const UBI_MAX_VOLUMES = 128;
const UBI_VTBL_RECORD_BYTES = 172;
const UBI_VOLUME_NAME_MAX = 127;
/** PEB boundaries are searched on this grid; real eraseblocks are multiples of it. */
const UBI_PEB_ALIGNMENT = 512;
/** The largest eraseblock searched for; larger NAND eraseblocks are refused. */
export const UBI_MAX_PEB_BYTES = 16 * 1024 * 1024;
export const UBI_MAX_PEBS = 262_144;
/**
 * Maximum CRC-valid EC header offsets retained in the parse-wide scan cache.
 * Exceeds `UBI_MAX_PEB_BYTES / UBI_PEB_ALIGNMENT` (32,768) so the candidate
 * scan window is always cached, while preventing payload-stuffed `UBI#`
 * headers in large images from exhausting memory. Once reached, further scans
 * stream without retaining offsets.
 */
export const UBI_MAX_CACHED_EC_HEADERS = 65_536;
/** Names of the parser limits that carry these ceilings into refusals. */
export const UBI_PEB_SIZE_LIMIT = "UBI eraseblock size";
export const UBI_PEB_COUNT_LIMIT = "UBI eraseblock count";
export const UBI_STATIC_PAYLOAD_CRC_LIMIT = "UBI static payload CRC bytes";
/**
 * Eraseblocks, counted from the second one, searched for an erase-counter
 * header off the eraseblock grid, which would mean the size was mismeasured.
 */
const UBI_SPACING_CHECK_PEBS = 4;
const SCAN_CHUNK_BYTES = 64 * 1024;

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
    "A volume whose end cannot be established in an image with corrupt physical eraseblocks (no mapped logical eraseblocks, or a dynamic volume with fewer mapped eraseblocks than reserved_pebs) is inventoried but not reassembled, since the corrupt eraseblocks may have held its data.",
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
interface UbiEcHeader {
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
const parseUbiFirstEcHeader = (
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
const ubiPebSearchStart = (first: UbiEcHeader): number =>
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

/**
 * A candidate that leaves a partial final PEB can still be the real size.
 * A matching EC and mapped VID whose declared data fits the candidate LEB
 * establish a block boundary unless a later dividing candidate is accepted and
 * places that header inside a mapped non-layout LEB's data area.
 */
const ubiHasMappedSecondPeb = (
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

/** Whether `bytes` begin with a CRC-valid UBI erase-counter header. */
const ubiHasValidEcHeader = (bytes: Uint8Array): boolean =>
  readEcHeader(bytes).state === "valid";

/**
 * Whether `headerOffset` lies inside the usable data area of a mapped
 * non-layout LEB under `(geometry, pebs)`. A valid EC header inside a
 * layout-volume PEB (which holds only the volume table), a free, erased, or
 * corrupt PEB, or header/padding bytes cannot be volume payload and remains an
 * established eraseblock boundary.
 */
const ubiOffsetInMappedLebData = (
  headerOffset: number,
  geometry: UbiGeometry,
  pebs: readonly UbiPeb[],
): boolean => {
  const pebIndex = Math.floor(headerOffset / geometry.pebSize);
  const inPeb = headerOffset % geometry.pebSize;
  if (inPeb < geometry.dataOffset) return false;
  const peb = pebs[pebIndex];
  if (peb?.state !== "mapped" || peb.vid.volId === UBI_LAYOUT_VOLUME_ID)
    return false;
  const dataEnd =
    peb.vid.volType === VOLUME_TYPE_STATIC
      ? geometry.dataOffset + peb.vid.dataSize
      : geometry.pebSize - peb.vid.dataPad;
  return inPeb + UBI_HEADER_BYTES <= dataEnd;
};

/**
 * File offsets on a passed-over candidate's grid that lie outside both
 * `geometry`'s eraseblock grid and every mapped non-layout LEB's data area.
 * `knownHeader` is true at `candidateOffset`, which the search already
 * validated as an EC header; later multiples need an EC header check.
 */
function* ubiPassedOverBoundaryProbes(
  candidateOffset: number,
  geometry: UbiGeometry,
  pebs: readonly UbiPeb[],
  fileSize: number,
): Generator<{ readonly offset: number; readonly knownHeader: boolean }, void> {
  for (
    let offset = candidateOffset;
    offset + UBI_HEADER_BYTES <= fileSize;
    offset += candidateOffset
  ) {
    if (offset % geometry.pebSize === 0) continue;
    if (ubiOffsetInMappedLebData(offset, geometry, pebs)) continue;
    yield { offset, knownHeader: offset === candidateOffset };
  }
}

/**
 * Smaller eraseblock sizes on the 512-byte grid that divide `pebSize` and
 * still leave a LEB after `dataOffset`, ordered largest first.
 */
const ubiSmallerDivisors = (pebSize: number, dataOffset: number): number[] => {
  const units = pebSize / UBI_PEB_ALIGNMENT;
  const sizes: number[] = [];
  for (let d = 1; d * d <= units; d += 1) {
    if (units % d !== 0) continue;
    const high = d === 1 ? 0 : (units / d) * UBI_PEB_ALIGNMENT;
    if (high > dataOffset) sizes.push(high);
    const low = d * UBI_PEB_ALIGNMENT;
    if (low !== high && low < pebSize && low > dataOffset) sizes.push(low);
  }
  return sizes.sort((left, right) => right - left);
};

/**
 * Offsets inside one `pebSize` eraseblock where an eraseblock of a smaller
 * candidate size would begin: multiples of every size on the 512-byte grid
 * that divides `pebSize`, still leaves a LEB after `dataOffset`, and passes
 * `admit`.
 */
const ubiCandidateGridOffsets = (
  pebSize: number,
  dataOffset: number,
  admit: (smallerPebSize: number) => boolean = () => true,
): ReadonlySet<number> => {
  const offsets = new Set<number>();
  for (const size of ubiSmallerDivisors(pebSize, dataOffset)) {
    if (!admit(size)) continue;
    for (let offset = size; offset < pebSize; offset += size)
      offsets.add(offset);
  }
  return offsets;
};

/** The file range searched by `findSpacingConflict` for a measured size. */
const ubiSpacingCheckRange = (
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
const ubiSpacingConflict = (
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
const ubiGeometry = (
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
 * All smaller eraseblock sizes on the 512-byte grid that divide the measured
 * size and still leave a LEB. Volume-table `data_pad === leb_size % alignment`
 * is not monotonic across divisors, so every eligible divisor must be checked.
 */
const ubiSmallerPebSizes = (geometry: UbiGeometry): number[] =>
  ubiSmallerDivisors(geometry.pebSize, geometry.dataOffset);

/**
 * Whether the first `headerReadBytes` at a would-be smaller-grid eraseblock
 * start keep the smaller geometry plausible: either both EC and VID headers
 * are erased, or a recognizable damaged UBI header (`UBI#` magic or a
 * CRC-valid VID header) sits there and would classify as a corrupt PEB under
 * the smaller geometry rather than proving written LEB payload.
 */
const ubiSmallerGridPositionPlausible = (
  bytes: Uint8Array,
  geometry: UbiGeometry,
): boolean => {
  if (bytes.length < geometry.headerReadBytes) return false;
  const ecBytes = bytes.subarray(0, UBI_HEADER_BYTES);
  const vidBytes = bytes.subarray(
    geometry.vidHeaderOffset,
    geometry.vidHeaderOffset + UBI_HEADER_BYTES,
  );
  return (
    (isErased(ecBytes) && isErased(vidBytes)) ||
    hasMagic(ecBytes, 0, UBI_EC_MAGIC) ||
    readVidHeader(vidBytes).state === "valid"
  );
};

/**
 * Whether the image still reads as eraseblocks of `smallerPebSize`: a volume
 * table copy (`tableCopies`, read at the layout volume's LEB 0 and LEB 1)
 * stays valid under `smallerPebSize`, and no declared static volume LEB has a
 * CRC-verified payload spanning past `smallerPebSize`. An unverified or orphan
 * VID that does not fit `smallerPebSize` would classify as a corrupt PEB under
 * `smallerPebSize`, so it does not rule the smaller size out.
 */
const ubiSmallerPebSizePlausible = async (
  ctx: UbiParseContext,
  geometry: UbiGeometry,
  pebs: readonly UbiPeb[],
  smallerPebSize: number,
  tableCopies: readonly [Uint8Array | null, Uint8Array | null],
): Promise<Result<boolean, ParseFailureError<"limit">>> => {
  const lebSize = smallerPebSize - geometry.dataOffset;
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
  const smallerTable = parseUbiVolumeTable(
    [
      left?.subarray(0, tableBytes) ?? null,
      right?.subarray(0, tableBytes) ?? null,
    ],
    smaller,
  );
  if (!smallerTable.ok) return ok(false);
  const staticRecords = new Map<number, UbiVolumeRecord>();
  for (const record of smallerTable.value.records)
    if (record.type === "static") staticRecords.set(record.id, record);
  for (const [index, peb] of pebs.entries()) {
    if (
      peb.state !== "mapped" ||
      peb.vid.volType !== VOLUME_TYPE_STATIC ||
      peb.vid.volId === UBI_LAYOUT_VOLUME_ID
    )
      continue;
    const record = staticRecords.get(peb.vid.volId);
    if (
      record === undefined ||
      peb.vid.lnum >= record.reservedPebs ||
      peb.vid.dataPad !== record.dataPad ||
      peb.vid.dataSize <= lebSize - peb.vid.dataPad
    )
      continue;
    const offset = index * geometry.pebSize + geometry.dataOffset;
    if (offset + peb.vid.dataSize > ctx.fileSize) continue;
    const matches = await verifyUbiPayload(ctx, offset, peb.vid);
    if (!matches.ok) return matches;
    if (matches.value) return ok(false);
  }
  return ok(true);
};

/**
 * The refusal when every header position of `smallerPebSize` off the measured
 * grid is erased or holds a recognizable damaged UBI header: the image is
 * equally a run of `smallerPebSize` eraseblocks, and the bytes cannot say which.
 */
const ubiAmbiguousPebSize = (
  geometry: UbiGeometry,
  smallerPebSize: number,
): UbiImageParseError =>
  malformed(
    `UBI image also fits a ${String(smallerPebSize)}-byte eraseblock size, because every header position on that grid between the ${String(geometry.pebSize)}-byte eraseblocks is erased or holds a damaged UBI header, so the eraseblock size is ambiguous`,
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
      /**
       * The smallest eraseblock size a CRC-valid VID header's data_pad and
       * data_size fit, when they do not fit this geometry's LEB.
       */
      readonly vidMinPebSize?: number;
      /** A static VID whose declared payload crosses this PEB's boundary. */
      readonly spanningStaticVid?: UbiVidHeader;
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
 * The smallest eraseblock size that fits the VID header, or 0 when the
 * header is invalid. As `classifyUbiPeb` requires, the LEB must hold data_pad
 * plus data_size and more than data_pad.
 */
const ubiVidMinPebSize = (vidBytes: Uint8Array, ec: UbiEcHeader): number => {
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
      !isErased(vidBytes)
        ? {
            state: "corrupt",
            reason: "erased erase-counter header before a written VID header",
            ec: null,
          }
        : !isErased(bytes)
          ? {
              state: "corrupt",
              reason: "erased headers before written eraseblock bytes",
              ec: null,
            }
          : { state: "erased" },
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
      ...(isVolumeType(vid.volType)
        ? {
            vidMinPebSize:
              geometry.dataOffset + vid.dataPad + Math.max(vid.dataSize, 1),
          }
        : {}),
      ...(vid.volType === VOLUME_TYPE_STATIC &&
      vid.volId !== UBI_LAYOUT_VOLUME_ID &&
      vid.dataSize > geometry.lebSize
        ? { spanningStaticVid: vid }
        : {}),
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
const checkUbiPebs = (
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
const ubiVolumeTableBytes = (geometry: UbiGeometry): number =>
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
const parseUbiVolumeTable = (
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
 * `vid.dataSize` bytes at their data offset and checks the payload CRC.
 */
const ubiCopiesToVerify = (pebs: readonly UbiPeb[]): number[] => {
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
 * Whether a layout-volume VID header permits reading `tableBytes` of
 * volume-table records from its LEB. Linux UBI defines the internal layout
 * volume as dynamic with alignment 1 (`data_pad === 0`); a wear-leveling
 * copy (`copy_flag !== 0`) also declares how many bytes were copied in
 * `data_size`, which must cover the full table.
 */
const isValidLayoutVid = (
  vid: UbiVidHeader,
  geometry: UbiGeometry,
  tableBytes: number,
): boolean =>
  vid.volType === VOLUME_TYPE_DYNAMIC &&
  vid.dataPad === 0 &&
  geometry.lebSize - vid.dataPad >= tableBytes &&
  (vid.copyFlag === 0 || vid.dataSize >= tableBytes);

/**
 * The layout volume's usable LEB 0 and LEB 1 PEBs, as `winningLebs` selects
 * them. A layout LEB whose surviving winner is an unverified wear-leveling
 * copy (its data CRC failed with no verified copy to fall back to) or whose
 * VID header does not permit the volume table bytes returns null so it is
 * excluded before choosing the volume table.
 */
const ubiLayoutVolumePebs = (
  pebs: readonly UbiPeb[],
  verifiedCopies: ReadonlySet<number>,
  geometry: UbiGeometry,
): readonly [number | null, number | null] => {
  const layout = winningLebs(pebs, verifiedCopies).lebs.get(
    UBI_LAYOUT_VOLUME_ID,
  );
  const tableBytes = ubiVolumeTableBytes(geometry);
  const usable = (lnum: 0 | 1): number | null => {
    const winner = layout?.get(lnum);
    return winner === undefined ||
      winner.unverified ||
      !isValidLayoutVid(winner.vid, geometry, tableBytes)
      ? null
      : winner.peb;
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
  // When corrupt PEBs are present, a volume with no surviving mappings cannot
  // prove emptiness, and a dynamic volume with fewer mapped LEBs than
  // reserved_pebs cannot prove where it ends.
  const lost =
    corruptPebsPresent &&
    (record.type === "dynamic"
      ? inRange.length < record.reservedPebs
      : inRange.length === 0);
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
const assembleUbiImage = (
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
  const stateCounts = { mapped: 0, free: 0, erased: 0, corrupt: 0 };
  let layoutPebCount = 0;
  for (const peb of pebs) {
    stateCounts[peb.state] += 1;
    if (peb.state === "mapped" && peb.vid.volId === UBI_LAYOUT_VOLUME_ID)
      layoutPebCount += 1;
  }
  const corruptPebCount = stateCounts.corrupt;
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
    mappedPebCount: stateCounts.mapped,
    freePebCount: stateCounts.free,
    erasedPebCount: stateCounts.erased,
    corruptPebCount,
    layoutPebCount,
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

/**
 * Outcome of checking one dividing PEB size candidate against its PEBs,
 * volume table, and smaller-grid constraints.
 */
type UbiPebCandidateVerdict =
  | { readonly state: "accept"; readonly image: UbiImage }
  | {
      readonly state: "retry";
      readonly error: UbiImageParseError;
      /**
       * The image this candidate yields when no later candidate is accepted,
       * set when only a CRC-valid VID header too large for it is in doubt.
       */
      readonly fallback?: UbiImage;
    }
  | { readonly state: "reject"; readonly error: UbiImageParseError }
  | { readonly state: "limit"; readonly error: ParseFailureError<"limit"> };

/** Inputs collected while provisionally evaluating one dividing PEB size. */
interface UbiPebCandidateCheck {
  readonly geometry: UbiGeometry;
  readonly pebs: readonly UbiPeb[];
  readonly tableCopies: readonly [Uint8Array | null, Uint8Array | null];
  readonly verifiedCopies: ReadonlySet<number>;
  readonly pebError: UbiImageParseError | null;
  readonly smallerGridError: UbiImageParseError | null;
  /**
   * Offset of a valid EC header on a passed-over candidate's grid that
   * `geometry` places outside every mapped non-layout LEB's data area, or null
   * when every passed-over header lies inside mapped non-layout LEB data.
   */
  readonly passedOverHeaderOffset?: number | null;
}

/**
 * Decide whether a dividing PEB size candidate is accepted, definitively
 * rejected, or provisional and retryable at the next candidate.
 *
 * A smaller-grid conflict or erased-grid ambiguity always rejects because a
 * smaller geometry still fits. Otherwise a candidate with no valid volume
 * table stays provisional so the caller can try the next candidate while
 * keeping the first failure in case no later candidate succeeds. A candidate
 * whose table validates still cannot be accepted when a valid EC header on a
 * passed-over candidate grid lies outside every mapped non-layout LEB's data
 * area; it stays retryable so the caller keeps the first failure unless a
 * later geometry explains every passed-over header. With a valid table, a
 * PEB error allows a retry when its header lies in the minimum span of an
 * undersized LEB's continuation, or a static LEB's payload crosses the
 * candidate boundary and verifies against its data CRC. The later geometry
 * still has to account for passed-over headers. An undersized LEB in an
 * otherwise valid candidate allows a retry with the image kept as a fallback.
 */
const judgeUbiPebCandidate = async (
  ctx: UbiParseContext,
  {
    geometry,
    pebs,
    tableCopies,
    verifiedCopies,
    pebError,
    smallerGridError,
    passedOverHeaderOffset = null,
  }: UbiPebCandidateCheck,
): Promise<UbiPebCandidateVerdict> => {
  if (smallerGridError !== null)
    return { state: "reject", error: smallerGridError };
  const table = parseUbiVolumeTable(tableCopies, geometry);
  if (!table.ok) return { state: "retry", error: pebError ?? table.error };
  const errorOffset = pebError?.failure.offset;
  const undersized = pebs.findIndex((peb, index) => {
    if (
      peb.state !== "corrupt" ||
      peb.vidMinPebSize === undefined ||
      peb.vidMinPebSize <= geometry.pebSize
    )
      return false;
    if (pebError === null) return true;
    if (errorOffset === undefined) return false;
    const distance = errorOffset - index * geometry.pebSize;
    return distance >= geometry.pebSize && distance < peb.vidMinPebSize;
  });
  if (pebError !== null) {
    if (undersized !== -1) return { state: "retry", error: pebError };
    for (const [index, peb] of pebs.entries()) {
      if (peb.state !== "corrupt" || peb.spanningStaticVid === undefined)
        continue;
      const vid = peb.spanningStaticVid;
      const offset = index * geometry.pebSize + geometry.dataOffset;
      if (
        geometry.dataOffset + vid.dataSize + vid.dataPad > UBI_MAX_PEB_BYTES ||
        offset + vid.dataSize > ctx.fileSize
      )
        continue;
      const matches = await verifyUbiPayload(ctx, offset, vid);
      if (!matches.ok) return { state: "limit", error: matches.error };
      if (matches.value) return { state: "retry", error: pebError };
    }
    return { state: "reject", error: pebError };
  }
  if (passedOverHeaderOffset !== null)
    return {
      state: "retry",
      error: ubiSpacingConflict(geometry.pebSize, passedOverHeaderOffset),
    };
  const verifiedPebs = await verifyErasedPebBodies(ctx, geometry, pebs);
  const image = assembleUbiImage(
    geometry,
    verifiedPebs,
    table.value,
    verifiedCopies,
  );
  if (undersized !== -1) {
    const peb = pebs[undersized];
    const needed = peb?.state === "corrupt" ? (peb.vidMinPebSize ?? 0) : 0;
    return {
      state: "retry",
      error: malformed(
        `UBI eraseblock ${String(undersized)} has a valid VID header that needs a ${String(needed)}-byte eraseblock, larger than ${String(geometry.pebSize)} bytes`,
        undersized * geometry.pebSize,
      ),
      fallback: image,
    };
  }
  return { state: "accept", image };
};

/** Positional byte reader for a UBI image; every requested range lies within `fileSize`. */
export type UbiImageRead = (
  offset: number,
  length: number,
) => Promise<Uint8Array> | Uint8Array;

export interface UbiErasedBodyVerificationStats {
  readonly erasedRangeCount: number;
  readonly nonErasedOffsetCount: number;
  readonly rangeWalkSteps: number;
}

export interface UbiEcHeaderCacheStats {
  readonly cachedHeaderCount: number;
  readonly ecHeaderScanEnd: number;
  readonly cacheCapped: boolean;
}

export interface ParseUbiImageOptions {
  /**
   * Called before scan chunks and header-probe batches. When `yieldControl` is
   * true, async callers can yield to the event loop before checking liveness.
   */
  readonly checkpoint?: (yieldControl: boolean) => Promise<void> | void;
  /**
   * Optional observer invoked after each erased-body verification pass with
   * coalesced range-cache and cursor-walk counts.
   */
  readonly onErasedBodyVerification?: (
    stats: UbiErasedBodyVerificationStats,
  ) => void;
  /**
   * Optional observer invoked when parsing finishes with EC header scan cache
   * retention statistics.
   */
  readonly onEcHeaderCacheStats?: (stats: UbiEcHeaderCacheStats) => void;
}

interface UbiErasedRange {
  readonly start: number;
  readonly end: number;
}

interface UbiParseContext {
  readonly fileSize: number;
  readonly candidateScanEnd: number;
  staticPayloadCrcBytes: number;
  readonly payloadCrcs: Map<string, number | null>;
  erasedRanges: UbiErasedRange[];
  nonErasedOffsets: number[];
  /**
   * Next 512-byte-aligned offset not yet cached for CRC-valid EC headers, or
   * `fileSize` once the whole image has been cached. Stops advancing once
   * `validEcHeaderOffsets` reaches `UBI_MAX_CACHED_EC_HEADERS`.
   */
  ecHeaderScanEnd: number;
  ecHeaderCacheCapped: boolean;
  /**
   * Sorted 512-byte-aligned offsets in `[ubiPebSearchStart(first), ecHeaderScanEnd)`
   * holding a CRC-valid EC header, whatever its layout.
   */
  readonly validEcHeaderOffsets: number[];
  readonly validEcHeaderOffsetSet: Set<number>;
  /**
   * Parsed EC headers for offsets within `candidateScanEnd`, removed as the
   * candidate loop advances past each offset.
   */
  readonly pendingCandidateHeaders: Map<number, UbiEcHeader>;
  /**
   * Cached `ubiSmallerGridPositionPlausible` results by file offset; depends
   * only on `first.vidHeaderOffset`, so it is invariant across trials.
   */
  readonly smallerGridPositions: Map<number, boolean>;
  readonly first: UbiEcHeader;
  readonly read: UbiImageRead;
  readonly checkpoint:
    | ((yieldControl: boolean) => Promise<void> | void)
    | undefined;
  readonly onErasedBodyVerification:
    | ((stats: UbiErasedBodyVerificationStats) => void)
    | undefined;
  readonly onEcHeaderCacheStats:
    | ((stats: UbiEcHeaderCacheStats) => void)
    | undefined;
}

const verifyUbiPayload = async (
  ctx: UbiParseContext,
  offset: number,
  vid: UbiVidHeader,
): Promise<Result<boolean, ParseFailureError<"limit">>> => {
  // Cache the computed CRC for both static and dynamic payloads across
  // candidate block sizes, since the expected value belongs to the VID.
  const key = `${String(offset)}/${String(vid.dataSize)}`;
  const cached = ctx.payloadCrcs.get(key);
  if (cached !== undefined) return ok(cached === vid.dataCrc);
  if (vid.volType === VOLUME_TYPE_STATIC) {
    const maximum = 2 * ctx.fileSize;
    if (vid.dataSize > maximum - ctx.staticPayloadCrcBytes)
      return err(
        decodeLimit(
          UBI_FORMAT,
          `UBI static payload CRC verification exceeds the ${String(maximum)}-byte per-image budget`,
          { name: UBI_STATIC_PAYLOAD_CRC_LIMIT, maximum },
          { offset },
        ),
      );
    ctx.staticPayloadCrcBytes += vid.dataSize;
  }
  await ctx.checkpoint?.(true);
  const data = await ctx.read(offset, vid.dataSize);
  const crc = data.length === vid.dataSize ? ubiCrc(data) : null;
  ctx.payloadCrcs.set(key, crc);
  return ok(crc === vid.dataCrc);
};

type PendingCandidateFailure =
  | { readonly kind: "error"; readonly error: UbiImageParseError }
  | { readonly kind: "non-dividing"; readonly candidate: number };

const scanNextEcHeaderChunk = async (
  ctx: UbiParseContext,
  limit: number,
  yieldControl: boolean,
): Promise<number> => {
  const start = ctx.ecHeaderScanEnd;
  const boundedLimit = Math.min(ctx.fileSize, limit);
  const previousCount = ctx.validEcHeaderOffsets.length;
  if (
    start >= boundedLimit ||
    ctx.validEcHeaderOffsets.length >= UBI_MAX_CACHED_EC_HEADERS
  )
    return previousCount;
  await ctx.checkpoint?.(yieldControl);
  const readEnd = Math.min(
    ctx.fileSize,
    Math.min(
      start + SCAN_CHUNK_BYTES,
      Math.max(boundedLimit, start + UBI_HEADER_BYTES),
    ),
  );
  const length = readEnd - start;
  if (length < UBI_HEADER_BYTES) {
    ctx.ecHeaderScanEnd = ctx.fileSize;
    return previousCount;
  }
  const chunk = await ctx.read(start, length);
  for (const { offset, header } of ubiEcHeaderOffsets(
    chunk,
    start,
    start,
    () => true,
  )) {
    if (ctx.validEcHeaderOffsets.length >= UBI_MAX_CACHED_EC_HEADERS) {
      // Stop caching at `offset` so `ecHeaderScanEnd` stays the exact
      // high-water mark of the cached prefix; callers stream from here.
      ctx.ecHeaderCacheCapped = true;
      ctx.ecHeaderScanEnd = offset;
      return previousCount;
    }
    ctx.validEcHeaderOffsets.push(offset);
    ctx.validEcHeaderOffsetSet.add(offset);
    if (offset + UBI_HEADER_BYTES <= ctx.candidateScanEnd)
      ctx.pendingCandidateHeaders.set(offset, header);
  }
  const lastChecked =
    start +
    Math.floor((length - UBI_HEADER_BYTES) / UBI_PEB_ALIGNMENT) *
      UBI_PEB_ALIGNMENT;
  ctx.ecHeaderScanEnd = Math.min(ctx.fileSize, lastChecked + UBI_PEB_ALIGNMENT);
  return previousCount;
};

const streamEcHeader = async (
  ctx: UbiParseContext,
  start: number,
  end: number,
  admit: (offset: number) => boolean,
  initialChunks: number,
): Promise<number | null> => {
  const boundedEnd = Math.min(ctx.fileSize, end);
  let chunks = initialChunks;
  let scan = Math.ceil(start / UBI_PEB_ALIGNMENT) * UBI_PEB_ALIGNMENT;
  while (scan < boundedEnd) {
    const readEnd = Math.min(
      ctx.fileSize,
      Math.min(
        scan + SCAN_CHUNK_BYTES,
        Math.max(boundedEnd, scan + UBI_HEADER_BYTES),
      ),
    );
    const length = readEnd - scan;
    if (length < UBI_HEADER_BYTES) return null;
    await ctx.checkpoint?.(chunks % 16 === 0);
    chunks += 1;
    const chunk = await ctx.read(scan, length);
    for (const { offset } of ubiEcHeaderOffsets(chunk, scan, scan, admit)) {
      if (offset >= boundedEnd) return null;
      return offset;
    }
    const lastChecked =
      scan +
      Math.floor((length - UBI_HEADER_BYTES) / UBI_PEB_ALIGNMENT) *
        UBI_PEB_ALIGNMENT;
    scan = lastChecked + UBI_PEB_ALIGNMENT;
  }
  return null;
};

/**
 * The first 512-byte-aligned offset in `[start, end)` holding a CRC-valid EC
 * header that satisfies `admit`, reusing and incrementally extending the
 * parse-wide EC header scan cache up to `UBI_MAX_CACHED_EC_HEADERS` and
 * streaming uncached tail ranges once the cache cap is reached.
 */
const findCachedEcHeader = async (
  ctx: UbiParseContext,
  start: number,
  end: number,
  admit: (offset: number) => boolean,
): Promise<number | null> => {
  const boundedEnd = Math.min(ctx.fileSize, end);
  if (start >= boundedEnd) return null;
  for (const offset of ctx.validEcHeaderOffsets) {
    if (offset >= boundedEnd) return null;
    if (offset >= start && admit(offset)) return offset;
  }
  let chunks = 0;
  while (
    ctx.ecHeaderScanEnd < boundedEnd &&
    ctx.validEcHeaderOffsets.length < UBI_MAX_CACHED_EC_HEADERS
  ) {
    const fromIndex = await scanNextEcHeaderChunk(
      ctx,
      boundedEnd,
      chunks % 16 === 0,
    );
    chunks += 1;
    for (
      let index = fromIndex;
      index < ctx.validEcHeaderOffsets.length;
      index += 1
    ) {
      const offset = ctx.validEcHeaderOffsets[index]!;
      if (offset >= boundedEnd) return null;
      if (offset >= start && admit(offset)) return offset;
    }
  }
  if (ctx.ecHeaderScanEnd < boundedEnd) {
    ctx.ecHeaderCacheCapped = true;
    return streamEcHeader(
      ctx,
      Math.max(start, ctx.ecHeaderScanEnd),
      boundedEnd,
      admit,
      chunks,
    );
  }
  return null;
};

const findSpacingConflict = (
  ctx: UbiParseContext,
  pebSize: number,
  candidates: ReadonlySet<number>,
): Promise<number | null> => {
  const { start, end } = ubiSpacingCheckRange(pebSize, ctx.fileSize);
  return findCachedEcHeader(ctx, start, end, (offset) =>
    candidates.has(offset % pebSize),
  );
};

const findPassedOverBoundary = async (
  ctx: UbiParseContext,
  geometry: UbiGeometry,
  pebs: readonly UbiPeb[],
  passedOver: readonly number[],
): Promise<number | null> => {
  let probes = 0;
  for (const candidateOffset of passedOver) {
    for (const probe of ubiPassedOverBoundaryProbes(
      candidateOffset,
      geometry,
      pebs,
      ctx.fileSize,
    )) {
      if (probe.knownHeader) return probe.offset;
      if (probe.offset < ctx.ecHeaderScanEnd) {
        if (ctx.validEcHeaderOffsetSet.has(probe.offset)) return probe.offset;
        continue;
      }
      await ctx.checkpoint?.(probes % 256 === 0);
      probes += 1;
      const bytes = await ctx.read(probe.offset, UBI_HEADER_BYTES);
      if (ubiHasValidEcHeader(bytes)) return probe.offset;
    }
  }
  return null;
};

const findSmallerGridError = async (
  ctx: UbiParseContext,
  measured: UbiGeometry,
  pebs: readonly UbiPeb[],
  tableCopies: readonly [Uint8Array | null, Uint8Array | null],
): Promise<Result<UbiImageParseError | null, ParseFailureError<"limit">>> => {
  // A smaller size the volume table or a CRC-verified static LEB rules out
  // cannot begin an eraseblock, so a header on only its grid is payload.
  const plausibleSizes: number[] = [];
  for (const smaller of ubiSmallerPebSizes(measured)) {
    const holds = await ubiSmallerPebSizePlausible(
      ctx,
      measured,
      pebs,
      smaller,
      tableCopies,
    );
    if (!holds.ok) return holds;
    if (holds.value) plausibleSizes.push(smaller);
  }
  if (plausibleSizes.length === 0) return ok(null);
  const plausibleOffsets = new Set<number>();
  for (const size of plausibleSizes)
    for (let offset = size; offset < measured.pebSize; offset += size)
      plausibleOffsets.add(offset);
  // A valid header where an eraseblock of a smaller size would begin shows
  // the measured size skipped eraseblocks, wherever it lies in the image.
  const header = await findCachedEcHeader(
    ctx,
    ubiPebSearchStart(ctx.first),
    ctx.fileSize,
    (offset) => plausibleOffsets.has(offset % measured.pebSize),
  );
  if (header !== null) return ok(ubiSpacingConflict(measured.pebSize, header));
  // Erased eraseblocks or damaged UBI headers between measured PEBs fit a
  // smaller size equally well; a non-header written byte at any off-grid
  // header position rules that smaller size out.
  for (const smaller of plausibleSizes) {
    let fits = true;
    let probes = 0;
    for (
      let offset = smaller;
      fits && offset < ctx.fileSize;
      offset += smaller, probes += 1
    ) {
      if (offset % measured.pebSize === 0) continue;
      await ctx.checkpoint?.(probes % 256 === 0);
      const cached = ctx.smallerGridPositions.get(offset);
      if (cached !== undefined) {
        fits = cached;
      } else {
        fits = ubiSmallerGridPositionPlausible(
          await ctx.read(offset, measured.headerReadBytes),
          measured,
        );
        ctx.smallerGridPositions.set(offset, fits);
      }
    }
    if (fits) return ok(ubiAmbiguousPebSize(measured, smaller));
  }
  return ok(null);
};

const firstNonErasedByte = (bytes: Uint8Array): number => {
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] !== 0xff) return i;
  return -1;
};

const appendErasedRange = (
  ranges: UbiErasedRange[],
  start: number,
  end: number,
): void => {
  if (start >= end) return;
  const last = ranges.at(-1);
  if (last !== undefined && last.end >= start) {
    if (end > last.end) ranges[ranges.length - 1] = { start: last.start, end };
    return;
  }
  ranges.push({ start, end });
};

const mergeErasedRanges = (
  left: readonly UbiErasedRange[],
  right: readonly UbiErasedRange[],
): UbiErasedRange[] => {
  if (left.length === 0) return [...right];
  if (right.length === 0) return [...left];
  const merged: UbiErasedRange[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const next =
      left[leftIndex]!.start <= right[rightIndex]!.start
        ? left[leftIndex++]!
        : right[rightIndex++]!;
    appendErasedRange(merged, next.start, next.end);
  }
  while (leftIndex < left.length) {
    const next = left[leftIndex++]!;
    appendErasedRange(merged, next.start, next.end);
  }
  while (rightIndex < right.length) {
    const next = right[rightIndex++]!;
    appendErasedRange(merged, next.start, next.end);
  }
  return merged;
};

const mergeSortedNumbers = (
  left: readonly number[],
  right: readonly number[],
): number[] => {
  if (left.length === 0) return [...right];
  if (right.length === 0) return [...left];
  const merged: number[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const next =
      left[leftIndex]! <= right[rightIndex]!
        ? left[leftIndex++]!
        : right[rightIndex++]!;
    if (merged.at(-1) !== next) merged.push(next);
  }
  while (leftIndex < left.length) {
    const next = left[leftIndex++]!;
    if (merged.at(-1) !== next) merged.push(next);
  }
  while (rightIndex < right.length) {
    const next = right[rightIndex++]!;
    if (merged.at(-1) !== next) merged.push(next);
  }
  return merged;
};

const verifyErasedPebBodies = async (
  ctx: UbiParseContext,
  geometry: UbiGeometry,
  pebs: readonly UbiPeb[],
): Promise<readonly UbiPeb[]> => {
  let verified: UbiPeb[] | null = null;
  let erasedCursor = 0;
  let nonErasedCursor = 0;
  let chunks = 0;
  let rangeWalkSteps = 0;
  const newErasedRanges: UbiErasedRange[] = [];
  const newNonErasedOffsets: number[] = [];
  for (let index = 0; index < pebs.length; index += 1) {
    const peb = pebs[index]!;
    if (peb.state !== "erased") continue;
    const pebStart = index * geometry.pebSize;
    const bodyStart = pebStart + geometry.headerReadBytes;
    const pebEnd = pebStart + geometry.pebSize;
    // `classifyUbiPeb` already verified [pebStart, bodyStart) is all 0xFF, so
    // recording it lets adjacent erased blocks coalesce into a single range.
    appendErasedRange(newErasedRanges, pebStart, bodyStart);
    rangeWalkSteps += 1;
    while (
      nonErasedCursor < ctx.nonErasedOffsets.length &&
      ctx.nonErasedOffsets[nonErasedCursor]! < bodyStart
    ) {
      nonErasedCursor += 1;
      rangeWalkSteps += 1;
    }
    let erased = true;
    if (
      nonErasedCursor < ctx.nonErasedOffsets.length &&
      ctx.nonErasedOffsets[nonErasedCursor]! < pebEnd
    ) {
      erased = false;
    } else if (bodyStart < pebEnd) {
      while (
        erasedCursor < ctx.erasedRanges.length &&
        ctx.erasedRanges[erasedCursor]!.end <= bodyStart
      ) {
        erasedCursor += 1;
        rangeWalkSteps += 1;
      }
      const gaps: UbiErasedRange[] = [];
      let cursor = bodyStart;
      while (erasedCursor < ctx.erasedRanges.length) {
        const range = ctx.erasedRanges[erasedCursor]!;
        if (range.start >= pebEnd) break;
        rangeWalkSteps += 1;
        if (range.start > cursor)
          gaps.push({ start: cursor, end: range.start });
        cursor = Math.max(cursor, range.end);
        if (cursor >= pebEnd) break;
        erasedCursor += 1;
      }
      if (cursor < pebEnd) gaps.push({ start: cursor, end: pebEnd });
      for (const gap of gaps) {
        for (
          let offset = gap.start;
          offset < gap.end;
          offset += SCAN_CHUNK_BYTES, chunks += 1
        ) {
          await ctx.checkpoint?.(chunks % 16 === 0);
          const length = Math.min(SCAN_CHUNK_BYTES, gap.end - offset);
          const chunk = await ctx.read(offset, length);
          if (chunk.length < length) {
            erased = false;
            break;
          }
          const nonErased = firstNonErasedByte(chunk);
          if (nonErased !== -1) {
            appendErasedRange(newErasedRanges, offset, offset + nonErased);
            newNonErasedOffsets.push(offset + nonErased);
            rangeWalkSteps += 1;
            erased = false;
            break;
          }
          appendErasedRange(newErasedRanges, offset, offset + length);
          rangeWalkSteps += 1;
        }
        if (!erased) break;
      }
    }
    if (!erased) {
      verified ??= [...pebs];
      verified[index] = {
        state: "corrupt",
        reason: "erased headers before written eraseblock bytes",
        ec: null,
      };
    }
  }
  if (newErasedRanges.length > 0) {
    rangeWalkSteps += ctx.erasedRanges.length + newErasedRanges.length;
    ctx.erasedRanges = mergeErasedRanges(ctx.erasedRanges, newErasedRanges);
  }
  if (newNonErasedOffsets.length > 0) {
    rangeWalkSteps += ctx.nonErasedOffsets.length + newNonErasedOffsets.length;
    ctx.nonErasedOffsets = mergeSortedNumbers(
      ctx.nonErasedOffsets,
      newNonErasedOffsets,
    );
  }
  ctx.onErasedBodyVerification?.({
    erasedRangeCount: ctx.erasedRanges.length,
    nonErasedOffsetCount: ctx.nonErasedOffsets.length,
    rangeWalkSteps,
  });
  return verified ?? pebs;
};

const readVerifiedUbiTableCopies = async (
  ctx: UbiParseContext,
  geometry: UbiGeometry,
  pebs: readonly UbiPeb[],
): Promise<
  Result<
    {
      readonly verifiedCopies: ReadonlySet<number>;
      readonly tableCopies: readonly [Uint8Array | null, Uint8Array | null];
    },
    ParseFailureError<"limit">
  >
> => {
  const verifiedCopies = new Set<number>();
  for (const index of ubiCopiesToVerify(pebs)) {
    const peb = pebs[index];
    if (peb?.state !== "mapped") continue;
    const matches = await verifyUbiPayload(
      ctx,
      index * geometry.pebSize + geometry.dataOffset,
      peb.vid,
    );
    if (!matches.ok) return matches;
    if (matches.value) verifiedCopies.add(index);
  }
  const tableBytes = ubiVolumeTableBytes(geometry);
  const copies: (Uint8Array | null)[] = [];
  for (const peb of ubiLayoutVolumePebs(pebs, verifiedCopies, geometry))
    copies.push(
      peb === null
        ? null
        : await ctx.read(
            peb * geometry.pebSize + geometry.dataOffset,
            tableBytes,
          ),
    );
  return ok({
    verifiedCopies,
    tableCopies: [copies[0] ?? null, copies[1] ?? null],
  });
};

const evaluateUbiPebCandidate = async (
  ctx: UbiParseContext,
  candidate: number,
  passedOver: readonly number[],
): Promise<UbiPebCandidateVerdict> => {
  const measured = ubiGeometry(ctx.first, candidate, ctx.fileSize, null);
  if (!measured.ok) return { state: "retry", error: measured.error };
  const pebs: UbiPeb[] = [];
  let pebError: UbiImageParseError | null = null;
  for (let index = 0; index < measured.value.pebCount; index += 1) {
    await ctx.checkpoint?.(index % 256 === 0);
    const peb = classifyUbiPeb(
      await ctx.read(
        index * measured.value.pebSize,
        measured.value.headerReadBytes,
      ),
      index,
      measured.value,
    );
    if (peb.ok) {
      pebs.push(peb.value);
    } else {
      pebError ??= peb.error;
      pebs.push({ state: "corrupt", reason: peb.error.message, ec: null });
    }
  }
  let geometry = measured.value;
  if (pebError === null) {
    const checked = checkUbiPebs(measured.value, pebs);
    if (checked.ok) geometry = checked.value;
    else pebError = checked.error;
  }
  const copies = await readVerifiedUbiTableCopies(ctx, geometry, pebs);
  if (!copies.ok) return { state: "limit", error: copies.error };
  const { verifiedCopies, tableCopies } = copies.value;
  const smallerGrid = await findSmallerGridError(
    ctx,
    measured.value,
    pebs,
    tableCopies,
  );
  if (!smallerGrid.ok) return { state: "limit", error: smallerGrid.error };
  const smallerGridError = smallerGrid.value;
  const passedOverHeaderOffset =
    smallerGridError === null &&
    pebError === null &&
    (tableCopies[0] !== null || tableCopies[1] !== null) &&
    passedOver.length > 0
      ? await findPassedOverBoundary(ctx, geometry, pebs, passedOver)
      : null;
  return judgeUbiPebCandidate(ctx, {
    geometry,
    pebs,
    tableCopies,
    verifiedCopies,
    pebError,
    smallerGridError,
    passedOverHeaderOffset,
  });
};

const resolvePendingFailure = async (
  ctx: UbiParseContext,
  failure: PendingCandidateFailure,
): Promise<UbiImageParseError> => {
  if (failure.kind === "error") return failure.error;
  const conflict = await findSpacingConflict(
    ctx,
    failure.candidate,
    ubiCandidateGridOffsets(failure.candidate, ctx.first.dataOffset),
  );
  const measured = ubiGeometry(
    ctx.first,
    failure.candidate,
    ctx.fileSize,
    conflict,
  );
  if (!measured.ok) return measured.error;
  return malformed("UBI image eraseblock size could not be determined");
};

const resolveUnacceptedUbiImage = async (
  ctx: UbiParseContext,
  firstFailure: PendingCandidateFailure | null,
  anyNext: number | null,
): Promise<Result<UbiImage, UbiImageParseError>> => {
  if (firstFailure !== null)
    return err(await resolvePendingFailure(ctx, firstFailure));
  const conflict =
    anyNext === null
      ? null
      : await findSpacingConflict(
          ctx,
          anyNext,
          ubiCandidateGridOffsets(anyNext, ctx.first.dataOffset),
        );
  const measured = ubiGeometry(ctx.first, anyNext, ctx.fileSize, conflict);
  if (!measured.ok) return measured;
  return err(malformed("UBI image eraseblock size could not be determined"));
};

/**
 * Parse a UBI image by scanning candidate eraseblock sizes through `read`.
 *
 * Dividing candidates stay provisional until their PEB count, volume table,
 * LEB, and passed-over boundary constraints agree. Non-dividing mapped second
 * PEBs also stay provisional as passed-over boundaries: a later dividing
 * candidate may accept only if it places every passed-over header inside
 * mapped non-layout LEB data; otherwise the first failure stands. A candidate
 * too small only for a CRC-valid VID header is kept as the fallback when no
 * later candidate is accepted.
 */
export const parseUbiImage = async (
  fileSize: number,
  read: UbiImageRead,
  options?: ParseUbiImageOptions,
): Promise<Result<UbiImage, UbiImageParseError>> => {
  const first = parseUbiFirstEcHeader(
    await read(0, Math.min(fileSize, UBI_HEADER_BYTES)),
    fileSize,
  );
  if (!first.ok) return first;
  const candidateScanEnd = Math.min(
    fileSize,
    UBI_MAX_PEB_BYTES + UBI_HEADER_BYTES,
  );
  const ctx: UbiParseContext = {
    fileSize,
    candidateScanEnd,
    staticPayloadCrcBytes: 0,
    payloadCrcs: new Map(),
    erasedRanges: [],
    nonErasedOffsets: [],
    ecHeaderScanEnd: Math.min(fileSize, ubiPebSearchStart(first.value)),
    ecHeaderCacheCapped: false,
    validEcHeaderOffsets: [],
    validEcHeaderOffsetSet: new Set(),
    pendingCandidateHeaders: new Map(),
    smallerGridPositions: new Map(),
    first: first.value,
    read,
    checkpoint: options?.checkpoint,
    onErasedBodyVerification: options?.onErasedBodyVerification,
    onEcHeaderCacheStats: options?.onEcHeaderCacheStats,
  };
  let fallback: UbiImage | null = null;
  let anyNext: number | null = null;
  let firstFailure: PendingCandidateFailure | null = null;
  const passedOver: number[] = [];
  let candidateIndex = 0;
  try {
    for (;;) {
      if (candidateIndex >= ctx.validEcHeaderOffsets.length) {
        if (ctx.ecHeaderScanEnd >= ctx.candidateScanEnd) break;
        await scanNextEcHeaderChunk(ctx, ctx.candidateScanEnd, false);
        continue;
      }
      const candidate = ctx.validEcHeaderOffsets[candidateIndex]!;
      candidateIndex += 1;
      if (candidate + UBI_HEADER_BYTES > ctx.candidateScanEnd) break;
      const header = ctx.pendingCandidateHeaders.get(candidate);
      ctx.pendingCandidateHeaders.delete(candidate);
      anyNext ??= candidate;
      if (fileSize % candidate === 0) {
        const verdict = await evaluateUbiPebCandidate(
          ctx,
          candidate,
          passedOver,
        );
        if (verdict.state === "limit") return err(verdict.error);
        if (verdict.state === "accept") return ok(verdict.image);
        if (verdict.state === "reject")
          return fallback !== null
            ? ok(fallback)
            : err(
                firstFailure === null
                  ? verdict.error
                  : await resolvePendingFailure(ctx, firstFailure),
              );
        fallback ??= verdict.fallback ?? null;
        firstFailure ??= { kind: "error", error: verdict.error };
        passedOver.push(candidate);
        continue;
      }
      const candidateVid = candidate + first.value.vidHeaderOffset;
      if (
        header !== undefined &&
        candidateVid + UBI_HEADER_BYTES <= fileSize &&
        ubiHasMappedSecondPeb(
          await read(candidateVid, UBI_HEADER_BYTES),
          first.value,
          header,
          candidate,
        )
      ) {
        firstFailure ??= { kind: "non-dividing", candidate };
        passedOver.push(candidate);
      }
    }
    return fallback !== null
      ? ok(fallback)
      : await resolveUnacceptedUbiImage(ctx, firstFailure, anyNext);
  } finally {
    ctx.onEcHeaderCacheStats?.({
      cachedHeaderCount: ctx.validEcHeaderOffsets.length,
      ecHeaderScanEnd: ctx.ecHeaderScanEnd,
      cacheCapped: ctx.ecHeaderCacheCapped,
    });
  }
};
