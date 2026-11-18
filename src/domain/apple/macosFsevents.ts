import {
  gunzipSync,
  inflateRawSync,
  constants as zlibConstants,
} from "node:zlib";

import { errorMessage } from "../../kernel/errorMessage.js";
import { BinaryFormatFailure, BinaryReader } from "../binaryContainer.js";
import type { RegionDecodeFailure } from "../firmware/regionDecoder.js";
import { err, ok, type Result } from "../result.js";
import { decodeStrictUtf8, isStrictUtf8 } from "../strictUtf8.js";
import {
  decodeFseventsFlags,
  FSEVENTS_FLAG_END_OF_TRANSACTION,
  FSEVENTS_FLAG_MOUNT,
  FSEVENTS_FLAG_TRUNCATED_PATH,
  FSEVENTS_FLAG_UNMOUNT,
  FSEVENTS_INLINE_BLOCK_LIMIT,
  FSEVENTS_INLINE_DIAGNOSTIC_LIMIT,
  FSEVENTS_INLINE_EVENT_LIMIT,
  FSEVENTS_MAX_DECOMPRESSED_BYTES,
  FSEVENTS_MAX_FILE_BYTES,
  RecentEventIdTracker,
  type MacosFseventsBlockSummary,
  type MacosFseventsDiagnostic,
  type MacosFseventsInventory,
  type MacosFseventsRecordSample,
  type MacosFseventsStoreVersion,
} from "./macosFseventsFlags.js";

export type {
  MacosFseventsBlockSummary,
  MacosFseventsDecodedFlags,
  MacosFseventsDiagnostic,
  MacosFseventsInventory,
  MacosFseventsMetadata,
  MacosFseventsRecordSample,
  MacosFseventsStoreVersion,
} from "./macosFseventsFlags.js";
export {
  decodeFseventsFlags,
  FSEVENTS_INLINE_BLOCK_LIMIT,
  FSEVENTS_INLINE_DIAGNOSTIC_LIMIT,
  FSEVENTS_INLINE_EVENT_LIMIT,
  FSEVENTS_MAX_DECOMPRESSED_BYTES,
  FSEVENTS_MAX_FILE_BYTES,
} from "./macosFseventsFlags.js";

const DLS_HEADER_BYTES = 12;
const FSEVENTS_FORMAT_LABEL = "macos-fsevents";
const GZIP_SNIFF_MAX_OUTPUT_BYTES = 64 * 1024;
const GZIP_SNIFF_SLICES = [24, 48, 96, 256, 512, 1024] as const;

const GZIP_FLAG = {
  fhcrc: 0x02,
  fextra: 0x04,
  fname: 0x08,
  fcomment: 0x10,
  reserved: 0xe0,
} as const;

const SUFFIX_BYTES_BY_VERSION: Record<MacosFseventsStoreVersion, number> = {
  "1SLD": 12,
  "2SLD": 20,
  "3SLD": 24,
};

/**
 * Lossy fallback decoder used only when `isStrictUtf8` has established invalid
 * UTF-8 bytes so sampled records remain inspectable alongside `raw_path_hex`.
 */
const LOSSY_UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: false,
  ignoreBOM: true,
});

const asBuffer = (bytes: Uint8Array): Buffer =>
  Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const readDlsSignature = (
  bytes: Uint8Array,
  offset = 0,
): MacosFseventsStoreVersion | undefined => {
  if (offset + 4 > bytes.length) return undefined;
  if (
    bytes[offset + 1] !== 0x53 ||
    bytes[offset + 2] !== 0x4c ||
    bytes[offset + 3] !== 0x44
  )
    return undefined;
  const b0 = bytes[offset];
  if (b0 === 0x31) return "1SLD";
  if (b0 === 0x32) return "2SLD";
  if (b0 === 0x33) return "3SLD";
  return undefined;
};

const isGzipHeader = (bytes: Uint8Array): boolean =>
  bytes.length >= 10 &&
  bytes[0] === 0x1f &&
  bytes[1] === 0x8b &&
  bytes[2] === 0x08;

const gzipDeflateOffset = (bytes: Uint8Array): number => {
  if (!isGzipHeader(bytes)) return -1;
  const flags = bytes[3] ?? 0;
  if ((flags & GZIP_FLAG.reserved) !== 0) return -1;
  let offset = 10;
  if ((flags & GZIP_FLAG.fextra) !== 0) {
    if (offset + 2 > bytes.length) return -1;
    offset +=
      2 +
      new BinaryReader(asBuffer(bytes), true, FSEVENTS_FORMAT_LABEL).u16(
        offset,
      );
  }
  for (const bit of [GZIP_FLAG.fname, GZIP_FLAG.fcomment]) {
    if ((flags & bit) === 0) continue;
    const nul = bytes.indexOf(0x00, offset);
    if (nul === -1) return -1;
    offset = nul + 1;
  }
  if ((flags & GZIP_FLAG.fhcrc) !== 0) offset += 2;
  return offset < bytes.length ? offset : -1;
};

const sniffGzipDlsSignature = (
  prefix: Uint8Array,
): MacosFseventsStoreVersion | undefined => {
  const deflateStart = gzipDeflateOffset(prefix);
  if (deflateStart === -1) return undefined;
  const buf = asBuffer(prefix);
  for (const sliceLength of GZIP_SNIFF_SLICES) {
    const end = Math.min(buf.length, deflateStart + sliceLength);
    try {
      const inflated = inflateRawSync(buf.subarray(deflateStart, end), {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
        maxOutputLength: GZIP_SNIFF_MAX_OUTPUT_BYTES,
      });
      if (inflated.length >= 4) return readDlsSignature(inflated, 0);
    } catch {
      return undefined;
    }
    if (end === buf.length) break;
  }
  return undefined;
};

/**
 * Whether leading bytes identify a macOS `.fseventsd` Disk Log Stream
 * directly (`1SLD`/`2SLD`/`3SLD` >= 12 bytes) or via a bounded gzip peek.
 */
export const hasMacosFseventsHeader = (prefix: Uint8Array): boolean =>
  (prefix.length >= DLS_HEADER_BYTES &&
    readDlsSignature(prefix, 0) !== undefined) ||
  sniffGzipDlsSignature(prefix) !== undefined;

const formatFailure = (message: string): RegionDecodeFailure => ({
  kind: "format",
  message,
});

const limitFailure = (
  message: string,
  boundary: "file-size" | "capacity",
): RegionDecodeFailure => ({
  kind: "limit",
  message,
  boundary,
});

const unwrapGzipStream = (
  rawBytes: Buffer,
): Result<
  { readonly stream: Buffer; readonly compression: "gzip" | "none" },
  RegionDecodeFailure
> => {
  if (rawBytes.length > FSEVENTS_MAX_FILE_BYTES)
    return err(
      limitFailure(
        `input is ${String(rawBytes.length)} bytes (maximum ${String(FSEVENTS_MAX_FILE_BYTES)})`,
        "file-size",
      ),
    );
  if (!isGzipHeader(rawBytes)) {
    if (rawBytes.length > FSEVENTS_MAX_DECOMPRESSED_BYTES)
      return err(
        limitFailure(
          `stream is ${String(rawBytes.length)} bytes (maximum ${String(FSEVENTS_MAX_DECOMPRESSED_BYTES)})`,
          "capacity",
        ),
      );
    return ok({ stream: rawBytes, compression: "none" });
  }
  try {
    const stream = gunzipSync(rawBytes, {
      maxOutputLength: FSEVENTS_MAX_DECOMPRESSED_BYTES,
    });
    return ok({ stream, compression: "gzip" });
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE")
      return err(
        limitFailure(
          `decompressed stream exceeds ${String(FSEVENTS_MAX_DECOMPRESSED_BYTES)} bytes`,
          "capacity",
        ),
      );
    return err(
      formatFailure(`gzip decompression failed: ${errorMessage(error)}`),
    );
  }
};

const isAllZero = (bytes: Uint8Array, start: number): boolean => {
  for (let i = start; i < bytes.length; i++) if (bytes[i] !== 0) return false;
  return true;
};

class FseventsAccumulator {
  readonly #stream: Buffer;
  readonly #reader: BinaryReader;
  readonly #recentIds = new RecentEventIdTracker();

  readonly versionsSeen = new Set<MacosFseventsStoreVersion>();
  readonly blocks: MacosFseventsBlockSummary[] = [];
  readonly diagnostics: MacosFseventsDiagnostic[] = [];
  readonly records: MacosFseventsRecordSample[] = [];
  readonly flagTotals = new Map<string, number>();

  blockCount = 0;
  recordCount = 0;
  totalDiagnostics = 0;
  firstEventId: bigint | null = null;
  lastEventId: bigint | null = null;
  previousEventId: bigint | null = null;
  outOfOrderCount = 0;
  duplicateIdCount = 0;
  gapCount = 0;
  mountCount = 0;
  unmountCount = 0;
  eotCount = 0;
  truncatedPathFlagCount = 0;
  // not-an-allowance: total malformed UTF-8 paths tallied across full stream; diagnostic sample stops at FSEVENTS_INLINE_DIAGNOSTIC_LIMIT.
  nonUtf8PathCount = 0;
  malformedRecordCount = 0;
  trailingZeroBytes = 0;
  unknownFlagBitRecords = 0;
  truncatedBlockCount = 0;
  trailingNonDlsBytes = false;

  constructor(stream: Buffer, reader: BinaryReader) {
    this.#stream = stream;
    this.#reader = reader;
  }

  addDiagnostic(streamOffset: number, reason: string, detail: string): void {
    this.totalDiagnostics += 1;
    if (this.diagnostics.length < FSEVENTS_INLINE_DIAGNOSTIC_LIMIT)
      this.diagnostics.push({ stream_offset: streamOffset, reason, detail });
  }

  scanBlock(
    pos: number,
  ): Result<{ readonly nextPos: number | null }, RegionDecodeFailure> {
    const version = readDlsSignature(this.#stream, pos);
    if (version === undefined) {
      this.trailingNonDlsBytes = true;
      this.addDiagnostic(
        pos,
        "invalid-block-signature",
        `unexpected bytes at offset ${String(pos)} instead of 1SLD/2SLD/3SLD`,
      );
      return ok({ nextPos: null });
    }
    const reservedWord = this.#reader.u32(pos + 4);
    const declaredStreamSize = this.#reader.u32(pos + 8);
    if (declaredStreamSize < DLS_HEADER_BYTES)
      return err(
        formatFailure(
          `block ${String(this.blockCount)} at offset ${String(pos)} declares stream size ${String(declaredStreamSize)} smaller than ${String(DLS_HEADER_BYTES)}`,
        ),
      );

    const blockEnd = Math.min(this.#stream.length, pos + declaredStreamSize);
    const blockTruncated = pos + declaredStreamSize > this.#stream.length;
    if (blockTruncated) {
      this.truncatedBlockCount += 1;
      this.addDiagnostic(
        pos,
        "truncated-block",
        `block ${String(this.blockCount)} declares ${String(declaredStreamSize)} bytes, but only ${String(this.#stream.length - pos)} bytes are present`,
      );
    }

    this.versionsSeen.add(version);
    const stats = this.#scanBlockRecords(
      pos + DLS_HEADER_BYTES,
      blockEnd,
      version,
    );
    if (this.blocks.length < FSEVENTS_INLINE_BLOCK_LIMIT) {
      this.blocks.push({
        index: this.blockCount,
        stream_offset: pos,
        version,
        reserved_word: reservedWord,
        declared_stream_size: declaredStreamSize,
        available_bytes: blockEnd - pos,
        record_count: stats.recordCount,
        first_event_id: stats.firstId?.toString() ?? null,
        last_event_id: stats.lastId?.toString() ?? null,
        trailing_unparsed_bytes: blockEnd - stats.cursor,
        truncated: blockTruncated || stats.malformed,
      });
    }
    this.blockCount += 1;
    return ok({ nextPos: blockTruncated ? null : pos + declaredStreamSize });
  }

  #scanBlockRecords(
    startCursor: number,
    blockEnd: number,
    version: MacosFseventsStoreVersion,
  ) {
    const suffixBytes = SUFFIX_BYTES_BY_VERSION[version];
    let cursor = startCursor;
    let recordCount = 0;
    let firstId: bigint | null = null;
    let lastId: bigint | null = null;
    let malformed = false;

    while (cursor < blockEnd) {
      const nul = this.#stream.indexOf(0x00, cursor);
      if (nul === -1 || nul >= blockEnd) {
        this.malformedRecordCount += 1;
        malformed = true;
        this.addDiagnostic(
          cursor,
          "unterminated-path",
          `record path starting at offset ${String(cursor)} lacks a NUL terminator before block end ${String(blockEnd)}`,
        );
        break;
      }
      const suffixStart = nul + 1;
      if (suffixStart + suffixBytes > blockEnd) {
        this.malformedRecordCount += 1;
        malformed = true;
        this.addDiagnostic(
          cursor,
          "truncated-record-suffix",
          `${version} record at offset ${String(cursor)} needs ${String(suffixBytes)} trailer bytes, leaving only ${String(blockEnd - suffixStart)}`,
        );
        break;
      }
      const eventId = this.#consumeRecord(cursor, nul, version);
      firstId ??= eventId;
      lastId = eventId;
      recordCount += 1;
      cursor = suffixStart + suffixBytes;
    }

    return { cursor, recordCount, firstId, lastId, malformed };
  }

  #consumeRecord(
    cursor: number,
    nulOffset: number,
    version: MacosFseventsStoreVersion,
  ): bigint {
    const pathBytes = this.#stream.subarray(cursor, nulOffset);
    const suffixStart = nulOffset + 1;
    const strictUtf8 = isStrictUtf8(pathBytes);
    if (!strictUtf8) {
      this.nonUtf8PathCount += 1;
      if (this.nonUtf8PathCount <= FSEVENTS_INLINE_DIAGNOSTIC_LIMIT)
        this.addDiagnostic(
          cursor,
          "invalid-utf8-path",
          `path at offset ${String(cursor)} is not valid UTF-8 (${String(pathBytes.length)} bytes)`,
        );
    }

    const eventId = this.#reader.word(suffixStart, 64);
    const decodedFlags = decodeFseventsFlags(this.#reader.u32(suffixStart + 8));
    const nodeId =
      version === "1SLD" ? null : this.#reader.word(suffixStart + 12, 64);
    const extraWord =
      version === "3SLD" ? this.#reader.u32(suffixStart + 20) : null;

    this.#accumulateFlags(
      decodedFlags.raw,
      decodedFlags.names,
      decodedFlags.unknown_mask,
    );

    const duplicate = this.#recentIds.seenOrRecord(eventId);
    if (duplicate) this.duplicateIdCount += 1;
    const outOfOrder =
      this.previousEventId !== null && eventId < this.previousEventId;
    if (outOfOrder) this.outOfOrderCount += 1;
    const gap =
      this.previousEventId !== null && eventId > this.previousEventId + 1n
        ? eventId - this.previousEventId - 1n
        : null;
    if (gap !== null) this.gapCount += 1;

    this.firstEventId ??= eventId;
    this.lastEventId = eventId;
    this.previousEventId = eventId;

    if (this.records.length < FSEVENTS_INLINE_EVENT_LIMIT) {
      this.records.push({
        block_index: this.blockCount,
        stream_offset: cursor,
        version,
        event_id: eventId.toString(),
        flags: decodedFlags,
        path: strictUtf8
          ? decodeStrictUtf8(pathBytes, "preserve")
          : LOSSY_UTF8_DECODER.decode(pathBytes),
        path_encoding: strictUtf8 ? "utf-8" : "invalid-utf8",
        raw_path_hex: pathBytes.toString("hex"),
        node_id: nodeId?.toString() ?? null,
        extra_word: extraWord,
        out_of_order: outOfOrder,
        duplicate_event_id: duplicate,
        event_id_gap_from_previous: gap?.toString() ?? null,
      });
    }

    this.recordCount += 1;
    return eventId;
  }

  #accumulateFlags(
    raw: number,
    names: readonly string[],
    unknownMask: number,
  ): void {
    if ((raw & FSEVENTS_FLAG_MOUNT) !== 0) this.mountCount += 1;
    if ((raw & FSEVENTS_FLAG_UNMOUNT) !== 0) this.unmountCount += 1;
    if ((raw & FSEVENTS_FLAG_END_OF_TRANSACTION) !== 0) this.eotCount += 1;
    if ((raw & FSEVENTS_FLAG_TRUNCATED_PATH) !== 0)
      this.truncatedPathFlagCount += 1;
    for (const name of names)
      this.flagTotals.set(name, (this.flagTotals.get(name) ?? 0) + 1);
    if (unknownMask === 0) return;
    this.unknownFlagBitRecords += 1;
    this.flagTotals.set(
      "unknown-bits",
      (this.flagTotals.get("unknown-bits") ?? 0) + 1,
    );
  }

  buildLimitations(): string[] {
    const out: string[] = [];
    if (this.truncatedBlockCount > 0)
      out.push(
        `${String(this.truncatedBlockCount)} DLS block(s) are truncated before their declared stream size.`,
      );
    if (this.malformedRecordCount > 0)
      out.push(
        `${String(this.malformedRecordCount)} event record(s) terminated early with an unterminated path or truncated fixed trailer.`,
      );
    if (this.nonUtf8PathCount > 0)
      out.push(
        `${String(this.nonUtf8PathCount)} path record(s) contained non-UTF-8 byte sequences; raw_path_hex preserves original bytes for sampled records.`,
      );
    if (this.trailingNonDlsBytes)
      out.push(
        "Trailing non-zero bytes remained after valid DLS blocks without a supported 1SLD/2SLD/3SLD block header.",
      );
    if (this.gapCount > 0)
      out.push(
        `${String(this.gapCount)} event ID increment gap(s) appear between consecutive records.`,
      );
    if (this.outOfOrderCount > 0)
      out.push(
        `${String(this.outOfOrderCount)} record(s) carried an event ID lower than the preceding record.`,
      );
    if (this.unknownFlagBitRecords > 0)
      out.push(
        `${String(this.unknownFlagBitRecords)} record(s) carried flag bits outside the documented Darwin disk mask table (preserved in flags.raw and flags.unknown_mask).`,
      );
    return out;
  }
}

/**
 * Parse a complete raw or gzip-compressed macOS `.fseventsd` Disk Log Stream
 * buffer into bounded structural inventory and diagnostics.
 */
export const parseMacosFseventsBytes = (
  inputBytes: Uint8Array,
): Result<MacosFseventsInventory, RegionDecodeFailure> => {
  const rawBuffer = asBuffer(inputBytes);
  const unwrapped = unwrapGzipStream(rawBuffer);
  if (!unwrapped.ok) return unwrapped;
  const { stream, compression } = unwrapped.value;

  if (stream.length < DLS_HEADER_BYTES)
    return err(
      formatFailure(
        `stream is ${String(stream.length)} bytes, shorter than one ${String(DLS_HEADER_BYTES)}-byte DLS header`,
      ),
    );
  if (readDlsSignature(stream, 0) === undefined)
    return err(
      formatFailure(
        "stream does not begin with a supported DLS signature (1SLD, 2SLD, 3SLD)",
      ),
    );

  const reader = new BinaryReader(stream, true, FSEVENTS_FORMAT_LABEL);
  const state = new FseventsAccumulator(stream, reader);
  try {
    for (let pos = 0; pos < stream.length;) {
      if (isAllZero(stream, pos)) {
        state.trailingZeroBytes += stream.length - pos;
        break;
      }
      if (pos + DLS_HEADER_BYTES > stream.length) {
        state.trailingNonDlsBytes = true;
        state.addDiagnostic(
          pos,
          "truncated-block-header",
          `${String(stream.length - pos)} trailing bytes remain, fewer than ${String(DLS_HEADER_BYTES)} header bytes`,
        );
        break;
      }
      const step = state.scanBlock(pos);
      if (!step.ok) return step;
      if (step.value.nextPos === null) break;
      pos = step.value.nextPos;
    }
  } catch (error: unknown) {
    if (error instanceof BinaryFormatFailure)
      return err(formatFailure(error.message));
    throw error;
  }

  const flagCounts = [...state.flagTotals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, count]) => ({ name, count }));

  return ok({
    metadata: {
      kind: "macos-fsevents",
      compression,
      compressed_bytes: rawBuffer.length,
      decompressed_bytes: stream.length,
      store_versions: [...state.versionsSeen],
      block_count: state.blockCount,
      blocks: state.blocks,
      omitted_blocks: Math.max(0, state.blockCount - state.blocks.length),
      record_count: state.recordCount,
      first_event_id: state.firstEventId?.toString() ?? null,
      last_event_id: state.lastEventId?.toString() ?? null,
      out_of_order_record_count: state.outOfOrderCount,
      duplicate_event_id_count: state.duplicateIdCount,
      event_id_gap_count: state.gapCount,
      mount_event_count: state.mountCount,
      unmount_event_count: state.unmountCount,
      end_of_transaction_count: state.eotCount,
      truncated_path_flag_count: state.truncatedPathFlagCount,
      non_utf8_path_count: state.nonUtf8PathCount,
      malformed_record_count: state.malformedRecordCount,
      trailing_zero_bytes: state.trailingZeroBytes,
      flag_counts: flagCounts,
      diagnostics: state.diagnostics,
      omitted_diagnostics: Math.max(
        0,
        state.totalDiagnostics - state.diagnostics.length,
      ),
      records: state.records,
      omitted_records: Math.max(0, state.recordCount - state.records.length),
    },
    limitations: state.buildLimitations(),
  });
};
