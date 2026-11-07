import { createHash } from "node:crypto";
import { ok, type Result } from "../result.js";
import {
  EVTX_ARCHIVE_CHUNK_BYTES,
  EVTX_ARCHIVE_MAX_DIAGNOSTICS,
  type EvtxArchive,
  type EvtxArchiveArtifact,
  type EvtxEvent,
} from "./evtxArchive.js";

/** Every EVTX file and chunk starts with an 8-byte signature. */
const FILE_MAGIC = "ElfFile\u0000";
const CHUNK_MAGIC = "ElfChnk\u0000";

const FILE_HEADER_BYTES = 128;
const CHUNK_HEADER_BYTES = 512;
const RECORD_HEADER_BYTES = 24;
const RECORD_MAGIC = 0x00002a2a;
/** `SystemTime` counts 100 ns ticks from 1601-01-01, as NTFS does. */
const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000;

type Diagnostic = Omit<EvtxArchive["diagnostics"][number], "diagnostic_id">;

interface DecodeState {
  readonly events: EvtxEvent[];
  readonly diagnostics: Diagnostic[];
  readonly maxRecords: number;
  recordLimitReported: boolean;
  diagnosticsSuppressed: boolean;
}

const digest = (prefix: string, ...parts: (string | number)[]) =>
  `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;

/** Reads a 64-bit little-endian value as a number, or null past 2^53. */
const readCount = (bytes: Buffer, offset: number): number | null => {
  const value = bytes.readBigUInt64LE(offset);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
};

const timestampMs = (bytes: Buffer, offset: number): number | null => {
  const ticks = bytes.readBigUInt64LE(offset);
  if (ticks === 0n) return null;
  return Number(ticks / 10_000n) - WINDOWS_EPOCH_OFFSET_MS;
};

/** CRC32 (IEEE 802.3), the checksum EVTX uses for chunk headers. */
const crc32 = (bytes: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/**
 * EVTX stores the checksum as CRC32 over the 512-byte chunk header, skipping
 * the four-byte stored checksum at `0x7c`.
 */
const chunkChecksumMatches = (chunk: Buffer): boolean => {
  const signed = Buffer.concat([
    chunk.subarray(0, 0x7c),
    chunk.subarray(0x80, CHUNK_HEADER_BYTES),
  ]);
  return crc32(signed) >>> 0 === chunk.readUInt32LE(0x7c);
};

const diagnose = (
  state: DecodeState,
  chunkNumber: number | null,
  ordinal: number | null,
  code: Diagnostic["code"],
  message: string,
): void => {
  if (state.diagnostics.length >= EVTX_ARCHIVE_MAX_DIAGNOSTICS) {
    state.diagnosticsSuppressed = true;
    return;
  }
  state.diagnostics.push({ chunk_number: chunkNumber, ordinal, code, message });
};

interface ChunkInventory {
  readonly chunk_number: number;
  readonly ordinal: number;
  readonly bytes: number;
  readonly events: number;
  readonly first_event_record_id: number | null;
  readonly last_event_record_id: number | null;
  readonly first_timestamp_ms: number | null;
  readonly last_timestamp_ms: number | null;
  readonly checksum: "matched" | "mismatched";
  /** True when the record allowance stopped this chunk early. */
  readonly stopped: boolean;
}

/**
 * Walks one chunk's record list. A chunk whose record region has been consumed
 * still reports the events it produced: the unread tail is not an error, and a
 * log that wrapped leaves stale bytes after the last record.
 */
const readChunk = (
  chunk: Buffer,
  chunkNumber: number,
  ordinal: number,
  state: DecodeState,
): ChunkInventory => {
  let cursor = CHUNK_HEADER_BYTES;
  let first: number | null = null;
  let last: number | null = null;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let events = 0;
  const startOrdinal = state.events.length;
  while (cursor + RECORD_HEADER_BYTES <= chunk.length) {
    if (chunk.readUInt32LE(cursor) !== RECORD_MAGIC) break;
    const size = chunk.readUInt32LE(cursor + 4);
    if (size < RECORD_HEADER_BYTES || cursor + size > chunk.length) {
      diagnose(
        state,
        chunkNumber,
        startOrdinal + events,
        "truncated-record",
        `Record at byte ${cursor} declares ${size} bytes but only ${chunk.length - cursor} remain in the chunk.`,
      );
      break;
    }
    if (state.events.length >= state.maxRecords) {
      if (!state.recordLimitReported)
        diagnose(
          state,
          chunkNumber,
          startOrdinal + events,
          "record-limit-reached",
          `Stopped at max_records=${state.maxRecords}; later records are not listed.`,
        );
      state.recordLimitReported = true;
      return {
        chunk_number: chunkNumber,
        ordinal,
        bytes: chunk.length,
        events,
        first_event_record_id: first,
        last_event_record_id: last,
        first_timestamp_ms: firstTs,
        last_timestamp_ms: lastTs,
        checksum: chunkChecksumMatches(chunk) ? "matched" : "mismatched",
        stopped: true,
      };
    }
    const recordId = readCount(chunk, cursor + 8);
    const writtenMs = timestampMs(chunk, cursor + 16);
    state.events.push({
      event_id: digest("evtx_event", chunkNumber, cursor),
      ordinal: startOrdinal + events,
      chunk_number: chunkNumber,
      chunk_offset: cursor,
      event_record_id: recordId,
      /** Header time; the XML `SystemTime` is not decoded in this step. */
      header_timestamp_ms: writtenMs,
      header_timestamp:
        writtenMs === null ? null : new Date(writtenMs).toISOString(),
      record_bytes: size,
    });
    // The endpoints describe the first and last RECORD, not the first and last
    // record that happened to carry a value: taking the first non-null would
    // report an inner record's timestamp (or id) when an endpoint is unset.
    if (first === null) first = recordId;
    if (events === 0) firstTs = writtenMs;
    last = recordId;
    lastTs = writtenMs;
    events += 1;
    cursor += size;
  }
  return {
    chunk_number: chunkNumber,
    ordinal,
    bytes: chunk.length,
    events,
    first_event_record_id: first,
    last_event_record_id: last,
    first_timestamp_ms: firstTs,
    last_timestamp_ms: lastTs,
    checksum: chunkChecksumMatches(chunk) ? "matched" : "mismatched",
    stopped: false,
  };
};

const coverage = (complete: boolean): EvtxArchive["source_coverage"] => ({
  scope: "record-headers",
  status: complete ? "complete-within-scope" : "partial",
  event_xml: "not-decoded",
  typed_payload_values: "not-decoded",
  templates: "not-resolved",
  record_checksums: "not-verified",
  network: "not-contacted",
});

const LIMITATIONS = [
  "Record headers and chunk structure are inventoried; embedded event XML is not decoded in this step.",
  "Channel, provider, event ID, level and EventData values live in the XML and are therefore absent here.",
  "Only the chunk header checksum is evaluated; per-record integrity and template resolution are not verified.",
];

const emptyArchive = (
  artifact: EvtxArchiveArtifact,
  diagnostics: Diagnostic[],
): EvtxArchive => ({
  archive_id: digest("evtx_archive", artifact.sha256),
  format: "evtx",
  artifact,
  file_version: {
    major: 0,
    minor: 0,
    header_block_bytes: 0,
    chunk_count: 0,
  },
  chunks: [],
  events: [],
  diagnostics: withIds(diagnostics),
  summary: {
    chunks: 0,
    events: 0,
    diagnostics: diagnostics.length,
  },
  source_coverage: coverage(false),
  limitations: LIMITATIONS,
});

const withIds = (diagnostics: readonly Diagnostic[]) =>
  diagnostics.map((entry, index) => ({
    ...entry,
    diagnostic_id: digest("evtx_diagnostic", index, entry.code),
  }));

export const parseEvtxArchive = (
  bytes: Buffer,
  artifact: EvtxArchiveArtifact,
  options: { readonly maxRecords: number },
): Result<EvtxArchive, never> => {
  const state: DecodeState = {
    events: [],
    diagnostics: [],
    maxRecords: options.maxRecords,
    recordLimitReported: false,
    diagnosticsSuppressed: false,
  };
  if (
    bytes.length < FILE_HEADER_BYTES ||
    bytes.toString("latin1", 0, 8) !== FILE_MAGIC
  ) {
    diagnose(
      state,
      null,
      null,
      "not-an-evtx-file",
      "The file does not start with the ElfFile signature.",
    );
    return ok(emptyArchive(artifact, state.diagnostics));
  }
  const headerBlockBytes = bytes.readUInt16LE(0x28);
  if (headerBlockBytes < FILE_HEADER_BYTES) {
    diagnose(
      state,
      null,
      null,
      "invalid-header",
      `The file header states a ${headerBlockBytes}-byte header block, which is smaller than its own 128-byte header.`,
    );
    return ok(emptyArchive(artifact, state.diagnostics));
  }
  const chunkCount = Math.max(
    0,
    Math.floor((bytes.length - headerBlockBytes) / EVTX_ARCHIVE_CHUNK_BYTES),
  );
  const chunks: EvtxArchive["chunks"] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const start = headerBlockBytes + index * EVTX_ARCHIVE_CHUNK_BYTES;
    const chunk = bytes.subarray(start, start + EVTX_ARCHIVE_CHUNK_BYTES);
    if (chunk.toString("latin1", 0, 8) !== CHUNK_MAGIC) {
      diagnose(
        state,
        index,
        null,
        "invalid-chunk",
        "Chunk does not start with the ElfChnk signature and was skipped.",
      );
      continue;
    }
    // 0x08 is the FIRST EVENT RECORD NUMBER, not a chunk sequence number: an
    // intact log whose chunks do not start at record 1 (a wrapped file, or one
    // exported mid-stream) would otherwise be reported as mismatched on every
    // chunk, and every event's chunk_number would carry a record number. The
    // physical position is the only chunk number this parser can vouch for, so
    // the header field is checked against the first record's own id instead.
    const statedFirstRecordNumber = readCount(chunk, 8);
    const inventory = readChunk(chunk, index, index, state);
    if (
      statedFirstRecordNumber !== null &&
      inventory.first_event_record_id !== null &&
      statedFirstRecordNumber !== inventory.first_event_record_id
    )
      diagnose(
        state,
        index,
        null,
        "first-record-number-mismatch",
        `Chunk at position ${index} states its first record is ${statedFirstRecordNumber}, but the first record reads ${inventory.first_event_record_id}.`,
      );
    chunks.push({
      chunk_number: inventory.chunk_number,
      ordinal: inventory.ordinal,
      bytes: inventory.bytes,
      first_event_record_id: inventory.first_event_record_id,
      last_event_record_id: inventory.last_event_record_id,
      first_timestamp_ms: inventory.first_timestamp_ms,
      last_timestamp_ms: inventory.last_timestamp_ms,
      events: inventory.events,
      checksum: inventory.checksum,
    });
    if (inventory.stopped) break;
  }
  if (state.diagnosticsSuppressed)
    state.diagnostics.push({
      chunk_number: null,
      ordinal: null,
      code: "diagnostic-limit-reached",
      message: `More than ${EVTX_ARCHIVE_MAX_DIAGNOSTICS} diagnostics; the rest were summarised.`,
    });
  return ok({
    archive_id: digest("evtx_archive", artifact.sha256),
    format: "evtx",
    artifact,
    file_version: {
      // `0x18` is the next-record identifier, not a version field; EVTX
      // stores the minor version at `0x24` and the major at `0x26`.
      major: bytes.readUInt16LE(0x26),
      minor: bytes.readUInt16LE(0x24),
      header_block_bytes: headerBlockBytes,
      chunk_count: chunkCount,
    },
    chunks,
    events: state.events,
    diagnostics: withIds(state.diagnostics),
    summary: {
      chunks: chunks.length,
      events: state.events.length,
      diagnostics: state.diagnostics.length,
    },
    source_coverage: coverage(
      !state.recordLimitReported &&
        !state.diagnosticsSuppressed &&
        state.diagnostics.length === 0 &&
        chunks.length === chunkCount,
    ),
    limitations: LIMITATIONS,
  });
};
