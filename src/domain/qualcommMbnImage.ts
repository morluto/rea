import { hasElfMagic, BinaryReader } from "./binaryContainer.js";
import { readElfFixedHeader, type ElfFixedHeader } from "./elfFixedHeader.js";
import {
  elfProgramHeaderWidth,
  readElfProgramHeader,
} from "./elfProgramHeader.js";
import { readElfRawTableDeclarations } from "./elfRawTableDeclarations.js";
import { CoverageAccumulator } from "./coverageAccumulator.js";

/**
 * Qualcomm MBN header and ELF hash-segment facts.
 *
 * Legacy images use the little-endian boot image header: 40 bytes for
 * version 3 and 80 bytes for versions 5 and 6. Those words stay
 * little-endian even when a surrounding ELF image is big-endian. An ELF
 * modem image keeps its ELF classification. A program header whose
 * `p_flags` bits 24-26 equal 2 (Linux `QCOM_MDT_TYPE_HASH`) carries the
 * same header, and the code range inside that segment is the hash table.
 *
 * A legacy header has no magic, so it is claimed only when its code region
 * lies wholly inside the file: the image size may run past the end of a
 * truncated dump, and the missing signature, certificate or metadata ranges
 * are then limitations, but a header-sized pattern with no code bytes behind
 * it is not an image. An already located ELF hash segment does not need that
 * recognition gate, so a readable header is decoded even when its hash table
 * runs past the file end; the truncated table is reported as a limitation and
 * omitted from stored regions.
 *
 * `e_phnum` 65535 is the ELF extended numbering sentinel. This parser does
 * not read section 0, so that count stays unknown rather than a scan of
 * 65535 rows. A direct count is scanned only when the whole table lies in
 * the file. That extent is the format's own bound, not a separate byte budget.
 */

const HEADER_V3_BYTES = 40;
const HEADER_V5_BYTES = 80;
const HASH_SEGMENT_TYPE = 2;
const EXTENDED_PROGRAM_COUNT = 0xffff;
const UINT32_MAX = 0xffff_ffff;
const HASH_SIZES = [32, 48, 20] as const;

const IMAGE_SOURCE_NAMES = ["nand", "nor", "emmc", "emmc-user"] as const;

type ImageSourceName = (typeof IMAGE_SOURCE_NAMES)[number];
type MbnVersion = 3 | 5 | 6;
type HeaderBytes = 40 | 80;
type HashSize = (typeof HASH_SIZES)[number];

export interface QualcommMbnByteRange {
  readonly offset: number;
  readonly length: number;
}

export interface QualcommMbnHeader {
  readonly imageId: number;
  readonly version: MbnVersion;
  readonly imageSource: number;
  readonly imageSourceName: ImageSourceName | null;
  readonly imageDestination: number;
  readonly imageSize: number;
  readonly codeSize: number;
  readonly signaturePointer: number;
  readonly signatureSize: number;
  readonly certificateChainPointer: number;
  readonly certificateChainSize: number;
  readonly metadata0Size: number | null;
  readonly metadata0Pointer: number | null;
  readonly metadata1Size: number | null;
  readonly metadata1Pointer: number | null;
  readonly headerBytes: HeaderBytes;
}

export interface QualcommMbnRanges {
  readonly header: QualcommMbnByteRange;
  readonly code: QualcommMbnByteRange;
  readonly signature: QualcommMbnByteRange;
  readonly certificateChain: QualcommMbnByteRange;
  readonly metadata0: QualcommMbnByteRange | null;
  readonly metadata1: QualcommMbnByteRange | null;
}

export interface QualcommMbnSegmentHash {
  readonly programHeaderIndex: number;
  readonly type: number;
  readonly flags: number;
  readonly segmentType: number;
  readonly fileOffset: number | null;
  readonly fileSize: number | null;
  readonly hashOffset: number;
  readonly hashSize: HashSize;
}

export interface QualcommMbnHashSegment {
  readonly programHeaderIndex: number;
  readonly offset: number | null;
  readonly fileSize: number | null;
}

export interface QualcommMbnFacet {
  readonly header: QualcommMbnHeader;
  readonly ranges: QualcommMbnRanges;
  readonly hashSize: HashSize | null;
  readonly hashCount: number | null;
  readonly segmentHashes: readonly QualcommMbnSegmentHash[];
}

export interface QualcommMbnLegacyInspection {
  readonly kind: "legacy";
  readonly header: QualcommMbnHeader;
  readonly ranges: QualcommMbnRanges;
  readonly limitations: readonly string[];
}

export interface QualcommMbnElfInspection {
  readonly kind: "elf";
  readonly elfClass: 32 | 64;
  readonly byteOrder: "little" | "big";
  readonly machine: number;
  readonly programHeaderCount: number | null;
  readonly hashSegment: QualcommMbnHashSegment | null;
  /**
   * Program-header indexes of hash segments after the one this inspection
   * decodes. Null when the program header table was not read, so those
   * segments stay unknown rather than absent. Inventory reports the first
   * segment only, so a non-empty list is an omission.
   */
  readonly furtherHashSegments: readonly number[] | null;
  readonly facet: QualcommMbnFacet | null;
  readonly limitations: readonly string[];
}

export type QualcommMbnInspection =
  | QualcommMbnLegacyInspection
  | QualcommMbnElfInspection
  | { readonly kind: "unrecognized"; readonly detail: string };

export interface QualcommMbnByteSpan {
  readonly kind: "span";
  readonly offset: number;
  readonly length: number;
}

interface RawHeader {
  readonly imageId: number;
  readonly version: MbnVersion;
  readonly imageSource: number;
  readonly imageDestination: number;
  readonly imageSize: number;
  readonly codeSize: number;
  readonly signaturePointer: number;
  readonly signatureSize: number;
  readonly certificateChainPointer: number;
  readonly certificateChainSize: number;
  readonly metadata0Size: number;
  readonly metadata0Pointer: number;
  readonly metadata1Size: number;
  readonly metadata1Pointer: number;
  readonly headerBytes: HeaderBytes;
  readonly reservedNonZero: boolean;
}

interface RegionSizes {
  readonly headerBytes: HeaderBytes;
  readonly code: number;
  readonly signature: number;
  readonly certificate: number;
  readonly metadata0: number;
  readonly metadata1: number;
}

interface RegionStarts {
  readonly code: number;
  readonly signature: number;
  readonly certificate: number;
  readonly metadata0: number;
  readonly metadata1: number;
}

interface ProgramRow {
  readonly index: number;
  readonly type: number;
  readonly flags: number;
  readonly segmentType: number;
  readonly fileOffset: number | null;
  readonly fileSize: number | null;
}

type ParsedHeader =
  | {
      readonly kind: "header";
      readonly header: QualcommMbnHeader;
      readonly ranges: QualcommMbnRanges;
      readonly limitations: readonly string[];
    }
  | { readonly kind: "truncated-version"; readonly version: 5 | 6 }
  | { readonly kind: "rejected" };

const sumBounded = (
  values: readonly number[],
  ceiling: number,
): number | null => {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || total > ceiling - value)
      return null;
    total += value;
  }
  return total;
};

const sumUint32 = (values: readonly number[]): number | null =>
  sumBounded(values, UINT32_MAX);

const sumSafe = (values: readonly number[]): number | null =>
  sumBounded(values, Number.MAX_SAFE_INTEGER);

const rangeLimitation = (
  role: string,
  offset: number,
  length: number,
  fileSize: number,
): string =>
  `${role} range ${String(offset)}+${String(length)} exceeds the ${String(fileSize)}-byte file`;

const exceedsFile = (
  offset: number,
  length: number,
  fileSize: number,
): boolean => length > 0 && (offset > fileSize || length > fileSize - offset);

const imageSourceName = (value: number): ImageSourceName | null =>
  IMAGE_SOURCE_NAMES[value] ?? null;

const safeUint = (value: bigint): number | null =>
  value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : null;

const unrecognized = (detail: string): QualcommMbnInspection => ({
  kind: "unrecognized",
  detail,
});

const regionStarts = (
  origin: number,
  includeHeader: boolean,
  sizes: RegionSizes,
  add: (values: readonly number[]) => number | null,
): RegionStarts | null => {
  const code = includeHeader ? add([origin, sizes.headerBytes]) : origin;
  if (code === null) return null;
  const signature = add([code, sizes.code]);
  if (signature === null) return null;
  const certificate = add([signature, sizes.signature]);
  if (certificate === null) return null;
  const metadata0 = add([certificate, sizes.certificate]);
  if (metadata0 === null) return null;
  const metadata1 = add([metadata0, sizes.metadata0]);
  if (metadata1 === null) return null;
  return { code, signature, certificate, metadata0, metadata1 };
};

const sizesOf = (header: RawHeader): RegionSizes => ({
  headerBytes: header.headerBytes,
  code: header.codeSize,
  signature: header.signatureSize,
  certificate: header.certificateChainSize,
  metadata0: header.metadata0Size,
  metadata1: header.metadata1Size,
});

const pointerOk = (size: number, pointer: number, at: number): boolean =>
  size === 0 ? pointer === 0 || pointer === at : pointer === at;

const matchesLayout = (header: RawHeader, starts: RegionStarts): boolean => {
  if (
    !pointerOk(header.signatureSize, header.signaturePointer, starts.signature)
  )
    return false;
  if (
    !pointerOk(
      header.certificateChainSize,
      header.certificateChainPointer,
      starts.certificate,
    )
  )
    return false;
  if (header.signatureSize > 0 && header.certificateChainSize > 0) {
    const next = sumUint32([header.signaturePointer, header.signatureSize]);
    if (next !== header.certificateChainPointer) return false;
  }
  if (header.headerBytes === HEADER_V3_BYTES) return true;
  return (
    pointerOk(
      header.metadata0Size,
      header.metadata0Pointer,
      starts.metadata0,
    ) &&
    pointerOk(header.metadata1Size, header.metadata1Pointer, starts.metadata1)
  );
};

/** File offsets, header-relative offsets, or virtual addresses at image_destination. */
const pointersPlausible = (header: RawHeader, base: number): boolean => {
  const sizes = sizesOf(header);
  const candidates = [
    regionStarts(base, true, sizes, sumUint32),
    regionStarts(0, true, sizes, sumUint32),
    regionStarts(header.imageDestination, false, sizes, sumUint32),
    regionStarts(header.imageDestination, true, sizes, sumUint32),
  ];
  return candidates.some(
    (starts) => starts !== null && matchesLayout(header, starts),
  );
};

const readRawHeader = (
  bytes: Buffer,
): RawHeader | { readonly truncatedVersion: 5 | 6 } | null => {
  if (bytes.length < 8) return null;
  const reader = new BinaryReader(bytes, true, "qualcomm-mbn");
  const version = reader.u32(4);
  if (version !== 3 && version !== 5 && version !== 6) return null;
  const headerBytes: HeaderBytes =
    version === 3 ? HEADER_V3_BYTES : HEADER_V5_BYTES;
  if (bytes.length < headerBytes)
    return version === 3 ? null : { truncatedVersion: version };
  let reservedNonZero = false;
  if (headerBytes === HEADER_V5_BYTES) {
    for (let offset = 56; offset < HEADER_V5_BYTES; offset += 4) {
      if (reader.u32(offset) !== 0) reservedNonZero = true;
    }
  }
  return {
    imageId: reader.u32(0),
    version,
    imageSource: reader.u32(8),
    imageDestination: reader.u32(12),
    imageSize: reader.u32(16),
    codeSize: reader.u32(20),
    signaturePointer: reader.u32(24),
    signatureSize: reader.u32(28),
    certificateChainPointer: reader.u32(32),
    certificateChainSize: reader.u32(36),
    metadata0Size: headerBytes === HEADER_V5_BYTES ? reader.u32(40) : 0,
    metadata0Pointer: headerBytes === HEADER_V5_BYTES ? reader.u32(44) : 0,
    metadata1Size: headerBytes === HEADER_V5_BYTES ? reader.u32(48) : 0,
    metadata1Pointer: headerBytes === HEADER_V5_BYTES ? reader.u32(52) : 0,
    headerBytes,
    reservedNonZero,
  };
};

const publicHeader = (raw: RawHeader): QualcommMbnHeader => ({
  imageId: raw.imageId,
  version: raw.version,
  imageSource: raw.imageSource,
  imageSourceName: imageSourceName(raw.imageSource),
  imageDestination: raw.imageDestination,
  imageSize: raw.imageSize,
  codeSize: raw.codeSize,
  signaturePointer: raw.signaturePointer,
  signatureSize: raw.signatureSize,
  certificateChainPointer: raw.certificateChainPointer,
  certificateChainSize: raw.certificateChainSize,
  metadata0Size: raw.headerBytes === HEADER_V5_BYTES ? raw.metadata0Size : null,
  metadata0Pointer:
    raw.headerBytes === HEADER_V5_BYTES ? raw.metadata0Pointer : null,
  metadata1Size: raw.headerBytes === HEADER_V5_BYTES ? raw.metadata1Size : null,
  metadata1Pointer:
    raw.headerBytes === HEADER_V5_BYTES ? raw.metadata1Pointer : null,
  headerBytes: raw.headerBytes,
});

const fileRanges = (raw: RawHeader, base: number): QualcommMbnRanges | null => {
  const starts = regionStarts(base, true, sizesOf(raw), sumSafe);
  if (starts === null) return null;
  const wide = raw.headerBytes === HEADER_V5_BYTES;
  return {
    header: { offset: base, length: raw.headerBytes },
    code: { offset: starts.code, length: raw.codeSize },
    signature: { offset: starts.signature, length: raw.signatureSize },
    certificateChain: {
      offset: starts.certificate,
      length: raw.certificateChainSize,
    },
    metadata0: wide
      ? { offset: starts.metadata0, length: raw.metadata0Size }
      : null,
    metadata1: wide
      ? { offset: starts.metadata1, length: raw.metadata1Size }
      : null,
  };
};

const rangeLimitations = (
  raw: RawHeader,
  ranges: QualcommMbnRanges,
  fileSize: number,
  codeRole: "code" | "hash table",
): string[] => {
  const limitations: string[] = [];
  if (raw.reservedNonZero)
    limitations.push(
      "MBN header bytes 56-79 are non-zero and were not decoded.",
    );
  if (exceedsFile(ranges.header.offset, raw.imageSize, fileSize))
    limitations.push(
      rangeLimitation("image", ranges.header.offset, raw.imageSize, fileSize),
    );
  const named: readonly (readonly [string, QualcommMbnByteRange | null])[] = [
    [codeRole, ranges.code],
    ["signature", ranges.signature],
    ["certificate chain", ranges.certificateChain],
    ["metadata 0", ranges.metadata0],
    ["metadata 1", ranges.metadata1],
  ];
  for (const [role, range] of named) {
    if (range !== null && exceedsFile(range.offset, range.length, fileSize))
      limitations.push(
        rangeLimitation(role, range.offset, range.length, fileSize),
      );
  }
  return limitations;
};

const headerIsPlausible = (raw: RawHeader, base: number): boolean => {
  if (raw.codeSize === 0 || raw.imageSize === 0) return false;
  const payload = sumUint32([
    raw.codeSize,
    raw.signatureSize,
    raw.certificateChainSize,
    raw.metadata0Size,
    raw.metadata1Size,
  ]);
  if (payload === null || payload === 0) return false;
  const withHeader = sumUint32([raw.headerBytes, payload]);
  const sizeMatches =
    raw.imageSize === payload ||
    (withHeader !== null && raw.imageSize === withHeader);
  return sizeMatches && pointersPlausible(raw, base);
};

const decodeMbnHeader = (
  bytes: Buffer,
  base: number,
  fileSize: number,
  codeRole: "code" | "hash table",
): ParsedHeader => {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0)
    return { kind: "rejected" };
  const raw = readRawHeader(bytes);
  if (raw !== null && "truncatedVersion" in raw)
    return { kind: "truncated-version", version: raw.truncatedVersion };
  if (raw === null || !headerIsPlausible(raw, base))
    return { kind: "rejected" };
  const ranges = fileRanges(raw, base);
  if (
    ranges === null ||
    exceedsFile(ranges.header.offset, ranges.header.length, fileSize)
  )
    return { kind: "rejected" };
  return {
    kind: "header",
    header: publicHeader(raw),
    ranges,
    limitations: rangeLimitations(raw, ranges, fileSize, codeRole),
  };
};

const inspectLegacy = (
  bytes: Buffer,
  fileSize: number,
): QualcommMbnInspection => {
  const parsed = decodeMbnHeader(bytes, 0, fileSize, "code");
  if (
    parsed.kind !== "header" ||
    exceedsFile(parsed.ranges.code.offset, parsed.ranges.code.length, fileSize)
  )
    return unrecognized("bytes are not a Qualcomm MBN header");
  return {
    kind: "legacy",
    header: parsed.header,
    ranges: parsed.ranges,
    limitations: parsed.limitations,
  };
};

/** True only for a legacy header. ELF images, including ELF MBNs, are false. */
export const hasQualcommMbnHeader = (
  bytes: Buffer,
  fileSize = bytes.length,
): boolean =>
  !hasElfMagic(bytes) && inspectLegacy(bytes, fileSize).kind === "legacy";

interface ElfPreface {
  readonly kind: "preface";
  readonly header: ElfFixedHeader;
  readonly programOffset: bigint;
  readonly programWidth: number;
  readonly programCount: number;
}

const readElfPreface = (
  prefix: Buffer,
  fileSize: number,
): ElfPreface | QualcommMbnInspection => {
  const header = readElfFixedHeader(prefix, fileSize);
  if (!header.ok) return unrecognized(header.error);
  const tables = readElfRawTableDeclarations(prefix, header.value);
  if (!tables.ok) return unrecognized(tables.error.message);
  return {
    kind: "preface",
    header: header.value,
    programOffset: tables.value.programs.offset,
    programWidth: tables.value.programs.width,
    programCount: tables.value.programs.count,
  };
};

interface ElfFindings {
  readonly limitations: readonly string[];
  /** Null when the program header table was not read. */
  readonly furtherHashSegments: readonly number[] | null;
}

const elfFindings = (
  limitations: readonly string[],
  furtherHashSegments: readonly number[] | null = null,
): ElfFindings => ({ limitations, furtherHashSegments });

const elfInspection = (
  preface: ElfPreface,
  hashSegment: QualcommMbnHashSegment | null,
  facet: QualcommMbnFacet | null,
  findings: ElfFindings,
): QualcommMbnElfInspection => ({
  kind: "elf",
  elfClass: preface.header.elfClass,
  byteOrder: preface.header.byteOrder,
  machine: preface.header.machine,
  programHeaderCount:
    preface.programCount === EXTENDED_PROGRAM_COUNT
      ? null
      : preface.programCount,
  hashSegment,
  furtherHashSegments: findings.furtherHashSegments,
  facet,
  limitations: findings.limitations,
});

const tablePastFile = (fileSize: number): string =>
  `program header table extends past the ${String(fileSize)}-byte file`;

/** The program header table to read, or an inspection when it cannot be read. */
export const qualcommMbnElfTableSpan = (
  prefix: Buffer,
  fileSize: number,
): QualcommMbnByteSpan | QualcommMbnInspection => {
  const preface = readElfPreface(prefix, fileSize);
  if (preface.kind !== "preface") return preface;
  if (preface.programCount === EXTENDED_PROGRAM_COUNT)
    return elfInspection(
      preface,
      null,
      null,
      elfFindings([
        "program header count 65535 is the ELF extended numbering sentinel; the hash segment is unknown",
      ]),
    );
  const offset = safeUint(preface.programOffset);
  const expected = elfProgramHeaderWidth(preface.header.elfClass);
  if (offset === null)
    return elfInspection(
      preface,
      null,
      null,
      elfFindings([
        "program header offset does not fit in a safe integer; the hash segment is unknown",
      ]),
    );
  if (preface.programCount > 0 && preface.programWidth !== expected)
    return elfInspection(
      preface,
      null,
      null,
      elfFindings([
        `program header entry size ${String(preface.programWidth)} is not the ELF${String(preface.header.elfClass)} size; the hash segment is unknown`,
      ]),
    );
  const bytes = preface.programCount * preface.programWidth;
  if (
    !Number.isSafeInteger(bytes) ||
    offset > fileSize ||
    bytes > fileSize - offset
  )
    return elfInspection(
      preface,
      null,
      null,
      elfFindings([tablePastFile(fileSize)]),
    );
  if (preface.programCount === 0)
    return elfInspection(preface, null, null, elfFindings([], []));
  return { kind: "span", offset, length: bytes };
};

const walkPrograms = (
  table: Buffer,
  preface: ElfPreface,
): readonly ProgramRow[] | null => {
  const width = elfProgramHeaderWidth(preface.header.elfClass);
  if (table.length % width !== 0) return null;
  const little = preface.header.byteOrder === "little";
  const rows: ProgramRow[] = [];
  for (let index = 0; index < table.length / width; index += 1) {
    const parsed = readElfProgramHeader(
      table.subarray(index * width, (index + 1) * width),
      preface.header.elfClass,
      little,
    );
    if (!parsed.ok) return null;
    rows.push({
      index,
      type: parsed.value.type,
      flags: parsed.value.flags,
      segmentType: (parsed.value.flags >>> 24) & 7,
      fileOffset: safeUint(parsed.value.offset),
      fileSize: safeUint(parsed.value.fileSize),
    });
  }
  return rows;
};

const locatedHash = (row: ProgramRow): QualcommMbnHashSegment => ({
  programHeaderIndex: row.index,
  offset: row.fileOffset,
  fileSize: row.fileSize,
});

/**
 * Hash segments after the first. The inspection reports one segment; the
 * indexes are the parsed omission, and the strings name it for callers.
 */
const furtherHashSegmentReport = (
  rows: readonly ProgramRow[],
): {
  readonly furtherHashSegments: readonly number[];
  readonly limitations: readonly string[];
} => {
  const hashes = rows.filter((row) => row.segmentType === HASH_SEGMENT_TYPE);
  const first = hashes[0];
  if (first === undefined) return { furtherHashSegments: [], limitations: [] };
  const rest = hashes.slice(1);
  return {
    furtherHashSegments: rest.map((row) => row.index),
    limitations: rest.map(
      (row) =>
        `program header ${String(row.index)} is also a hash segment; REA reports program header ${String(first.index)}`,
    ),
  };
};

const hashHeaderRefusal = (
  row: ProgramRow,
  fileSize: number,
): string | null => {
  if (row.fileOffset === null || row.fileSize === null)
    return `hash segment program header ${String(row.index)} file offset or size does not fit in a safe integer`;
  if (row.fileSize === 0)
    return `hash segment program header ${String(row.index)} declares no file bytes`;
  const remaining = row.fileOffset > fileSize ? 0 : fileSize - row.fileOffset;
  if (remaining < HEADER_V3_BYTES)
    return `hash segment program header ${String(row.index)} has ${String(remaining)} bytes left in the ${String(fileSize)}-byte file, fewer than 40`;
  if (Math.min(row.fileSize, remaining) < HEADER_V3_BYTES)
    return `hash segment program header ${String(row.index)} declares ${String(row.fileSize)} file bytes, fewer than a 40-byte MBN header`;
  return null;
};

/** Bytes of the first hash-segment header, or an inspection when none can be read. */
export const qualcommMbnHashHeaderSpan = (
  prefix: Buffer,
  table: Buffer,
  fileSize: number,
): QualcommMbnByteSpan | QualcommMbnInspection => {
  const preface = readElfPreface(prefix, fileSize);
  if (preface.kind !== "preface") return preface;
  const rows = walkPrograms(table, preface);
  if (rows === null)
    return elfInspection(
      preface,
      null,
      null,
      elfFindings([
        "program header table could not be read; the hash segment is unknown",
      ]),
    );
  const first = rows.find((row) => row.segmentType === HASH_SEGMENT_TYPE);
  const extras = furtherHashSegmentReport(rows);
  if (first === undefined)
    return elfInspection(
      preface,
      null,
      null,
      elfFindings([], extras.furtherHashSegments),
    );
  const refusal = hashHeaderRefusal(first, fileSize);
  if (refusal !== null)
    return elfInspection(
      preface,
      locatedHash(first),
      null,
      elfFindings([refusal, ...extras.limitations], extras.furtherHashSegments),
    );
  const offset = first.fileOffset;
  const fileLength = first.fileSize;
  if (offset === null || fileLength === null)
    return elfInspection(
      preface,
      locatedHash(first),
      null,
      elfFindings(extras.limitations, extras.furtherHashSegments),
    );
  const length = Math.min(HEADER_V5_BYTES, fileLength, fileSize - offset);
  return { kind: "span", offset, length };
};

const chooseHash = (
  codeSize: number,
  programCount: number,
): {
  readonly hashSize: HashSize;
  readonly hashCount: number;
  readonly aligned: boolean;
} | null => {
  let fallback: { hashSize: HashSize; hashCount: number } | null = null;
  for (const hashSize of HASH_SIZES) {
    if (codeSize % hashSize !== 0) continue;
    const hashCount = codeSize / hashSize;
    if (hashCount === programCount)
      return { hashSize, hashCount, aligned: true };
    if (fallback === null) fallback = { hashSize, hashCount };
  }
  return fallback === null ? null : { ...fallback, aligned: false };
};

const segmentHashes = (
  rows: readonly ProgramRow[],
  codeOffset: number,
  hashSize: HashSize,
): readonly QualcommMbnSegmentHash[] | null => {
  const hashes: QualcommMbnSegmentHash[] = [];
  for (const row of rows) {
    const hashOffset = sumSafe([codeOffset, row.index * hashSize]);
    if (hashOffset === null) return null;
    hashes.push({
      programHeaderIndex: row.index,
      type: row.type,
      flags: row.flags,
      segmentType: row.segmentType,
      fileOffset: row.fileOffset,
      fileSize: row.fileSize,
      hashOffset,
      hashSize,
    });
  }
  return hashes;
};

const hashLimitations = (
  codeSize: number,
  programCount: number,
  chosen: ReturnType<typeof chooseHash>,
  hashes: readonly QualcommMbnSegmentHash[] | null,
): string[] => {
  if (chosen === null)
    return [
      `code size ${String(codeSize)} is not a whole number of 32-byte, 48-byte, or 20-byte hashes`,
    ];
  if (hashes === null) return ["hash offsets do not fit in a safe integer"];
  if (!chosen.aligned)
    return [
      `hash count ${String(chosen.hashCount)} does not equal the ${String(programCount)} program headers`,
    ];
  return [];
};

const facetFromHeader = (
  parsed: Extract<ParsedHeader, { readonly kind: "header" }>,
  rows: readonly ProgramRow[],
): { readonly facet: QualcommMbnFacet; readonly limitations: string[] } => {
  const chosen = chooseHash(parsed.header.codeSize, rows.length);
  const hashes =
    chosen?.aligned === true
      ? segmentHashes(rows, parsed.ranges.code.offset, chosen.hashSize)
      : [];
  return {
    facet: {
      header: parsed.header,
      ranges: parsed.ranges,
      hashSize: chosen?.hashSize ?? null,
      hashCount: chosen?.hashCount ?? null,
      segmentHashes: hashes ?? [],
    },
    limitations: [
      ...parsed.limitations,
      ...hashLimitations(parsed.header.codeSize, rows.length, chosen, hashes),
    ],
  };
};

/** Which bound, the segment's `p_filesz` or the file end, cut the header short. */
const truncatedHashHeader = (
  row: ProgramRow,
  version: 5 | 6,
  offset: number,
  fileSize: number,
): string => {
  const left = fileSize - offset;
  const bound =
    row.fileSize !== null && row.fileSize <= left
      ? `program header ${String(row.index)} declares ${String(row.fileSize)} file bytes`
      : `the ${String(fileSize)}-byte file ends ${String(left)} bytes after offset ${String(offset)}`;
  return `hash segment version ${String(version)} needs 80 header bytes; ${bound}`;
};

/** Decode a hash segment from a table and the header bytes at its file offset. */
export const inspectQualcommMbnElf = (input: {
  readonly prefix: Buffer;
  readonly table: Buffer;
  readonly hashHeader: Buffer;
  readonly hashOffset: number;
  readonly fileSize: number;
}): QualcommMbnInspection => {
  const preface = readElfPreface(input.prefix, input.fileSize);
  if (preface.kind !== "preface") return preface;
  const rows = walkPrograms(input.table, preface);
  if (rows === null)
    return elfInspection(
      preface,
      null,
      null,
      elfFindings([
        "program header table could not be read; the hash segment is unknown",
      ]),
    );
  const first = rows.find((row) => row.segmentType === HASH_SEGMENT_TYPE);
  const extras = furtherHashSegmentReport(rows);
  if (first === undefined)
    return elfInspection(
      preface,
      null,
      null,
      elfFindings([], extras.furtherHashSegments),
    );
  const located = locatedHash(first);
  const parsed = decodeMbnHeader(
    input.hashHeader,
    input.hashOffset,
    input.fileSize,
    "hash table",
  );
  if (parsed.kind === "truncated-version")
    return elfInspection(
      preface,
      located,
      null,
      elfFindings(
        [
          truncatedHashHeader(
            first,
            parsed.version,
            input.hashOffset,
            input.fileSize,
          ),
          ...extras.limitations,
        ],
        extras.furtherHashSegments,
      ),
    );
  if (parsed.kind === "rejected")
    return elfInspection(
      preface,
      located,
      null,
      elfFindings(
        [
          `hash segment program header ${String(first.index)} is not an MBN header`,
          ...extras.limitations,
        ],
        extras.furtherHashSegments,
      ),
    );
  const facet = facetFromHeader(parsed, rows);
  return elfInspection(
    preface,
    located,
    facet.facet,
    elfFindings(
      [...facet.limitations, ...extras.limitations],
      extras.furtherHashSegments,
    ),
  );
};

const supplied = (
  bytes: Buffer,
  offset: number,
  length: number,
): Buffer | null => {
  if (offset > bytes.length || length > bytes.length - offset) return null;
  return bytes.subarray(offset, offset + length);
};

const inspectElfImage = (
  bytes: Buffer,
  fileSize: number,
): QualcommMbnInspection => {
  const prefix = bytes.subarray(0, Math.min(bytes.length, 64));
  const tableSpan = qualcommMbnElfTableSpan(prefix, fileSize);
  if (tableSpan.kind !== "span") return tableSpan;
  const table = supplied(bytes, tableSpan.offset, tableSpan.length);
  if (table === null)
    return unrecognized("program header table is outside the supplied bytes");
  const hashSpan = qualcommMbnHashHeaderSpan(prefix, table, fileSize);
  if (hashSpan.kind !== "span") return hashSpan;
  const hashHeader = supplied(bytes, hashSpan.offset, hashSpan.length);
  if (hashHeader === null)
    return unrecognized("hash segment header is outside the supplied bytes");
  return inspectQualcommMbnElf({
    prefix,
    table,
    hashHeader,
    hashOffset: hashSpan.offset,
    fileSize,
  });
};

/** Inspect a whole image, or a legacy header buffer plus the real file size. */
export const inspectQualcommMbnImage = (
  bytes: Buffer,
  fileSize = bytes.length,
): QualcommMbnInspection =>
  hasElfMagic(bytes)
    ? inspectElfImage(bytes, fileSize)
    : inspectLegacy(bytes, fileSize);

const rangesFit = (
  header: QualcommMbnHeader,
  ranges: QualcommMbnRanges,
  fileSize: number,
): boolean => {
  const imageEnd = sumSafe([ranges.header.offset, header.imageSize]);
  if (imageEnd === null || imageEnd > fileSize) return false;
  const regions = [
    ranges.code,
    ranges.signature,
    ranges.certificateChain,
    ranges.metadata0,
    ranges.metadata1,
  ];
  return regions.every(
    (range) =>
      range === null || !exceedsFile(range.offset, range.length, fileSize),
  );
};

export type QualcommMbnRegionName =
  | "header"
  | "code"
  | "hash-table"
  | "signature"
  | "certificate-chain"
  | "metadata0"
  | "metadata1";

/**
 * Non-empty regions that lie wholly inside the file. A region outside it is
 * already an inspection limitation and is omitted here, never clamped. The
 * code region of an ELF hash segment is its hash table.
 */
export const qualcommMbnStoredRegions = (
  ranges: QualcommMbnRanges,
  layout: "legacy" | "elf",
  fileSize: number,
): readonly {
  readonly name: QualcommMbnRegionName;
  readonly range: QualcommMbnByteRange;
}[] => {
  const regions: readonly (readonly [
    QualcommMbnRegionName,
    QualcommMbnByteRange | null,
  ])[] = [
    ["header", ranges.header],
    [layout === "elf" ? "hash-table" : "code", ranges.code],
    ["signature", ranges.signature],
    ["certificate-chain", ranges.certificateChain],
    ["metadata0", ranges.metadata0],
    ["metadata1", ranges.metadata1],
  ];
  return regions.flatMap(([name, range]) =>
    range === null ||
    range.length === 0 ||
    exceedsFile(range.offset, range.length, fileSize)
      ? []
      : [{ name, range }],
  );
};

/**
 * Per-program-header hash rows delivered inline. A delivery budget, not an
 * admission limit: every row's position is `hash-table` offset plus index
 * times hash size, and the whole table stays readable as its region.
 */
export const QUALCOMM_MBN_INLINE_SEGMENT_HASH_LIMIT = 64;

/**
 * Complete when every declared range fits and an ELF hash list lines up.
 * Further hash segments are the parser's omission: the first list can match
 * the program headers while those other segments stay uninventoried, and an
 * unread table leaves them unknown rather than absent.
 */
export const qualcommMbnInventoryCoverage = (
  inspection: QualcommMbnLegacyInspection | QualcommMbnElfInspection,
  fileSize: number,
): "complete" | "unknown" => {
  const coverage = new CoverageAccumulator();
  const decoded = inspection.kind === "elf" ? inspection.facet : inspection;
  if (decoded === null) coverage.recordUnknown("no MBN header was decoded");
  else if (rangesFit(decoded.header, decoded.ranges, fileSize))
    coverage.recordComplete();
  else coverage.recordUnknown("a declared range exceeds the file");
  if (inspection.kind === "elf") {
    const further = inspection.furtherHashSegments;
    if (further === null)
      coverage.recordUnknown("further hash segments were not examined");
    else if (further.length > 0)
      coverage.recordUnknown("further hash segments are not inventoried");
    const count = inspection.programHeaderCount;
    const facet = inspection.facet;
    if (
      count === null ||
      facet?.hashCount !== count ||
      facet.segmentHashes.length !== count
    )
      coverage.recordUnknown(
        "the hash list does not match the program headers",
      );
  }
  return coverage.finalizeCompleteOrUnknown();
};
