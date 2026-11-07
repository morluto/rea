import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { ok, type Result } from "../result.js";
import {
  WARC_ARCHIVE_HEADER_LINE_BYTES,
  WARC_ARCHIVE_HEADER_BLOCK_BYTES,
  WARC_ARCHIVE_HEADER_FIELDS,
  WARC_ARCHIVE_HTTP_STATUS_LINE_BYTES as HTTP_STATUS_LINE_BYTES,
  WARC_ARCHIVE_MAX_DIAGNOSTICS,
  WARC_ARCHIVE_MAX_INVALID_VERSIONS,
  type WarcArchive,
  type WarcArchiveArtifact,
  type WarcRecord,
} from "./warcArchive.js";

/** Record types this inventory interprets; every other type is still listed. */
const KNOWN_RECORD_TYPES = new Set([
  "warcinfo",
  "request",
  "response",
  "resource",
  "metadata",
  "revisit",
  "conversion",
  "continuation",
]);

/**
 * gzip magic. A WARC file may concatenate independently compressed members;
 * Node decodes the whole member chain in one pass.
 */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

const decodeFailure = (message: string) => ({
  code: "unsupported-compression" as const,
  message,
});

const isGzip = (bytes: Buffer) =>
  bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];

interface HeaderBlock {
  readonly version: string;
  readonly fields: ReadonlyMap<string, string>;
  /**
   * Fields WARC permits to repeat are accepted and the first occurrence is
   * kept above. Their further values are not collected: nothing read them, and
   * copying every value on each repeat made a header block with many
   * `WARC-Protocol` lines cost quadratic time in array entries, which neither
   * the per-line ceiling nor `max_records` bounds.
   */
  readonly malformed: readonly string[];
  readonly bytes: number;
}

/**
 * Fields WARC allows to appear more than once in one header block. Repeating
 * any other field is a defect worth reporting; treating these as defects too
 * turned valid archives into `partial` ones.
 */
const REPEATABLE_FIELDS = new Set([
  "warc-concurrent-to",
  "warc-protocol",
  "warc-refers-to",
  "warc-refers-to-target-uri",
  "warc-refers-to-date",
]);

/** RFC 2616 token: the only shape WARC allows for a field name. */
const FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

/**
 * A version line is `WARC/` followed by a decimal `major.minor`. Accepting any
 * line that merely began with `WARC/` turned `WARC/not-a-version` into a record
 * with no diagnostic, and its declared Content-Length then swallowed later real
 * records. Deliberately not anchored with `$`: WARC 1.0 allows a trailing
 * comment after the version, which this parser does not interpret, and before
 * any such comment was tolerated this only rejected lines with no version.
 */
const WARC_VERSION_LINE = /^WARC\/[0-9]+\.[0-9]+(?:[ \t]|$)/;

const findLineEnd = (data: Buffer, from: number) => {
  const lf = data.indexOf(0x0a, from);
  if (lf === -1) return null;
  return {
    contentEnd: lf > from && data[lf - 1] === 0x0d ? lf - 1 : lf,
    end: lf + 1,
  };
};

interface HeaderBlockResult {
  readonly block: HeaderBlock | null;
  /** Resource allowance reached while reading this header, if any. */
  readonly limit: "line" | "block-bytes" | "block-fields" | null;
  /** The line began `WARC/` but carries no parseable version. */
  readonly invalidVersion?: number;
}

/**
 * Read the version line plus header fields up to the blank line. A header that
 * ends without a blank line returns null so the caller can report a truncated
 * record rather than inventing fields.
 */
const readHeaderBlock = (data: Buffer, start: number): HeaderBlockResult => {
  const versionLine = findLineEnd(data, start);
  if (versionLine === null) return { block: null, limit: null };
  // A version line past the allowance is a reader ceiling, not damage: the
  // caller names the ceiling so nobody hunts for a bad archive that is intact.
  if (versionLine.contentEnd - start > WARC_ARCHIVE_HEADER_LINE_BYTES)
    return { block: null, limit: "line" };
  const version = data.toString("utf8", start, versionLine.contentEnd);
  if (!version.startsWith("WARC/")) return { block: null, limit: null };
  if (!WARC_VERSION_LINE.test(version))
    return { block: null, limit: null, invalidVersion: versionLine.end };
  const fields = new Map<string, string>();
  const malformed: string[] = [];
  let cursor = versionLine.end;
  for (;;) {
    if (cursor >= data.length) return { block: null, limit: null };
    const line = findLineEnd(data, cursor);
    if (line === null) return { block: null, limit: null };
    if (line.contentEnd - cursor > WARC_ARCHIVE_HEADER_LINE_BYTES)
      return { block: null, limit: "line" };
    if (line.end - start > WARC_ARCHIVE_HEADER_BLOCK_BYTES)
      return { block: null, limit: "block-bytes" };
    if (line.contentEnd === cursor) {
      return {
        block: {
          version: version.slice(5),
          fields,
          malformed,
          bytes: line.end - start,
        },
        limit: null,
      };
    }
    const text = data.toString("utf8", cursor, line.contentEnd);
    const colon = text.indexOf(":");
    const name = colon > 0 ? text.slice(0, colon).trim().toLowerCase() : "";
    // A colon was the only check before, so "Bad Name: value" passed and the
    // field was dropped without a diagnostic. Spaces are not allowed in a
    // WARC field name, and an unreported drop is a silent loss.
    const invalid = colon <= 0 || !FIELD_NAME.test(name);
    const first = invalid ? undefined : fields.get(name);
    const malformedLine =
      invalid || (first !== undefined && !REPEATABLE_FIELDS.has(name));
    if (malformedLine || first === undefined) {
      if (fields.size + malformed.length >= WARC_ARCHIVE_HEADER_FIELDS)
        return { block: null, limit: "block-fields" };
      if (malformedLine) malformed.push(text);
      else fields.set(name, text.slice(colon + 1).trim());
    }
    cursor = line.end;
  }
};

interface HttpFacts {
  readonly status_code: number;
  readonly reason_phrase: string | null;
  readonly header_bytes: number;
}

const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;
const isSpace = (byte: number) => byte === 0x20 || byte === 0x09;

/**
 * Decode only the embedded response status line; headers and body stay undecoded.
 *
 * Read positionally rather than with `/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/`:
 * that expression let `\s+` and `(.*)` backtrack over the same spaces, so a
 * status line with a long run of blanks and an invalid reason phrase cost
 * quadratic time — 32,000 spaces took 1.43 s synchronously, blocking the MCP
 * server and cancellation. Every step here advances the cursor.
 */
/** Read `HTTP/` and a decimal major, optional `.minor`. */
const readHttpVersion = (payload: Buffer, limit: number): number | null => {
  const prefix = payload.toString("latin1", 0, Math.min(5, limit));
  if (prefix !== "HTTP/") return null;
  let cursor = 5;
  const skipDigits = () => {
    const from = cursor;
    while (cursor < limit && isDigit(payload[cursor] ?? -1)) cursor += 1;
    return cursor - from;
  };
  if (skipDigits() === 0) return null;
  if (cursor < limit && payload[cursor] === 0x2e) {
    cursor += 1;
    if (skipDigits() === 0) return null;
  }
  return cursor;
};

/** Skip mandatory spaces, then read exactly three digits within 100–599. */
const readHttpStatusCode = (
  payload: Buffer,
  from: number,
  limit: number,
): { code: number; cursor: number } | null => {
  let cursor = from;
  const spacesFrom = cursor;
  while (cursor < limit && isSpace(payload[cursor] ?? -1)) cursor += 1;
  if (cursor === spacesFrom) return null;
  let code = 0;
  for (let index = 0; index < 3; index += 1) {
    const byte = payload[cursor + index] ?? -1;
    if (!isDigit(byte)) return null;
    code = code * 10 + byte - 0x30;
  }
  if (code < 100 || code > 599) return null;
  cursor += 3;
  if (cursor < limit && !isSpace(payload[cursor] ?? -1)) return null;
  return { code, cursor };
};

/** A payload that begins `HTTP/` and so promises a status line. */
const HTTP_PREFIX_BYTES = Buffer.from("HTTP/", "latin1");
const startsLikeHttpStatusLine = (payload: Buffer): boolean =>
  payload.length >= HTTP_PREFIX_BYTES.length &&
  payload.subarray(0, HTTP_PREFIX_BYTES.length).equals(HTTP_PREFIX_BYTES);

const readHttpStatus = (payload: Buffer): HttpFacts | null => {
  const line = findLineEnd(payload, 0);
  if (line === null) return null;
  if (line.contentEnd > HTTP_STATUS_LINE_BYTES) return null;
  const limit = line.contentEnd;
  const afterVersion = readHttpVersion(payload, limit);
  if (afterVersion === null) return null;
  const status = readHttpStatusCode(payload, afterVersion, limit);
  if (status === null) return null;
  let reasonFrom = status.cursor;
  let reasonEnd = limit;
  while (reasonFrom < reasonEnd && isSpace(payload[reasonFrom] ?? -1))
    reasonFrom += 1;
  while (reasonEnd > reasonFrom && isSpace(payload[reasonEnd - 1] ?? -1))
    reasonEnd -= 1;
  // `findLineEnd` strips one trailing CR, so any CR left in the content is a
  // bare one that ended the line early; the reader used to keep it inside the
  // reason phrase and hand out facts for a line that is not well formed.
  for (let index = reasonFrom; index < reasonEnd; index += 1)
    if (payload[index] === 0x0d) return null;
  return {
    status_code: status.code,
    reason_phrase:
      reasonEnd > reasonFrom
        ? payload.toString("utf8", reasonFrom, reasonEnd)
        : null,
    header_bytes: line.end,
  };
};

const parseNonNegativeInt = (value: string | undefined) => {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const digestOf = (prefix: string, ...parts: readonly (string | number)[]) => {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(part));
    hash.update("\u0000");
  }
  return `${prefix}_${hash.digest("hex")}`;
};

const skipRecordSeparator = (data: Buffer, from: number): number => {
  let cursor = from;
  while (cursor < data.length) {
    const byte = data[cursor];
    if (byte !== 0x0d && byte !== 0x0a) break;
    cursor += 1;
  }
  return cursor;
};

interface ParsedStream {
  readonly records: WarcRecord[];
  readonly diagnostics: WarcArchive["diagnostics"];
  readonly stoppedAtLimit: boolean;
}

type DiagnosticSink = (
  ordinal: number | null,
  code: WarcArchive["diagnostics"][number]["code"],
  message: string,
) => void;

/**
 * Rejected version lines never produce a record, so `max_records` cannot stop
 * them; this is the ceiling that does, and it is named when it fires.
 */
const versionLineAllowanceSpent = (
  rejected: number,
  ordinal: number,
  diagnostic: DiagnosticSink,
): boolean => {
  if (rejected < WARC_ARCHIVE_MAX_INVALID_VERSIONS) return false;
  diagnostic(
    ordinal,
    "invalid-version-limit-reached",
    `Inventory stopped after ${WARC_ARCHIVE_MAX_INVALID_VERSIONS} version lines that carry no parseable version; later records were not read.`,
  );
  return true;
};

/**
 * Report why a header block could not be read. Returns how to resume: null
 * ends the scan, a number is the offset scanning continues from.
 */
const resumeAfterUnreadableHeader = (
  result: HeaderBlockResult,
  offset: number,
  ordinal: number,
  diagnostic: DiagnosticSink,
): number | null => {
  // A `WARC/` line with no version is damage in one place, not a reason to
  // stop: its own Content-Length was never trusted, so resume after that line
  // and the genuine records following it are still read.
  if (result.invalidVersion !== undefined) {
    diagnostic(
      ordinal,
      "invalid-version-line",
      `The line at decoded offset ${offset} starts a WARC record but carries no WARC version; scanning resumed after it.`,
    );
    return result.invalidVersion;
  }
  // Name the ceiling when the reader stopped on one: a long but intact header
  // is not archive damage, and reporting it as truncation sends the operator
  // looking for a defect that is not there.
  if (result.limit === "line")
    diagnostic(
      ordinal,
      "header-line-limit-reached",
      `The record starting at decoded offset ${offset} has a version or header line longer than ${WARC_ARCHIVE_HEADER_LINE_BYTES} bytes; later records were not read.`,
    );
  else if (result.limit !== null)
    diagnostic(
      ordinal,
      "header-block-limit-reached",
      `The record starting at decoded offset ${offset} exceeds the header ${result.limit === "block-bytes" ? `byte allowance of ${WARC_ARCHIVE_HEADER_BLOCK_BYTES}` : `retained field and malformed-line allowance of ${WARC_ARCHIVE_HEADER_FIELDS}`}; later records were not read.`,
    );
  else
    diagnostic(
      ordinal,
      "truncated-record",
      `The record starting at decoded offset ${offset} has an incomplete version line or header block.`,
    );
  return null;
};

const parseDecodedStream = (data: Buffer, maxRecords: number): ParsedStream => {
  const records: WarcRecord[] = [];
  const diagnostics: WarcArchive["diagnostics"] = [];
  let stoppedAtLimit = false;
  const diagnostic: DiagnosticSink = (ordinal, code, message) => {
    // One record can carry millions of short malformed header lines; each used
    // to allocate its own diagnostic, which `max_records` does not bound and
    // which grows the reply past every advertised allowance. Past the ceiling
    // the remaining lines are summarised once instead.
    if (diagnostics.length >= WARC_ARCHIVE_MAX_DIAGNOSTICS) {
      if (diagnostics.length === WARC_ARCHIVE_MAX_DIAGNOSTICS)
        diagnostics.push({
          diagnostic_id: digestOf(
            "warc_diagnostic",
            "archive",
            "diagnostic-limit-reached",
            `Stopped at ${WARC_ARCHIVE_MAX_DIAGNOSTICS} diagnostics.`,
          ),
          ordinal: null,
          code: "diagnostic-limit-reached",
          message: `Stopped recording diagnostics at ${WARC_ARCHIVE_MAX_DIAGNOSTICS}; further findings in this archive are not listed.`,
        });
      return;
    }
    diagnostics.push({
      diagnostic_id: digestOf(
        "warc_diagnostic",
        ordinal ?? "archive",
        code,
        message,
      ),
      ordinal,
      code,
      message,
    });
  };

  if (!data.subarray(0, 5).toString("latin1").startsWith("WARC/")) {
    diagnostic(
      null,
      "not-a-warc-stream",
      "The file does not begin a WARC record.",
    );
    return { records, diagnostics, stoppedAtLimit };
  }

  let cursor = 0;
  let ordinal = 0;
  let rejectedVersions = 0;
  while (cursor < data.length) {
    // Records are separated by CRLF pairs or blank padding. Skip the separator
    // before searching: from a separator the next `WARC/` prefix also matches
    // this record's own `WARC-Type` line, which invented a second record at the
    // wrong offset and reported the record's own separator as stray bytes.
    const searchFrom = skipRecordSeparator(data, cursor);
    const nextVersion = data.indexOf("WARC/", searchFrom, "latin1");
    if (nextVersion === -1) {
      if (searchFrom < data.length)
        diagnostic(
          ordinal === 0 ? null : ordinal - 1,
          "trailing-bytes",
          `${data.length - searchFrom} byte(s) after the last record are not a WARC record.`,
        );
      break;
    }
    if (nextVersion !== searchFrom)
      diagnostic(
        ordinal === 0 ? null : ordinal - 1,
        "trailing-bytes",
        `${nextVersion - searchFrom} unexpected byte(s) between records.`,
      );
    const header = readHeaderBlock(data, nextVersion);
    if (header.block === null) {
      const resume = resumeAfterUnreadableHeader(
        header,
        nextVersion,
        ordinal,
        diagnostic,
      );
      if (resume === null) break;
      cursor = resume;
      ordinal += 1;
      rejectedVersions += 1;
      if (versionLineAllowanceSpent(rejectedVersions, ordinal, diagnostic)) {
        break;
      }
      continue;
    }
    if (records.length >= maxRecords) {
      stoppedAtLimit = true;
      diagnostic(
        ordinal,
        "record-limit-reached",
        `Inventory stopped at max_records=${maxRecords}; later records were not read.`,
      );
      break;
    }
    const step = readOneRecord(data, header.block, nextVersion, {
      ordinal,
      diagnostic,
    });
    records.push(step.record);
    if (step.nextCursor === null) break;
    cursor = step.nextCursor;
    ordinal += 1;
  }
  return { records, diagnostics, stoppedAtLimit };
};

interface RecordStep {
  readonly record: WarcRecord;
  /** Null ends the scan because the payload extent is unknown or incomplete. */
  readonly nextCursor: number | null;
}

/** Read exactly one record's headers and payload extent, reporting what it cannot read. */
const readOneRecord = (
  data: Buffer,
  block: HeaderBlock,
  offset: number,
  context: { readonly ordinal: number; readonly diagnostic: DiagnosticSink },
): RecordStep => {
  const { ordinal, diagnostic } = context;
  for (const line of block.malformed)
    diagnostic(
      ordinal,
      "invalid-header-line",
      `The record header line "${line}" is not a single well-formed field.`,
    );
  const declared = block.fields.get("content-length");
  const declaredLength = parseNonNegativeInt(declared);
  if (declaredLength === null) {
    diagnostic(
      ordinal,
      "invalid-content-length",
      declared === undefined
        ? "The record has no Content-Length header."
        : `Content-Length "${declared}" is not a non-negative integer.`,
    );
    // The payload extent is unknown; stop rather than guess where the next record starts.
    return {
      record: buildRecord(data, {
        block,
        offset,
        ordinal,
        payloadBytes: 0,
        payload: Buffer.alloc(0),
      }),
      nextCursor: null,
    };
  }
  const payloadStart = offset + block.bytes;
  const available = data.length - payloadStart;
  const payloadBytes = Math.min(declaredLength, Math.max(available, 0));
  const payload = data.subarray(payloadStart, payloadStart + payloadBytes);
  if (payloadBytes < declaredLength)
    diagnostic(
      ordinal,
      "truncated-record",
      `Content-Length declares ${declaredLength} bytes but only ${payloadBytes} are present.`,
    );
  const record = buildRecord(data, {
    block,
    offset,
    ordinal,
    payloadBytes,
    payload,
  });
  // Only a status line that began like HTTP and exceeded the ceiling lost
  // facts; an ordinary body reads as `http: null` without a diagnostic.
  if (record.http_status_line_over_ceiling)
    diagnostic(
      ordinal,
      "http-status-line-limit-reached",
      `The response payload at decoded offset ${offset} begins an HTTP status line longer than ${HTTP_STATUS_LINE_BYTES} bytes; its status code and reason phrase were not read.`,
    );
  return {
    record,
    nextCursor:
      payloadBytes < declaredLength ? null : payloadStart + payloadBytes,
  };
};

const buildRecord = (
  data: Buffer,
  input: {
    readonly block: HeaderBlock;
    readonly offset: number;
    readonly ordinal: number;
    readonly payloadBytes: number;
    readonly payload: Buffer;
  },
): WarcRecord => {
  const { block, offset, ordinal, payloadBytes, payload } = input;
  const type = block.fields.get("warc-type") ?? "";
  const version = block.version;
  const contentLength = parseNonNegativeInt(block.fields.get("content-length"));
  const isResponse = type === "response" && payloadBytes > 0;
  const http = isResponse ? readHttpStatus(payload) : null;
  // `http: null` alone cannot tell a non-HTTP payload from a status line the
  // reader skipped at its ceiling; only the latter lost facts, and only it is
  // reported, so an ordinary body does not carry a diagnostic per record.
  const statusLineOverCeiling =
    isResponse &&
    http === null &&
    startsLikeHttpStatusLine(payload) &&
    (findLineEnd(payload, 0)?.contentEnd ?? 0) > HTTP_STATUS_LINE_BYTES;
  return {
    record_id: digestOf(
      "warc_record",
      offset,
      ordinal,
      type,
      block.fields.get("warc-record-id") ?? "",
    ),
    ordinal,
    offset,
    record_type: type,
    record_type_known: KNOWN_RECORD_TYPES.has(type),
    warc_version: `WARC/${version}`,
    warc_date: block.fields.get("warc-date") ?? null,
    warc_record_id: block.fields.get("warc-record-id") ?? null,
    target_uri: block.fields.get("warc-target-uri") ?? null,
    content_type: block.fields.get("content-type") ?? null,
    content_length: contentLength,
    payload_bytes: payloadBytes,
    block_digest: block.fields.get("warc-block-digest") ?? null,
    payload_digest: block.fields.get("warc-payload-digest") ?? null,
    ip_address: block.fields.get("warc-ip-address") ?? null,
    profile: block.fields.get("warc-profile") ?? null,
    segment_number: parseNonNegativeInt(
      block.fields.get("warc-segment-number"),
    ),
    http,
    http_status_line_over_ceiling: statusLineOverCeiling,
    malformed_header_lines: [...block.malformed],
  };
};

/** Decode the archive bytes once; gzip magic is the only supported compression. */
const decompress = (
  bytes: Buffer,
  maxDecodedBytes: number,
): Result<
  { decoded: Buffer; compression: "identity" | "gzip" },
  {
    code: "unsupported-compression" | "decoded-size-limit-reached";
    message: string;
  }
> => {
  if (!isGzip(bytes)) {
    // The allowance used to be enforced only on the gunzip path, so an
    // uncompressed archive larger than `max_decoded_bytes` was scanned in full
    // and could report complete coverage above the caller's own ceiling.
    if (bytes.length > maxDecodedBytes)
      return {
        ok: false,
        error: {
          code: "decoded-size-limit-reached",
          message: `The archive is ${bytes.length} byte(s), above max_decoded_bytes=${maxDecodedBytes}.`,
        },
      };
    return ok({ decoded: bytes, compression: "identity" });
  }
  // Identity input that merely starts with the gzip magic is not a WARC stream;
  // gunzip then reports it, and that stays an explicit compression failure.
  try {
    return ok({
      decoded: gunzipSync(bytes, { maxOutputLength: maxDecodedBytes }),
      compression: "gzip",
    });
  } catch (cause: unknown) {
    const failure = cause as { code?: string };
    if (failure.code === "ERR_BUFFER_TOO_LARGE")
      return {
        ok: false,
        error: {
          code: "decoded-size-limit-reached",
          message: `Decompressing the archive exceeds max_decoded_bytes=${maxDecodedBytes}.`,
        },
      };
    return {
      ok: false,
      error: decodeFailure(
        `The gzip stream could not be decoded${cause instanceof Error ? `: ${cause.message}` : "."}`,
      ),
    };
  }
};

const limitationsFor = (
  compression: string,
  status: "complete-within-scope" | "partial",
) => {
  const limitations = [
    "Only record headers are read; record payloads, embedded HTTP headers beyond the response status line, and HTTP bodies are not decoded.",
    "Declared digests are reported as written and are not verified against payload bytes.",
    "Records are not linked to each other by WARC-Record-ID or payload digest.",
    "No target URI is fetched and no archived script, link or resource is executed.",
  ];
  if (compression === "gzip")
    limitations.push(
      "The decompressed stream is inventoried in memory; records past max_decoded_bytes are not read.",
    );
  if (status === "partial")
    limitations.push(
      "The inventory is partial: a limit or a malformed record ended the scan before the stream was exhausted.",
    );
  return limitations;
};

export interface WarcArchiveParseOptions {
  readonly maxRecords: number;
  readonly maxDecodedBytes: number;
}

/** Inventory one WARC stream from bytes this caller already verified. */
export const parseWarcArchive = (
  bytes: Buffer,
  artifact: WarcArchiveArtifact,
  options: WarcArchiveParseOptions,
): Result<WarcArchive, never> => {
  const decoded = decompress(bytes, options.maxDecodedBytes);
  if (!decoded.ok) {
    return ok({
      archive_id: digestOf("warc_archive", artifact.sha256, artifact.bytes),
      format: "warc",
      artifact,
      compression: "unsupported",
      decoded_bytes: 0,
      records: [],
      diagnostics: [
        {
          diagnostic_id: digestOf(
            "warc_diagnostic",
            "archive",
            decoded.error.code,
            decoded.error.message,
          ),
          ordinal: null,
          code: decoded.error.code,
          message: decoded.error.message,
        },
      ],
      summary: {
        records: 0,
        known_types: 0,
        unknown_types: 0,
        responses: 0,
        requests: 0,
        revisits: 0,
        malformed_headers: 0,
        diagnostics: 1,
      },
      source_coverage: {
        scope: "record-headers",
        status: "partial",
        payloads: "not-decoded",
        http_bodies: "not-decoded",
        digests: "not-verified",
        related_records: "not-linked",
        network: "not-contacted",
      },
      limitations: limitationsFor("unsupported", "partial"),
    });
  }
  const stream = parseDecodedStream(decoded.value.decoded, options.maxRecords);
  const malformedHeaders = stream.records.reduce(
    (total, record) => total + record.malformed_header_lines.length,
    0,
  );
  const status: "complete-within-scope" | "partial" =
    stream.diagnostics.length === 0 && !stream.stoppedAtLimit
      ? "complete-within-scope"
      : "partial";
  return ok({
    archive_id: digestOf("warc_archive", artifact.sha256, artifact.bytes),
    format: "warc",
    artifact,
    compression: decoded.value.compression,
    decoded_bytes: decoded.value.decoded.length,
    records: stream.records,
    diagnostics: stream.diagnostics,
    summary: {
      records: stream.records.length,
      known_types: stream.records.filter((record) => record.record_type_known)
        .length,
      unknown_types: stream.records.filter(
        (record) => !record.record_type_known,
      ).length,
      responses: stream.records.filter(
        (record) => record.record_type === "response",
      ).length,
      requests: stream.records.filter(
        (record) => record.record_type === "request",
      ).length,
      revisits: stream.records.filter(
        (record) => record.record_type === "revisit",
      ).length,
      malformed_headers: malformedHeaders,
      diagnostics: stream.diagnostics.length,
    },
    source_coverage: {
      scope: "record-headers",
      status,
      payloads: "not-decoded",
      http_bodies: "not-decoded",
      digests: "not-verified",
      related_records: "not-linked",
      network: "not-contacted",
    },
    limitations: limitationsFor(decoded.value.compression, status),
  });
};
