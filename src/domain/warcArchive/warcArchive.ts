import { z } from "zod";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

/** Resource allowances, not WARC or HTTP format limits. */
export const WARC_ARCHIVE_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const WARC_ARCHIVE_MAX_DECODED_BYTES = 256 * 1024 * 1024;
export const WARC_ARCHIVE_MAX_RECORDS = 20_000;
export const WARC_ARCHIVE_HEADER_LINE_BYTES = 8 * 1024;
/** Bound per-record header representation before collecting fields or malformed lines. */
export const WARC_ARCHIVE_HEADER_BLOCK_BYTES = 1024 * 1024;
export const WARC_ARCHIVE_HEADER_FIELDS = 20_000;
/**
 * Diagnostics are per-record growth that `max_records` does not bound: one
 * record may carry millions of short malformed header lines. Past this count
 * the remaining lines are summarised rather than each allocated a diagnostic.
 */
export const WARC_ARCHIVE_MAX_DIAGNOSTICS = 10_000;
export const WARC_ARCHIVE_OPERATION = "inspect_warc_archive" as const;
export const WARC_ARCHIVE_PROVIDER = {
  id: "rea-warc-archive",
  name: "REA offline WARC archive inventory",
  version: "1",
} as const;

export const warcArchiveArtifactSchema = z.strictObject({
  path: localPathStringSchema,
  sha256: digestSchema,
  bytes: z.int().nonnegative(),
});
export type WarcArchiveArtifact = z.output<typeof warcArchiveArtifactSchema>;

/**
 * One record as the archive states it. Nothing here decodes a payload: a record
 * names the bytes it owns and its declared length, and a disagreement between
 * the two stays visible instead of being corrected.
 */
export const warcRecordSchema = z.strictObject({
  record_id: prefixedDigestSchema("warc_record"),
  ordinal: z.int().nonnegative(),
  /** Byte offset of `WARC/` in the decoded archive stream, not the source file. */
  offset: z.int().nonnegative(),
  record_type: z.string(),
  /** Record types this inventory interprets; unknown types stay listed, unparsed. */
  record_type_known: z.boolean(),
  warc_version: z.string(),
  warc_date: z.string().nullable(),
  warc_record_id: z.string().nullable(),
  target_uri: z.string().nullable(),
  content_type: z.string().nullable(),
  content_length: z.int().nonnegative().nullable(),
  /** Bytes actually consumed; differs from `content_length` when the record is truncated. */
  payload_bytes: z.int().nonnegative(),
  block_digest: z.string().nullable(),
  payload_digest: z.string().nullable(),
  ip_address: z.string().nullable(),
  profile: z.string().nullable(),
  segment_number: z.int().nullable(),
  /** Embedded HTTP facts, present only for `response` records with a decodable status line. */
  http: z
    .strictObject({
      status_code: z.int(),
      reason_phrase: z.string().nullable(),
      header_bytes: z.int().nonnegative(),
    })
    .nullable(),
  malformed_header_lines: z.array(z.string()),
});
export type WarcRecord = z.output<typeof warcRecordSchema>;

export const warcDiagnosticSchema = z.strictObject({
  diagnostic_id: prefixedDigestSchema("warc_diagnostic"),
  /** Ordinal of the record that produced this diagnostic; null for archive-wide facts. */
  ordinal: z.int().nullable(),
  code: z.enum([
    "not-a-warc-stream",
    "truncated-record",
    "unsupported-compression",
    "invalid-header-line",
    "invalid-content-length",
    "record-limit-reached",
    "decoded-size-limit-reached",
    "trailing-bytes",
    "diagnostic-limit-reached",
    "header-line-limit-reached",
    "header-block-limit-reached",
  ]),
  message: z.string(),
});

export const warcArchiveSchema = z.strictObject({
  archive_id: prefixedDigestSchema("warc_archive"),
  format: z.literal("warc"),
  artifact: warcArchiveArtifactSchema,
  compression: z.enum(["identity", "gzip", "mixed", "unsupported"]),
  /** Decoded stream bytes; equals `artifact.bytes` for identity compression. */
  decoded_bytes: z.int().nonnegative(),
  records: z.array(warcRecordSchema),
  diagnostics: z.array(warcDiagnosticSchema),
  summary: z.strictObject({
    records: z.int().nonnegative(),
    known_types: z.int().nonnegative(),
    unknown_types: z.int().nonnegative(),
    responses: z.int().nonnegative(),
    requests: z.int().nonnegative(),
    revisits: z.int().nonnegative(),
    malformed_headers: z.int().nonnegative(),
    diagnostics: z.int().nonnegative(),
  }),
  /** What this inventory did and did not examine, stated rather than implied. */
  source_coverage: z.strictObject({
    scope: z.literal("record-headers"),
    status: z.enum(["complete-within-scope", "partial"]),
    payloads: z.literal("not-decoded"),
    http_bodies: z.literal("not-decoded"),
    digests: z.literal("not-verified"),
    related_records: z.literal("not-linked"),
    network: z.literal("not-contacted"),
  }),
  limitations: z.array(z.string()),
});
export type WarcArchive = z.output<typeof warcArchiveSchema>;
