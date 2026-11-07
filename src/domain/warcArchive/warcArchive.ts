import { z } from "zod";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

/** Resource allowances, not WARC or HTTP format limits. */
export const WARC_ARCHIVE_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const WARC_ARCHIVE_MAX_DECODED_BYTES = 256 * 1024 * 1024;
export const WARC_ARCHIVE_MAX_RECORDS = 20_000;
export const WARC_ARCHIVE_HEADER_LINE_BYTES = 8 * 1024;
/**
 * The embedded HTTP start line is a handful of tokens. A record's payload line
 * is not subject to the WARC header line allowance, so bound it here before
 * decoding rather than letting a huge first line reach the reader.
 */
export const WARC_ARCHIVE_HTTP_START_LINE_BYTES = 8 * 1024;
/**
 * Bound the embedded HTTP header block separately from the WARC header block:
 * an exchange's headers sit inside one record's payload, so the WARC allowance
 * does not constrain them, and a record may legally declare a payload far
 * larger than any header block worth retaining.
 */
export const WARC_ARCHIVE_HTTP_HEADER_BLOCK_BYTES = 64 * 1024;
export const WARC_ARCHIVE_HTTP_HEADER_FIELDS = 2_000;
/** Bound collected header entries across the archive, not just per record. */
export const WARC_ARCHIVE_MAX_HEADER_ENTRIES = 100_000;
/** Bound per-record header representation before collecting fields or malformed lines. */
export const WARC_ARCHIVE_HEADER_BLOCK_BYTES = 1024 * 1024;
export const WARC_ARCHIVE_HEADER_FIELDS = 20_000;
/**
 * Diagnostics are per-record growth that `max_records` does not bound: one
 * record may carry millions of short malformed header lines. Past this count
 * the remaining lines are summarised rather than each allocated a diagnostic.
 */
export const WARC_ARCHIVE_MAX_DIAGNOSTICS = 10_000;
/**
 * Rejected `WARC/x.y` version lines reach `continue` without returning a
 * record, so `max_records` never bounds how many an archive can carry. A small
 * gzip can hold millions of them and the scan is synchronous, so stop after
 * this many and report the stop instead of scanning the whole expansion.
 */
export const WARC_ARCHIVE_MAX_INVALID_VERSIONS = 10_000;
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
/**
 * One embedded HTTP message as its own header block states it. Requests and
 * responses differ only in the start line, so both keep the decoded start line
 * verbatim next to the fields parsed from it. Headers are preserved in the order
 * the archive wrote them, with repeats kept: a response may legitimately carry
 * several `Set-Cookie` or `Warning` fields and collapsing them would lose what
 * the capture recorded.
 */
export const warcHttpHeaderSchema = z.strictObject({
  name: z.string(),
  /** Authentication-bearing transport fields are retained by name only. */
  value: z.string().nullable(),
});
export type WarcHttpHeader = z.output<typeof warcHttpHeaderSchema>;

export const warcHttpMessageSchema = z.strictObject({
  /** The decoded start line, e.g. `GET /a HTTP/1.1` or `HTTP/1.1 404 Not Found`. */
  start_line: z.string(),
  version: z.string(),
  /** Request method; null for a response. */
  method: z.string().nullable(),
  /** Request target as written, not resolved against the WARC target URI; null for a response. */
  request_target: z.string().nullable(),
  status_code: z.int().nullable(),
  reason_phrase: z.string().nullable(),
  headers: z.array(warcHttpHeaderSchema),
  /** Lines in the header block that are not a single `name: value` field. */
  malformed_header_lines: z.array(z.string()),
  /** Bytes of the whole message the header block occupies, start line included. */
  header_bytes: z.int().nonnegative(),
  /**
   * Payload bytes after the header block, from the record's actual extent. The
   * body itself is not decoded; this states how many bytes are present.
   */
  body_bytes: z.int().nonnegative(),
  /**
   * True when a `Content-Length` or `Transfer-Encoding` field is present. A
   * framing header describes a body this reader did not decode, and an
   * incomplete or conflicting one is left as written rather than interpreted.
   */
  body_framing_declared: z.boolean(),
});
export type WarcHttpMessage = z.output<typeof warcHttpMessageSchema>;

/**
 * Why a payload that promised an HTTP message has none. `status-line-limit`
 * and `header-block-limit` are reader ceilings, not damage, and are reported so
 * a skipped message is never mistaken for a non-HTTP payload.
 */
export const warcHttpOmissionSchema = z.enum([
  "start-line-limit",
  "header-block-limit",
  "malformed-start-line",
  "unterminated-header-block",
  "archive-header-limit",
]);
export type WarcHttpOmission = z.output<typeof warcHttpOmissionSchema>;

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
  /** The embedded HTTP header block, decoded for `request`/`response` payloads. */
  http: warcHttpMessageSchema.nullable(),
  /**
   * Set only when the payload began an HTTP message that this reader could not
   * represent. `http` is then null, so a skipped message stays distinguishable
   * from a payload that never was an HTTP message.
   */
  http_omitted: warcHttpOmissionSchema.nullable(),
  /** True when the payload began an HTTP start line longer than the reader's ceiling. */
  http_start_line_over_ceiling: z.boolean(),
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
    "http-start-line-limit-reached",
    "http-header-block-limit-reached",
    "http-start-line-invalid",
    "http-header-block-unterminated",
    "archive-header-limit-reached",
    "url-credentials-ambiguous",
    "invalid-version-line",
    "invalid-version-limit-reached",
  ]),
  message: z.string(),
});

export type WarcDiagnostic = z.output<typeof warcDiagnosticSchema>;
export type WarcDiagnosticCode = WarcDiagnostic["code"];

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
    /** Records whose payload began an HTTP message and yielded its header block. */
    http_messages: z.int().nonnegative(),
    /** Records whose payload looked like an HTTP message but was not represented. */
    http_omitted: z.int().nonnegative(),
    malformed_headers: z.int().nonnegative(),
    diagnostics: z.int().nonnegative(),
  }),
  /** What this inventory did and did not examine, stated rather than implied. */
  source_coverage: z.strictObject({
    scope: z.literal("record-headers-and-http-headers"),
    status: z.enum(["complete-within-scope", "partial"]),
    /** Record payload bytes are read only far enough to hold an HTTP header block. */
    payloads: z.literal("header-block-only"),
    http_headers: z.literal("decoded"),
    http_bodies: z.literal("not-decoded"),
    digests: z.literal("not-verified"),
    related_records: z.literal("not-linked"),
    network: z.literal("not-contacted"),
  }),
  limitations: z.array(z.string()),
});
export type WarcArchive = z.output<typeof warcArchiveSchema>;
