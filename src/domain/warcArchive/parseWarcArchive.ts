import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { ok, type Result } from "../result.js";
import {
  WARC_ARCHIVE_HEADER_LINE_BYTES,
  WARC_ARCHIVE_HEADER_BLOCK_BYTES,
  WARC_ARCHIVE_HEADER_FIELDS,
  WARC_ARCHIVE_MAX_DIAGNOSTICS,
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

/** Decode only the embedded response status line; headers and body stay undecoded. */
const readHttpStatus = (payload: Buffer): HttpFacts | null => {
  const line = findLineEnd(payload, 0);
  if (line === null) return null;
  const text = payload.toString("utf8", 0, line.contentEnd);
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/u.exec(text);
  if (match === null) return null;
  const code = Number(match[1]);
  if (!Number.isInteger(code) || code < 100 || code > 599) return null;
  const reason = match[2]?.trim();
  return {
    status_code: code,
    reason_phrase: reason === undefined || reason === "" ? null : reason,
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
    const { block, limit } = readHeaderBlock(data, nextVersion);
    if (block === null) {
      // Name the ceiling when the reader stopped on one: a long but intact
      // header is not archive damage, and reporting it as truncation sends the
      // operator looking for a defect that is not there.
      if (limit === "line")
        diagnostic(
          ordinal,
          "header-line-limit-reached",
          `The record starting at decoded offset ${nextVersion} has a version or header line longer than ${WARC_ARCHIVE_HEADER_LINE_BYTES} bytes; later records were not read.`,
        );
      else if (limit !== null)
        diagnostic(
          ordinal,
          "header-block-limit-reached",
          `The record starting at decoded offset ${nextVersion} exceeds the header ${limit === "block-bytes" ? `byte allowance of ${WARC_ARCHIVE_HEADER_BLOCK_BYTES}` : `retained field and malformed-line allowance of ${WARC_ARCHIVE_HEADER_FIELDS}`}; later records were not read.`,
        );
      else
        diagnostic(
          ordinal,
          "truncated-record",
          `The record starting at decoded offset ${nextVersion} has an incomplete version line or header block.`,
        );
      break;
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
    const step = readOneRecord(data, block, nextVersion, {
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
  return {
    record: buildRecord(data, {
      block,
      offset,
      ordinal,
      payloadBytes,
      payload,
    }),
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
  const http =
    type === "response" && payloadBytes > 0 ? readHttpStatus(payload) : null;
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
