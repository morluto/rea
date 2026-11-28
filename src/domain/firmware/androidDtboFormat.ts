import {
  DEFAULT_ANDROID_DTBO_READER_LIMITS,
  type AndroidDtboReaderLimits,
  type ArtifactReaderLimitParameter,
} from "../artifactReaderLimits.js";
import { BinaryReader } from "../binaryContainer.js";
import type { AndroidDtboCompressionMode } from "../formatMetadata/androidAndSystemMetadata.js";
import {
  decodeLimit,
  malformedInput,
  type ParseFailureError,
  truncatedInput,
  unsupportedInput,
} from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";

export const ANDROID_DTBO_FORMAT = "android-dtbo" as const;

/**
 * Field layout of AOSP `system/libufdt` `utils/src/dt_table.h`. Every field is
 * a big-endian `uint32_t` (mkdtimg writes them with `cpu_to_fdt32`).
 */
export const ANDROID_DTBO_MAGIC = 0xd7b7ab1e; // DT_TABLE_MAGIC
export const ANDROID_DTBO_HEADER_MIN_SIZE = 32; // sizeof(struct dt_table_header)
export const ANDROID_DTBO_ENTRY_MIN_SIZE = 32; // sizeof(struct dt_table_entry)

/** `struct dt_table_header` field offsets. */
const HEADER = {
  magic: 0,
  totalSize: 4,
  headerSize: 8,
  dtEntrySize: 12,
  dtEntryCount: 16,
  dtEntriesOffset: 20,
  pageSize: 24,
  version: 28,
} as const;

/**
 * `struct dt_table_entry` (version 0) and `struct dt_table_entry_v1` field
 * offsets. Version 1 replaces `custom[0]` with `flags`, whose four least
 * significant bits hold `enum dt_compression_info`.
 */
const ENTRY = {
  dtSize: 0,
  dtOffset: 4,
  id: 8,
  rev: 12,
  customV0: [16, 20, 24, 28],
  flagsV1: 16,
  customV1: [20, 24, 28],
} as const;
const DT_COMPRESSION_INFO_MASK = 0x0f;

export interface AndroidDtboLimitSpec {
  readonly name: string;
  readonly parameter: ArtifactReaderLimitParameter;
  readonly maximum: number;
  readonly unit: "bytes" | "count";
}

export const ANDROID_DTBO_LIMITS = {
  entryTableBytes: {
    name: "Android DTBO entry table bytes",
    parameter: "artifact_limits.android_dtbo.entry_table_bytes",
    maximum: DEFAULT_ANDROID_DTBO_READER_LIMITS.entry_table_bytes,
    unit: "bytes",
  },
  entryCount: {
    name: "Android DTBO entry count",
    parameter: "artifact_limits.android_dtbo.entry_count",
    maximum: DEFAULT_ANDROID_DTBO_READER_LIMITS.entry_count,
    unit: "count",
  },
} as const satisfies Record<string, AndroidDtboLimitSpec>;

export interface AndroidDtboHeader {
  readonly magic: number;
  readonly totalSize: number;
  readonly headerSize: number;
  readonly dtEntrySize: number;
  readonly dtEntryCount: number;
  readonly dtEntriesOffset: number;
  readonly pageSize: number;
  readonly version: 0 | 1;
  readonly tableSize: number;
  readonly limitations: readonly string[];
}

export interface AndroidDtboTableEntry {
  readonly index: number;
  readonly absRowOffset: number;
  readonly dtSize: number;
  readonly dtOffset: number;
  readonly id: number;
  readonly rev: number;
  readonly flags: number | null;
  readonly compression: AndroidDtboCompressionMode | null;
  readonly custom: readonly number[];
}

export interface AndroidDtboParsedTable {
  readonly entries: readonly AndroidDtboTableEntry[];
  readonly limitations: readonly string[];
  /** Ranges inside `total_size` that no header, table row or payload claims. */
  readonly unaccountedRanges: readonly (readonly [number, number])[];
}

export function hasAndroidDtboMagic(prefix: Uint8Array): boolean {
  if (prefix.byteLength < 4) return false;
  return (
    prefix[0] === 0xd7 &&
    prefix[1] === 0xb7 &&
    prefix[2] === 0xab &&
    prefix[3] === 0x1e
  );
}

export function decodeDtboCompression(
  flags: number,
): AndroidDtboCompressionMode {
  switch (flags & DT_COMPRESSION_INFO_MASK) {
    case 0:
      return "none";
    case 1:
      return "zlib";
    case 2:
      return "gzip";
    default:
      return "unknown";
  }
}

export type AndroidDtboParseError =
  | ParseFailureError<"malformed">
  | ParseFailureError<"truncated">
  | ParseFailureError<"unsupported">
  | ParseFailureError<"limit">;

export function parseAndroidDtboHeader(
  prefix: Buffer,
  fileSize: number,
  limits: AndroidDtboReaderLimits = DEFAULT_ANDROID_DTBO_READER_LIMITS,
): Result<AndroidDtboHeader, AndroidDtboParseError> {
  if (prefix.byteLength < 4 || fileSize < 4) {
    return err(
      truncatedInput(
        ANDROID_DTBO_FORMAT,
        "Android DTBO image is smaller than the 4-byte magic.",
        {
          offset: 0,
          field: "magic",
          extent: {
            availableBytes: Math.min(prefix.byteLength, fileSize),
            requiredBytes: ANDROID_DTBO_HEADER_MIN_SIZE,
          },
        },
      ),
    );
  }

  if (!hasAndroidDtboMagic(prefix)) {
    return err(
      malformedInput(
        ANDROID_DTBO_FORMAT,
        "Missing Android DTBO dt_table_header magic (expected 0xd7b7ab1e).",
        { offset: 0, field: "magic" },
      ),
    );
  }

  if (
    prefix.byteLength < ANDROID_DTBO_HEADER_MIN_SIZE ||
    fileSize < ANDROID_DTBO_HEADER_MIN_SIZE
  ) {
    return err(
      truncatedInput(
        ANDROID_DTBO_FORMAT,
        `Android DTBO image (${fileSize} bytes) is smaller than the 32-byte dt_table_header.`,
        {
          offset: 0,
          field: "dt_table_header",
          extent: {
            availableBytes: Math.min(prefix.byteLength, fileSize),
            requiredBytes: ANDROID_DTBO_HEADER_MIN_SIZE,
          },
        },
      ),
    );
  }

  const reader = new BinaryReader(prefix, false, ANDROID_DTBO_FORMAT);
  const magic = reader.u32(HEADER.magic);
  const totalSize = reader.u32(HEADER.totalSize);
  const headerSize = reader.u32(HEADER.headerSize);
  const dtEntrySize = reader.u32(HEADER.dtEntrySize);
  const dtEntryCount = reader.u32(HEADER.dtEntryCount);
  const dtEntriesOffset = reader.u32(HEADER.dtEntriesOffset);
  const pageSize = reader.u32(HEADER.pageSize);
  const rawVersion = reader.u32(HEADER.version);

  if (rawVersion !== 0 && rawVersion !== 1) {
    return err(
      unsupportedInput(
        ANDROID_DTBO_FORMAT,
        `Android DTBO header version ${rawVersion} is unsupported (expected 0 or 1).`,
        { offset: 28, field: "version", undecodedContent: true },
      ),
    );
  }

  if (headerSize < ANDROID_DTBO_HEADER_MIN_SIZE) {
    return err(
      malformedInput(
        ANDROID_DTBO_FORMAT,
        `Android DTBO header_size ${headerSize} is smaller than ${ANDROID_DTBO_HEADER_MIN_SIZE} bytes.`,
        { offset: 8, field: "header_size" },
      ),
    );
  }

  if (totalSize < headerSize) {
    return err(
      malformedInput(
        ANDROID_DTBO_FORMAT,
        `Android DTBO total_size (${totalSize}) is smaller than header_size (${headerSize}).`,
        { offset: 4, field: "total_size" },
      ),
    );
  }

  if (fileSize < headerSize) {
    return err(
      truncatedInput(
        ANDROID_DTBO_FORMAT,
        `Android DTBO image (${fileSize} bytes) is shorter than declared header_size (${headerSize}).`,
        {
          offset: 8,
          field: "header_size",
          extent: { availableBytes: fileSize, requiredBytes: headerSize },
        },
      ),
    );
  }

  if (fileSize < totalSize) {
    return err(
      truncatedInput(
        ANDROID_DTBO_FORMAT,
        `Android DTBO image (${fileSize} bytes) is shorter than declared total_size (${totalSize}).`,
        {
          offset: 4,
          field: "total_size",
          extent: { availableBytes: fileSize, requiredBytes: totalSize },
        },
      ),
    );
  }

  if (dtEntriesOffset < headerSize) {
    return err(
      malformedInput(
        ANDROID_DTBO_FORMAT,
        `Android DTBO dt_entries_offset (${dtEntriesOffset}) overlaps dt_table_header (${headerSize} bytes).`,
        { offset: 20, field: "dt_entries_offset" },
      ),
    );
  }

  if (dtEntriesOffset > totalSize) {
    return err(
      malformedInput(
        ANDROID_DTBO_FORMAT,
        `Android DTBO dt_entries_offset (${dtEntriesOffset}) exceeds declared total_size (${totalSize}).`,
        { offset: 20, field: "dt_entries_offset" },
      ),
    );
  }

  if (dtEntryCount > 0 && dtEntrySize < ANDROID_DTBO_ENTRY_MIN_SIZE) {
    return err(
      malformedInput(
        ANDROID_DTBO_FORMAT,
        `Android DTBO dt_entry_size ${dtEntrySize} is smaller than ${ANDROID_DTBO_ENTRY_MIN_SIZE} bytes.`,
        { offset: 12, field: "dt_entry_size" },
      ),
    );
  }

  if (dtEntrySize !== 0 && dtEntrySize < ANDROID_DTBO_ENTRY_MIN_SIZE) {
    return err(
      malformedInput(
        ANDROID_DTBO_FORMAT,
        `Android DTBO dt_entry_size ${dtEntrySize} is smaller than ${ANDROID_DTBO_ENTRY_MIN_SIZE} bytes.`,
        { offset: 12, field: "dt_entry_size" },
      ),
    );
  }

  const tableSize = dtEntryCount * dtEntrySize;
  const tableEnd = dtEntriesOffset + tableSize;
  if (
    !Number.isSafeInteger(tableSize) ||
    !Number.isSafeInteger(tableEnd) ||
    tableEnd > totalSize
  ) {
    return err(
      malformedInput(
        ANDROID_DTBO_FORMAT,
        `Android DTBO entry table (${dtEntryCount} entries * ${dtEntrySize} bytes at ${dtEntriesOffset}) exceeds total_size (${totalSize}).`,
        { offset: 16, field: "dt_entry_count" },
      ),
    );
  }

  if (tableSize > limits.entry_table_bytes) {
    return err(
      decodeLimit(
        ANDROID_DTBO_FORMAT,
        `Android DTBO entry table requires ${tableSize} bytes, exceeding ${ANDROID_DTBO_LIMITS.entryTableBytes.parameter} (${limits.entry_table_bytes} bytes).`,
        {
          name: ANDROID_DTBO_LIMITS.entryTableBytes.name,
          maximum: limits.entry_table_bytes,
          required: tableSize,
        },
        { offset: 12, field: "dt_entry_size" },
      ),
    );
  }

  if (dtEntryCount > limits.entry_count) {
    return err(
      decodeLimit(
        ANDROID_DTBO_FORMAT,
        `Android DTBO dt_entry_count ${dtEntryCount} exceeds ${ANDROID_DTBO_LIMITS.entryCount.parameter} (${limits.entry_count} entries).`,
        {
          name: ANDROID_DTBO_LIMITS.entryCount.name,
          maximum: limits.entry_count,
          required: dtEntryCount,
        },
        { offset: 16, field: "dt_entry_count" },
      ),
    );
  }

  const limitations: string[] = [];
  if (headerSize > ANDROID_DTBO_HEADER_MIN_SIZE) {
    limitations.push(
      `${headerSize - ANDROID_DTBO_HEADER_MIN_SIZE} extra header bytes beyond the 32-byte dt_table_header were not decoded.`,
    );
  }
  if (dtEntryCount > 0 && dtEntrySize > ANDROID_DTBO_ENTRY_MIN_SIZE) {
    limitations.push(
      `Each dt_table_entry reserves ${dtEntrySize} bytes; ${dtEntrySize - ANDROID_DTBO_ENTRY_MIN_SIZE} trailing bytes per entry beyond 32 bytes were not decoded.`,
    );
  }
  if (fileSize > totalSize) {
    limitations.push(
      `${fileSize - totalSize} trailing bytes follow declared total_size (${totalSize}) and were not decoded.`,
    );
  }

  return ok({
    magic,
    totalSize,
    headerSize,
    dtEntrySize,
    dtEntryCount,
    dtEntriesOffset,
    pageSize,
    version: rawVersion,
    tableSize,
    limitations,
  });
}

export function parseAndroidDtboEntries(
  header: AndroidDtboHeader,
  tableBuffer: Buffer,
): Result<
  AndroidDtboParsedTable,
  ParseFailureError<"malformed"> | ParseFailureError<"truncated">
> {
  if (header.dtEntryCount === 0) {
    return ok({
      entries: [],
      limitations: [
        "Android DTBO header declares dt_entry_count 0; no child device tree blobs are present.",
      ],
      unaccountedRanges: unaccountedRanges(header, []),
    });
  }

  if (tableBuffer.byteLength < header.tableSize) {
    return err(
      truncatedInput(
        ANDROID_DTBO_FORMAT,
        `Android DTBO entry table (${tableBuffer.byteLength} bytes) is shorter than declared ${header.tableSize} bytes.`,
        {
          offset: header.dtEntriesOffset,
          field: "dt_entries_offset",
          extent: {
            availableBytes: tableBuffer.byteLength,
            requiredBytes: header.tableSize,
          },
        },
      ),
    );
  }

  const reader = new BinaryReader(tableBuffer, false, ANDROID_DTBO_FORMAT);
  const tableStart = header.dtEntriesOffset;
  const tableEnd = tableStart + header.tableSize;
  const parsed: AndroidDtboTableEntry[] = [];
  const limitations: string[] = [];

  for (let index = 0; index < header.dtEntryCount; index++) {
    const rowOffset = index * header.dtEntrySize;
    const absRowOffset = tableStart + rowOffset;
    const dtSize = reader.u32(rowOffset + ENTRY.dtSize);
    const dtOffset = reader.u32(rowOffset + ENTRY.dtOffset);
    const id = reader.u32(rowOffset + ENTRY.id);
    const rev = reader.u32(rowOffset + ENTRY.rev);

    let flags: number | null = null;
    let compression: AndroidDtboCompressionMode | null = null;
    let custom: readonly number[];

    if (header.version === 0) {
      custom = ENTRY.customV0.map((at) => reader.u32(rowOffset + at));
    } else {
      flags = reader.u32(rowOffset + ENTRY.flagsV1);
      compression = decodeDtboCompression(flags);
      custom = ENTRY.customV1.map((at) => reader.u32(rowOffset + at));
    }

    const entryEnd = dtOffset + dtSize;
    if (!Number.isSafeInteger(entryEnd)) {
      return err(
        malformedInput(
          ANDROID_DTBO_FORMAT,
          `DTBO entry ${index} overflows integer range (dt_offset ${dtOffset}, dt_size ${dtSize}).`,
          { offset: absRowOffset, field: "dt_offset" },
        ),
      );
    }

    if (dtSize === 0) {
      if (dtOffset > header.totalSize) {
        return err(
          malformedInput(
            ANDROID_DTBO_FORMAT,
            `Empty DTBO entry ${index} offset (${dtOffset}) exceeds declared total_size (${header.totalSize}).`,
            { offset: absRowOffset + 4, field: "dt_offset" },
          ),
        );
      }
      limitations.push(
        `DTBO entry ${index} (offset ${dtOffset}) declares dt_size 0 and was omitted.`,
      );
      continue;
    }

    if (dtOffset < header.headerSize) {
      return err(
        malformedInput(
          ANDROID_DTBO_FORMAT,
          `DTBO entry ${index} payload [${dtOffset}, ${entryEnd}) overlaps dt_table_header (${header.headerSize} bytes).`,
          { offset: absRowOffset + 4, field: "dt_offset" },
        ),
      );
    }

    if (dtOffset < tableEnd && entryEnd > tableStart) {
      return err(
        malformedInput(
          ANDROID_DTBO_FORMAT,
          `DTBO entry ${index} payload [${dtOffset}, ${entryEnd}) overlaps dt_table_entry table [${tableStart}, ${tableEnd}).`,
          { offset: absRowOffset + 4, field: "dt_offset" },
        ),
      );
    }

    if (entryEnd > header.totalSize) {
      return err(
        malformedInput(
          ANDROID_DTBO_FORMAT,
          `DTBO entry ${index} payload [${dtOffset}, ${entryEnd}) exceeds declared total_size (${header.totalSize}).`,
          { offset: absRowOffset, field: "dt_offset" },
        ),
      );
    }

    parsed.push({
      index,
      absRowOffset,
      dtSize,
      dtOffset,
      id,
      rev,
      flags,
      compression,
      custom,
    });
  }

  const orderedByOffset = [...parsed].sort(
    (left, right) => left.dtOffset - right.dtOffset || left.index - right.index,
  );
  for (let i = 1; i < orderedByOffset.length; i++) {
    const prev = orderedByOffset[i - 1];
    const curr = orderedByOffset[i];
    if (!prev || !curr) continue;
    const prevEnd = prev.dtOffset + prev.dtSize;
    // mkdtimg writes a repeated input file once and points every entry for
    // it at the same payload (mkdtimg_core.c search_fdt_info), so an exactly
    // shared range is valid. Any other intersection is malformed.
    if (prev.dtOffset === curr.dtOffset && prev.dtSize === curr.dtSize) {
      limitations.push(
        `DTBO entries ${prev.index} and ${curr.index} share the stored payload [${curr.dtOffset}, ${prevEnd}).`,
      );
      continue;
    }
    if (prevEnd > curr.dtOffset) {
      return err(
        malformedInput(
          ANDROID_DTBO_FORMAT,
          `DTBO entry ${prev.index} [${prev.dtOffset}, ${prevEnd}) overlaps DTBO entry ${curr.index} [${curr.dtOffset}, ${curr.dtOffset + curr.dtSize}).`,
          { offset: curr.absRowOffset + 4, field: "dt_table_entry_overlap" },
        ),
      );
    }
  }

  return ok({
    entries: parsed,
    limitations,
    unaccountedRanges: unaccountedRanges(header, orderedByOffset),
  });
}

/**
 * Byte ranges inside `total_size` that neither the header, the entry table
 * nor any entry payload claims. mkdtimg writes them contiguously, so a gap
 * may hold bytes no entry lists.
 */
const unaccountedRanges = (
  header: AndroidDtboHeader,
  ordered: readonly AndroidDtboTableEntry[],
): readonly (readonly [number, number])[] => {
  const claimed: (readonly [number, number])[] = [
    [0, header.headerSize] as const,
    [
      header.dtEntriesOffset,
      header.dtEntriesOffset + header.tableSize,
    ] as const,
    ...ordered.map(
      (entry) => [entry.dtOffset, entry.dtOffset + entry.dtSize] as const,
    ),
  ].sort((left, right) => left[0] - right[0]);
  const gaps: (readonly [number, number])[] = [];
  let reached = 0;
  for (const [start, end] of claimed) {
    if (start > reached) gaps.push([reached, start]);
    reached = Math.max(reached, end);
  }
  if (header.totalSize > reached) gaps.push([reached, header.totalSize]);
  return gaps;
};
