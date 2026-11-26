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
 * MBN headers are little-endian: 40 bytes for v3 and v5, and 48 for v6. Those words stay
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
 * crosses the file or segment bound; the truncated table is reported as a limitation and
 * omitted from stored regions.
 *
 * `e_phnum` 65535 is the ELF extended numbering sentinel. This parser does
 * not read section 0, so that count stays unknown rather than a scan of
 * 65535 rows. A direct count is scanned only when the whole table lies in
 * the file. That extent is the format's own bound, not a separate byte budget.
 */

const HEADER_BYTES = { 3: 40, 5: 40, 6: 48 } as const;
export const QUALCOMM_MBN_MAX_HEADER_BYTES = HEADER_BYTES[6];
const HASH_SEGMENT_TYPE = 2;
const EXTENDED_PROGRAM_COUNT = 0xffff;
const UINT32_MAX = 0xffff_ffff;
const HASH_SIZES = [32, 48, 20] as const;

type MbnVersion = 3 | 5 | 6;
type HeaderBytes = (typeof HEADER_BYTES)[MbnVersion];
type HashSize = (typeof HASH_SIZES)[number];

export interface QualcommMbnByteRange {
  readonly offset: number;
  readonly length: number;
}

export interface QualcommMbnHeader {
  readonly imageId: number;
  readonly version: MbnVersion;
  readonly imageSource: number | null;
  readonly imageSourceName: null;
  readonly imageDestination: number | null;
  readonly imageSize: number;
  readonly codeSize: number;
  readonly signaturePointer: number;
  readonly signatureSize: number;
  readonly certificateChainPointer: number;
  readonly certificateChainSize: number;
  readonly metadata0Size: number | null;
  readonly qtiSignatureSize: number | null;
  readonly metadata1Size: number | null;
  readonly qtiCertificateChainSize: number | null;
  readonly headerBytes: HeaderBytes;
}

export interface QualcommMbnRanges {
  readonly header: QualcommMbnByteRange;
  readonly code: QualcommMbnByteRange;
  readonly signature: QualcommMbnByteRange;
  readonly certificateChain: QualcommMbnByteRange;
  readonly metadata0: QualcommMbnByteRange | null;
  readonly metadata1: QualcommMbnByteRange | null;
  readonly qtiSignature: QualcommMbnByteRange | null;
  readonly qtiCertificateChain: QualcommMbnByteRange | null;
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
  readonly readableEnd: number;
  readonly hashSize: HashSize | null;
  readonly hashCount: number | null;
  readonly segmentHashes: readonly QualcommMbnSegmentHash[];
}

export interface QualcommMbnLegacyInspection {
  readonly kind: "legacy";
  readonly header: QualcommMbnHeader;
  readonly ranges: QualcommMbnRanges;
  readonly readableEnd: number;
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
      readonly readableEnd: number;
      readonly limitations: readonly string[];
    }
  | { readonly kind: "truncated-version"; readonly version: MbnVersion }
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
  boundDescription: string,
): string =>
  `${role} range ${String(offset)}+${String(length)} exceeds ${boundDescription}`;

const exceedsEnd = (offset: number, length: number, end: number): boolean =>
  length > 0 && (offset > end || length > end - offset);

const safeUint = (value: bigint): number | null =>
  value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : null;

const unrecognized = (detail: string): QualcommMbnInspection => ({
  kind: "unrecognized",
  detail,
});

const pointerOk = (
  range: QualcommMbnByteRange,
  pointer: number,
  at: number,
): boolean => pointer === at || (range.length === 0 && pointer === 0);

/** V3 pointers may use file, header-relative, or image destination addresses. */
const v3PointersPlausible = (
  raw: QualcommMbnHeader,
  ranges: QualcommMbnRanges,
): boolean => {
  const { code, signature, certificateChain, header } = ranges;
  const relative = signature.offset - header.offset;
  const destination = raw.imageDestination ?? 0;
  return [
    signature.offset,
    relative,
    destination + (signature.offset - code.offset),
    destination + relative,
  ].some((start) => {
    const cert = sumUint32([start, signature.length]);
    return (
      cert !== null &&
      pointerOk(signature, raw.signaturePointer, start) &&
      pointerOk(certificateChain, raw.certificateChainPointer, cert)
    );
  });
};

const readRawHeader = (
  bytes: Buffer,
): QualcommMbnHeader | { readonly truncatedVersion: MbnVersion } | null => {
  if (bytes.length < 8) return null;
  const reader = new BinaryReader(bytes, true, "qualcomm-mbn");
  const version = reader.u32(4);
  if (version !== 3 && version !== 5 && version !== 6) return null;
  const headerBytes = HEADER_BYTES[version];
  if (bytes.length < headerBytes) return { truncatedVersion: version };
  return {
    imageId: reader.u32(0),
    version,
    imageSource: version === 3 ? reader.u32(8) : null,
    // Offset 8 in v3 is image_src (flash source offset), not a boot-device enum.
    imageSourceName: null,
    imageDestination: version === 3 ? reader.u32(12) : null,
    imageSize: reader.u32(16),
    codeSize: reader.u32(20),
    signaturePointer: reader.u32(24),
    signatureSize: reader.u32(28),
    certificateChainPointer: reader.u32(32),
    certificateChainSize: reader.u32(36),
    metadata0Size: version === 6 ? reader.u32(40) : null,
    metadata1Size: version === 6 ? reader.u32(44) : null,
    qtiSignatureSize: version !== 3 ? reader.u32(8) : null,
    qtiCertificateChainSize: version !== 3 ? reader.u32(12) : null,
    headerBytes,
  };
};

const fileRanges = (
  raw: QualcommMbnHeader,
  base: number,
): QualcommMbnRanges => {
  let offset = base;
  const next = (length: number): QualcommMbnByteRange => {
    const range = { offset, length };
    offset += length;
    return range;
  };
  const optional = (length: number | null): QualcommMbnByteRange | null =>
    length === null ? null : next(length);
  return {
    header: next(raw.headerBytes),
    metadata0: optional(raw.metadata0Size),
    metadata1: optional(raw.metadata1Size),
    code: next(raw.codeSize),
    qtiSignature: optional(raw.qtiSignatureSize),
    qtiCertificateChain: optional(raw.qtiCertificateChainSize),
    signature: next(raw.signatureSize),
    certificateChain: next(raw.certificateChainSize),
  };
};

const decodeMbnHeader = (
  bytes: Buffer,
  base: number,
  { end, description }: { readonly end: number; readonly description: string },
  codeRole: "code" | "hash table",
): ParsedHeader => {
  if (!Number.isSafeInteger(end) || base > end) return { kind: "rejected" };
  const raw = readRawHeader(bytes.subarray(0, end - base));
  if (raw !== null && "truncatedVersion" in raw)
    return { kind: "truncated-version", version: raw.truncatedVersion };
  if (raw === null || raw.codeSize === 0) return { kind: "rejected" };
  const payload = sumUint32([
    raw.codeSize,
    raw.signatureSize,
    raw.certificateChainSize,
    raw.metadata0Size ?? 0,
    raw.metadata1Size ?? 0,
    raw.qtiSignatureSize ?? 0,
    raw.qtiCertificateChainSize ?? 0,
  ]);
  const imageLength = raw.headerBytes + raw.imageSize;
  if (raw.imageSize !== payload || sumSafe([base, imageLength]) === null)
    return { kind: "rejected" };
  const ranges = fileRanges(raw, base);
  // V5 and V6 may leave OEM pointer words unused. Stored offsets follow the sizes.
  if (raw.version === 3 && !v3PointersPlausible(raw, ranges))
    return { kind: "rejected" };
  const named = [
    ["image", { offset: base, length: imageLength }],
    ["metadata 0", ranges.metadata0],
    ["metadata 1", ranges.metadata1],
    [codeRole, ranges.code],
    ["QTI signature", ranges.qtiSignature],
    ["QTI certificate chain", ranges.qtiCertificateChain],
    ["signature", ranges.signature],
    ["certificate chain", ranges.certificateChain],
  ] as const;
  const limitations = named.flatMap(([name, range]) =>
    range !== null && exceedsEnd(range.offset, range.length, end)
      ? [rangeLimitation(name, range.offset, range.length, description)]
      : [],
  );
  return {
    kind: "header",
    header: raw,
    ranges,
    readableEnd: end,
    limitations,
  };
};

const inspectLegacy = (
  bytes: Buffer,
  fileSize: number,
): QualcommMbnInspection => {
  const parsed = decodeMbnHeader(
    bytes,
    0,
    { end: fileSize, description: `the ${String(fileSize)}-byte file` },
    "code",
  );
  if (
    parsed.kind !== "header" ||
    exceedsEnd(parsed.ranges.code.offset, parsed.ranges.code.length, fileSize)
  )
    return unrecognized("bytes are not a Qualcomm MBN header");
  return {
    kind: "legacy",
    header: parsed.header,
    ranges: parsed.ranges,
    readableEnd: parsed.readableEnd,
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
  if (remaining < HEADER_BYTES[5])
    return `hash segment program header ${String(row.index)} has ${String(remaining)} bytes left in the ${String(fileSize)}-byte file, fewer than 40`;
  if (Math.min(row.fileSize, remaining) < HEADER_BYTES[5])
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
  const length = Math.min(
    QUALCOMM_MBN_MAX_HEADER_BYTES,
    fileLength,
    fileSize - offset,
  );
  return { kind: "span", offset, length };
};

interface HashCandidate {
  readonly hashSize: HashSize;
  readonly hashCount: number;
}

type ChosenHash =
  | {
      readonly kind: "matched";
      readonly hashSize: HashSize;
      readonly hashCount: number;
    }
  | {
      readonly kind: "mismatched";
      readonly candidates: readonly HashCandidate[];
    }
  | { readonly kind: "indivisible" };

const chooseHash = (codeSize: number, programCount: number): ChosenHash => {
  const candidates: HashCandidate[] = [];
  for (const hashSize of HASH_SIZES) {
    if (codeSize % hashSize !== 0) continue;
    const hashCount = codeSize / hashSize;
    if (hashCount === programCount)
      return { kind: "matched", hashSize, hashCount };
    candidates.push({ hashSize, hashCount });
  }
  return candidates.length === 0
    ? { kind: "indivisible" }
    : { kind: "mismatched", candidates };
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

const formatHashCandidates = (candidates: readonly HashCandidate[]): string => {
  const parts = candidates.map(
    ({ hashCount, hashSize }) =>
      `${String(hashCount)} ${String(hashSize)}-byte`,
  );
  if (parts.length === 1)
    return `${parts[0]!} ${candidates[0]!.hashCount === 1 ? "hash" : "hashes"}`;
  if (parts.length === 2) return `${parts[0]!} or ${parts[1]!} hashes`;
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]!} hashes`;
};

const hashLimitations = (
  codeSize: number,
  programCount: number,
  chosen: ChosenHash,
  hashes: readonly QualcommMbnSegmentHash[] | null,
): string[] => {
  if (chosen.kind === "indivisible")
    return [
      `code size ${String(codeSize)} is not a whole number of 32-byte, 48-byte, or 20-byte hashes`,
    ];
  if (chosen.kind === "mismatched")
    return [
      `code size ${String(codeSize)} does not match the ${String(programCount)} program ${programCount === 1 ? "header" : "headers"} (fits ${formatHashCandidates(chosen.candidates)}); hash size and count are unknown`,
    ];
  if (hashes === null) return ["hash offsets do not fit in a safe integer"];
  return [];
};

const facetFromHeader = (
  parsed: Extract<ParsedHeader, { readonly kind: "header" }>,
  rows: readonly ProgramRow[],
): { readonly facet: QualcommMbnFacet; readonly limitations: string[] } => {
  const chosen = chooseHash(parsed.header.codeSize, rows.length);
  const hashes =
    chosen.kind === "matched" &&
    !exceedsEnd(
      parsed.ranges.code.offset,
      parsed.ranges.code.length,
      parsed.readableEnd,
    )
      ? segmentHashes(rows, parsed.ranges.code.offset, chosen.hashSize)
      : [];
  return {
    facet: {
      header: parsed.header,
      ranges: parsed.ranges,
      readableEnd: parsed.readableEnd,
      hashSize: chosen.kind === "matched" ? chosen.hashSize : null,
      hashCount: chosen.kind === "matched" ? chosen.hashCount : null,
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
  version: MbnVersion,
  offset: number,
  fileSize: number,
): string => {
  const left = fileSize - offset;
  const bound =
    row.fileSize !== null && row.fileSize <= left
      ? `program header ${String(row.index)} declares ${String(row.fileSize)} file bytes`
      : `the ${String(fileSize)}-byte file ends ${String(left)} bytes after offset ${String(offset)}`;
  return `hash segment version ${String(version)} needs ${String(HEADER_BYTES[version])} header bytes; ${bound}`;
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
  const { offset, fileSize: segmentSize } = located;
  const remaining = input.fileSize - input.hashOffset;
  const available = Math.min(segmentSize ?? 0, remaining);
  const end = input.hashOffset + available;
  const description =
    segmentSize !== null && segmentSize <= remaining
      ? `hash segment range ${String(offset)}+${String(segmentSize)} (p_filesz)`
      : `the ${String(input.fileSize)}-byte file`;
  const parsed =
    offset === input.hashOffset && segmentSize !== null
      ? decodeMbnHeader(
          input.hashHeader,
          offset,
          { end, description },
          "hash table",
        )
      : { kind: "rejected" as const };
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

export type QualcommMbnRegionName =
  | "header"
  | "code"
  | "hash-table"
  | "signature"
  | "certificate-chain"
  | "metadata0"
  | "metadata1"
  | "qti-signature"
  | "qti-certificate-chain";

/**
 * Non-empty regions that fit within the inspected file and ELF segment. Any
 * crossing is reported as a limitation. The
 * code region of an ELF hash segment is its hash table.
 */
export const qualcommMbnStoredRegions = (
  inspection: QualcommMbnLegacyInspection | QualcommMbnElfInspection,
): readonly {
  readonly name: QualcommMbnRegionName;
  readonly range: QualcommMbnByteRange;
}[] => {
  const layout = inspection.kind;
  const decoded = layout === "legacy" ? inspection : inspection.facet;
  if (decoded === null) return [];
  const { ranges, readableEnd } = decoded;
  const regions: readonly (readonly [
    QualcommMbnRegionName,
    QualcommMbnByteRange | null,
  ])[] = [
    ["header", ranges.header],
    [layout === "elf" ? "hash-table" : "code", ranges.code],
    ["qti-signature", ranges.qtiSignature],
    ["qti-certificate-chain", ranges.qtiCertificateChain],
    ["signature", ranges.signature],
    ["certificate-chain", ranges.certificateChain],
    ["metadata0", ranges.metadata0],
    ["metadata1", ranges.metadata1],
  ];
  return regions.flatMap(([name, range]) =>
    range === null ||
    range.length === 0 ||
    exceedsEnd(range.offset, range.length, readableEnd)
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
): "complete" | "unknown" => {
  const coverage = new CoverageAccumulator();
  const decoded = inspection.kind === "elf" ? inspection.facet : inspection;
  if (decoded === null) coverage.recordUnknown("no MBN header was decoded");
  else if (inspection.limitations.length === 0) coverage.recordComplete();
  else coverage.recordUnknown("the inspection has limitations");
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
