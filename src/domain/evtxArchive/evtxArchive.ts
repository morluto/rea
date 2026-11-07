import { z } from "zod";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

/** Resource allowances, not EVTX format limits. */
export const EVTX_ARCHIVE_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const EVTX_ARCHIVE_MAX_RECORDS = 20_000;
export const EVTX_ARCHIVE_CHUNK_BYTES = 65_536;
/**
 * Diagnostics are per-event growth that `max_records` does not bound: one
 * malformed chunk may carry thousands of undecodable records. Past this count
 * the remaining failures are summarised rather than each allocated a diagnostic.
 */
export const EVTX_ARCHIVE_MAX_DIAGNOSTICS = 10_000;
export const EVTX_ARCHIVE_OPERATION = "inspect_evtx_archive" as const;
export const EVTX_ARCHIVE_PROVIDER = {
  id: "rea-evtx-archive",
  name: "REA offline Windows event log inventory",
  version: "1",
} as const;

export const evtxArchiveArtifactSchema = z.strictObject({
  path: localPathStringSchema,
  sha256: digestSchema,
  bytes: z.int().nonnegative(),
});
export type EvtxArchiveArtifact = z.output<typeof evtxArchiveArtifactSchema>;

/**
 * One record as its 24-byte header states it. The channel, provider, event ID
 * and payload live in the embedded XML, which this step does not decode, so
 * they are absent rather than inferred from the record number.
 */
export const evtxEventSchema = z.strictObject({
  event_id: prefixedDigestSchema("evtx_event"),
  ordinal: z.int().nonnegative(),
  /** Chunk position the record was found in; the chunk's stated number may differ. */
  chunk_number: z.int().nonnegative(),
  /** Byte offset of the record inside its 64 KiB chunk. */
  chunk_offset: z.int().nonnegative(),
  /** Record number as the header states it; repeated across wrapped logs. */
  event_record_id: z.int().nonnegative().nullable(),
  /** `SystemTime` from the record header, verbatim. */
  header_timestamp: z.string().nullable(),
  header_timestamp_ms: z.int().nullable(),
  /** Bytes the record occupies, as its header states. */
  record_bytes: z.int().nonnegative(),
});
export type EvtxEvent = z.output<typeof evtxEventSchema>;

export const evtxDiagnosticSchema = z.strictObject({
  diagnostic_id: prefixedDigestSchema("evtx_diagnostic"),
  /** Chunk sequence number that produced this diagnostic; null for file-wide facts. */
  chunk_number: z.int().nullable(),
  /** Ordinal of the event that produced this diagnostic; null for chunk-wide facts. */
  ordinal: z.int().nullable(),
  code: z.enum([
    "not-an-evtx-file",
    "invalid-header",
    "invalid-chunk",
    "first-record-number-mismatch",
    "record-limit-reached",
    "diagnostic-limit-reached",
    "truncated-record",
  ]),
  message: z.string(),
});

export const evtxArchiveSchema = z.strictObject({
  archive_id: prefixedDigestSchema("evtx_archive"),
  format: z.literal("evtx"),
  artifact: evtxArchiveArtifactSchema,
  file_version: z.strictObject({
    major: z.int().nonnegative(),
    minor: z.int().nonnegative(),
    header_block_bytes: z.int().nonnegative(),
    chunk_count: z.int().nonnegative(),
  }),
  chunks: z.array(
    z.strictObject({
      chunk_number: z.int().nonnegative(),
      ordinal: z.int().nonnegative(),
      /** Bytes this chunk occupies in the file; a short final chunk stays short. */
      bytes: z.int().nonnegative(),
      first_event_record_id: z.int().nonnegative().nullable(),
      last_event_record_id: z.int().nonnegative().nullable(),
      first_timestamp_ms: z.int().nonnegative().nullable(),
      last_timestamp_ms: z.int().nonnegative().nullable(),
      events: z.int().nonnegative(),
      /** Header checksum matched, mismatched, or was not checked. */
      checksum: z.enum(["matched", "mismatched", "not-checked"]),
    }),
  ),
  events: z.array(evtxEventSchema),
  diagnostics: z.array(evtxDiagnosticSchema),
  summary: z.strictObject({
    chunks: z.int().nonnegative(),
    events: z.int().nonnegative(),
    diagnostics: z.int().nonnegative(),
  }),
  /** What this inventory did and did not examine, stated rather than implied. */
  source_coverage: z.strictObject({
    scope: z.literal("record-headers"),
    status: z.enum(["complete-within-scope", "partial"]),
    event_xml: z.literal("not-decoded"),
    typed_payload_values: z.literal("not-decoded"),
    templates: z.literal("not-resolved"),
    record_checksums: z.literal("not-verified"),
    network: z.literal("not-contacted"),
  }),
  limitations: z.array(z.string()),
});
export type EvtxArchive = z.output<typeof evtxArchiveSchema>;
