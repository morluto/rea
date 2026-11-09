import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { ok, type Result } from "../result.js";
import {
  parseRecordedHttpRequestTarget,
  parseRecordedTransportUrl,
} from "../recordedTransportUrl.js";
import {
  WARC_ARCHIVE_HEADER_LINE_BYTES,
  WARC_ARCHIVE_HEADER_BLOCK_BYTES,
  WARC_ARCHIVE_HEADER_FIELDS,
  WARC_ARCHIVE_HTTP_HEADER_BLOCK_BYTES as HTTP_HEADER_BLOCK_BYTES,
  WARC_ARCHIVE_HTTP_HEADER_FIELDS as HTTP_HEADER_FIELDS,
  WARC_ARCHIVE_HTTP_START_LINE_BYTES as HTTP_START_LINE_BYTES,
  WARC_ARCHIVE_MAX_HEADER_ENTRIES,
  WARC_ARCHIVE_MAX_DIAGNOSTICS,
  WARC_ARCHIVE_MAX_INVALID_VERSIONS,
  type WarcArchive,
  type WarcArchiveArtifact,
  type WarcDiagnosticCode,
  type WarcHttpHeader,
  type WarcHttpMessage,
  type WarcHttpOmission,
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
const SENSITIVE_HTTP_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "authentication-info",
  "proxy-authentication-info",
  "cookie",
  "cookie2",
  "set-cookie",
  "set-cookie2",
]);
const HTTP_URL_HEADERS = new Set([
  "location",
  "content-location",
  "referer",
  "origin",
]);
const AMBIGUOUS_URL = "[redacted: ambiguous URL credentials]";
interface RedactionState {
  ambiguousUrl: boolean;
}

/** Preserve the selected URL spelling while withholding explicit authority credentials. */
const withoutUrlUserInfo = (
  value: string,
  redaction: RedactionState,
  role: "url" | "request-target" = "url",
): string => {
  const { credentials } =
    role === "request-target"
      ? parseRecordedHttpRequestTarget(value)
      : parseRecordedTransportUrl(value);
  if (credentials === "ambiguous") {
    redaction.ambiguousUrl = true;
    return AMBIGUOUS_URL;
  }
  if (
    credentials === null ||
    ["", ":"].includes(value.slice(credentials.start, credentials.end - 1))
  )
    return value;
  return `${value.slice(0, credentials.start)}[redacted]@${value.slice(credentials.end)}`;
};

/**
 * Trim leading and trailing SP/HTAB from a header value. `/[ \t]+$/u` retries
 * at every position of a value that is mostly spaces, which is quadratic in a
 * value the line, block, and archive allowances all admit; scanning the end
 * once is the same result in linear time.
 */
/**
 * A field value may not carry a control byte. NUL, CR and LF are the ones that
 * make a stored header look like a different header or a second line, and a
 * value holding one is reported as malformed rather than as an ordinary field,
 * so the header inventory never claims complete coverage for a line that
 * cannot be trusted as written.
 */
const HTTP_FORBIDDEN_VALUE_BYTES = /[\u0000\u000d\u000a]/u;

const trimHttpSpaces = (text: string, start: number): string => {
  let first = start;
  let last = text.length;
  while (first < last && (text[first] === " " || text[first] === "\t")) first++;
  while (last > first && (text[last - 1] === " " || text[last - 1] === "\t"))
    last--;
  return text.slice(first, last);
};

const sanitizedMalformedHeader = (
  text: string,
  previousSensitive: boolean,
  redaction: RedactionState,
): string => {
  const colon = text.indexOf(":");
  const name = colon > 0 ? text.slice(0, colon) : "";
  if (SENSITIVE_HTTP_HEADERS.has(name.trim().toLowerCase()))
    return `${name}: [redacted]`;
  if (
    name.trim().toLowerCase() === "warc-target-uri" ||
    HTTP_URL_HEADERS.has(name.trim().toLowerCase())
  ) {
    const value = text.slice(colon + 1);
    const start = value.search(/[^ \t]/u);
    if (start >= 0)
      return `${name}:${value.slice(0, start)}${withoutUrlUserInfo(value.slice(start), redaction)}`;
  }
  if (/^[ \t]/u.test(text) && previousSensitive)
    return "[redacted continuation]";
  return text;
};

/** A URL field and its folded lines, retained separately but interpreted together. */
class FoldedUrl {
  readonly #parts: {
    readonly text: string;
    readonly assign: (value: string) => void;
  }[] = [];
  constructor(readonly redaction: RedactionState) {}

  add(text: string, assign: (value: string) => void): void {
    this.#parts.push({ text, assign });
  }

  finish(): void {
    const pieces = this.#parts.map(({ text }, index) => {
      const indent =
        index === 0 ? 0 : (text.match(/^[ \t]*/u)?.[0].length ?? 0);
      return { text, indent, value: text.slice(indent) };
    });
    const joined = pieces.map(({ value }) => value).join("");
    const { credentials } = parseRecordedTransportUrl(joined);
    if (credentials === "ambiguous") {
      this.redaction.ambiguousUrl = true;
      this.#parts.forEach(({ assign }, index) =>
        assign(index === 0 ? AMBIGUOUS_URL : "[redacted continuation]"),
      );
      return;
    }
    if (
      credentials === null ||
      ["", ":"].includes(joined.slice(credentials.start, credentials.end - 1))
    ) {
      // A malformed combined value is not proof that credentials are absent.
      // Preserve redaction already established for the first complete piece;
      // if a split authority remains undecidable, withhold it as ambiguous.
      if (URL.parse(joined, "https://rea.invalid") === null) {
        const first = pieces[0];
        const safe =
          first === undefined
            ? ""
            : withoutUrlUserInfo(first.value, this.redaction);
        if (first !== undefined && safe !== first.value) {
          this.#parts.forEach(({ text, assign }, index) =>
            assign(
              index === 0 ? first.text.slice(0, first.indent) + safe : text,
            ),
          );
          return;
        }
      }
      this.#parts.forEach(({ text, assign }) => assign(text));
      return;
    }
    let offset = 0;
    this.#parts.forEach(({ assign }, index) => {
      const piece = pieces[index]!;
      const end = offset + piece.value.length;
      const startCut = Math.max(credentials.start, offset);
      const endCut = Math.min(credentials.end, end);
      if (startCut >= endCut) assign(piece.text);
      else {
        const before = piece.value.slice(0, startCut - offset);
        const after = piece.value.slice(endCut - offset);
        const marker =
          credentials.start >= offset && credentials.start < end
            ? "[redacted]"
            : "";
        const at =
          credentials.end > offset && credentials.end <= end ? "@" : "";
        assign(
          piece.text.slice(0, piece.indent) + before + marker + at + after,
        );
      }
      offset = end;
    });
  }
}

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
  readonly limit:
    | "line"
    | "block-bytes"
    | "block-fields"
    | "archive-fields"
    | null;
  /** The line began `WARC/` but carries no parseable version. */
  readonly invalidVersion?: number;
}

/**
 * Read the version line plus header fields up to the blank line. A header that
 * ends without a blank line returns null so the caller can report a truncated
 * record rather than inventing fields.
 */
interface HeaderBudget {
  remaining: number;
}
const readHeaderBlock = (
  data: Buffer,
  start: number,
  budget: HeaderBudget,
  redaction: RedactionState,
): HeaderBlockResult => {
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
  let previousSensitive = false;
  let foldedUrl: FoldedUrl | undefined;
  for (;;) {
    if (cursor >= data.length) return { block: null, limit: null };
    const line = findLineEnd(data, cursor);
    if (line === null) return { block: null, limit: null };
    if (line.contentEnd - cursor > WARC_ARCHIVE_HEADER_LINE_BYTES)
      return { block: null, limit: "line" };
    if (line.end - start > WARC_ARCHIVE_HEADER_BLOCK_BYTES)
      return { block: null, limit: "block-bytes" };
    if (line.contentEnd === cursor) {
      foldedUrl?.finish();
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
    const continuation = /^[ \t]/u.test(text);
    const invalid = continuation || colon <= 0 || !FIELD_NAME.test(name);
    const first = invalid ? undefined : fields.get(name);
    const malformedLine =
      invalid || (first !== undefined && !REPEATABLE_FIELDS.has(name));
    if (!continuation) {
      foldedUrl?.finish();
      foldedUrl =
        name === "warc-target-uri" || HTTP_URL_HEADERS.has(name)
          ? new FoldedUrl(redaction)
          : undefined;
    }
    if (malformedLine || first === undefined) {
      if (fields.size + malformed.length >= WARC_ARCHIVE_HEADER_FIELDS)
        return { block: null, limit: "block-fields" };
      if (malformedLine && malformed.length >= budget.remaining)
        return { block: null, limit: "archive-fields" };
      if (malformedLine) {
        const index = malformed.length;
        malformed.push(
          sanitizedMalformedHeader(text, previousSensitive, redaction),
        );
        if (foldedUrl !== undefined) {
          const prefix = continuation ? "" : text.slice(0, colon + 1);
          const value = continuation ? text : text.slice(colon + 1);
          const sensitiveBefore = previousSensitive;
          foldedUrl.add(value, (safe) => {
            malformed[index] = sanitizedMalformedHeader(
              prefix + safe,
              sensitiveBefore,
              redaction,
            );
          });
        }
      } else {
        const value = text.slice(colon + 1).trim();
        fields.set(name, value);
        foldedUrl?.add(value, (safe) => {
          fields.set(name, safe);
        });
      }
    }
    if (!/^[ \t]/u.test(text)) {
      previousSensitive = SENSITIVE_HTTP_HEADERS.has(name);
    }
    cursor = line.end;
  }
};

/** RFC 9110 token characters plus the obsolete separators WARC-era captures wrote. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Read `HTTP/` and a decimal major, optional `.minor`, ending at `limit`.
 *
 * Read positionally rather than with `/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/`:
 * that expression let `\s+` and `(.*)` backtrack over the same spaces, so a
 * start line with a long run of blanks cost quadratic time — 32,000 spaces took
 * 1.43 s synchronously, blocking the MCP server and cancellation. Every step
 * here advances the cursor.
 */
const readHttpVersion = (
  line: string,
  from: number,
): { version: string; cursor: number } | null => {
  if (line.slice(from, from + 5) !== "HTTP/") return null;
  let cursor = from + 5;
  const digitsFrom = cursor;
  while (cursor < line.length && isDigitChar(line[cursor] ?? "")) cursor += 1;
  if (cursor === digitsFrom) return null;
  if (cursor < line.length && line[cursor] === ".") {
    cursor += 1;
    const minorFrom = cursor;
    while (cursor < line.length && isDigitChar(line[cursor] ?? "")) cursor += 1;
    if (cursor === minorFrom) return null;
  }
  return { version: line.slice(from + 5, cursor), cursor };
};

const isDigitChar = (character: string) => character >= "0" && character <= "9";

/** Skip mandatory whitespace, then read a status code and optional reason phrase. */
const readHttpStatusLine = (
  line: string,
): Pick<
  WarcHttpMessage,
  "version" | "status_code" | "reason_phrase"
> | null => {
  const version = readHttpVersion(line, 0);
  if (version === null) return null;
  let cursor = version.cursor;
  const spacesFrom = cursor;
  while (
    cursor < line.length &&
    (line[cursor] === " " || line[cursor] === "\t")
  )
    cursor += 1;
  if (cursor === spacesFrom) return null;
  // RFC 9110 fixed the code at three digits; a capture that wrote fewer is not
  // a status line this reader should reinterpret as one.
  const codeText = line.slice(cursor, cursor + 3);
  if (!/^[0-9]{3}$/.test(codeText)) return null;
  const statusCode = Number(codeText);
  if (statusCode < 100 || statusCode > 599) return null;
  cursor += 3;
  if (cursor < line.length && line[cursor] !== " " && line[cursor] !== "\t")
    return null;
  // Trim the separator runs without a backtracking expression for the same
  // reason the version reader is positional.
  let reasonFrom = cursor;
  while (
    reasonFrom < line.length &&
    (line[reasonFrom] === " " || line[reasonFrom] === "\t")
  )
    reasonFrom += 1;
  let reasonEnd = line.length;
  while (
    reasonEnd > reasonFrom &&
    (line[reasonEnd - 1] === " " || line[reasonEnd - 1] === "\t")
  )
    reasonEnd -= 1;
  const reasonPhrase =
    reasonEnd > reasonFrom ? line.slice(reasonFrom, reasonEnd) : null;
  // `findLineEnd` strips only the CR of a CRLF, so a CR left inside the line is
  // a bare one that ended the line early; a capture with one is not a status
  // line this reader should hand out facts for.
  if (reasonPhrase !== null && reasonPhrase.includes("\r")) return null;
  return {
    version: version.version,
    status_code: statusCode,
    reason_phrase: reasonPhrase,
  };
};

/** Read a request line: method, request target, and version. */
const readHttpRequestLine = (
  line: string,
): Pick<WarcHttpMessage, "version" | "method" | "request_target"> | null => {
  const firstSpace = line.indexOf(" ");
  if (firstSpace <= 0) return null;
  const method = line.slice(0, firstSpace);
  if (!TOKEN.test(method)) return null;
  let targetFrom = firstSpace;
  while (targetFrom < line.length && line[targetFrom] === " ") targetFrom += 1;
  const targetEnd = line.indexOf(" ", targetFrom);
  if (targetEnd === -1) return null;
  const requestTarget = line.slice(targetFrom, targetEnd);
  if (requestTarget.length === 0) return null;
  let versionFrom = targetEnd;
  while (versionFrom < line.length && line[versionFrom] === " ")
    versionFrom += 1;
  const version = readHttpVersion(line, versionFrom);
  if (version === null || version.cursor !== line.length) return null;
  for (const character of requestTarget) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return null;
  }
  return {
    version: version.version,
    method,
    request_target: requestTarget,
  };
};

/**
 * A payload that begins `HTTP/` or an apparent method token and so promises a
 * message. The window is the whole start-line allowance, not a fixed prefix: a
 * request method is any HTTP token, so cutting the check short would drop a
 * valid long extension method without a diagnostic.
 */
const HTTP_PREFIX = "HTTP/";
const looksLikeHttpMessage = (
  payload: Buffer,
  limit: number,
  recordType: string,
): boolean => {
  const head = payload.toString("latin1", 0, limit);
  if (head.startsWith(HTTP_PREFIX)) return true;
  if (recordType === "response") return false;
  const space = head.indexOf(" ");
  if (space <= 0) return false;
  return TOKEN.test(head.slice(0, space));
};

interface HttpRead {
  readonly message: WarcHttpMessage | null;
  readonly omission: WarcHttpOmission | null;
}

/**
 * One reason each, so a skipped message names what stopped the reader instead of
 * eight records sharing one generic sentence. `start-line-limit` and
 * `header-block-limit` are reader allowances, not damage: an intact archive can
 * hit them, and saying so keeps the diagnostic from sending anyone hunting for
 * a corrupt file.
 */
const HTTP_OMISSION_DIAGNOSTICS: Record<
  WarcHttpOmission,
  {
    readonly code: WarcDiagnosticCode;
    readonly message: (offset: number, reason: WarcHttpOmission) => string;
  }
> = {
  "start-line-limit": {
    code: "http-start-line-limit-reached",
    message: (offset) =>
      `The HTTP start line at decoded offset ${offset} exceeds ${HTTP_START_LINE_BYTES} bytes; its method, target or status code was not read.`,
  },
  "header-block-limit": {
    code: "http-header-block-limit-reached",
    message: (offset) =>
      `The HTTP header block at decoded offset ${offset} exceeds ${HTTP_HEADER_BLOCK_BYTES} bytes, ${HTTP_START_LINE_BYTES} bytes per line or ${HTTP_HEADER_FIELDS} fields; the message was not represented.`,
  },
  "malformed-start-line": {
    code: "http-start-line-invalid",
    message: (offset) =>
      `The payload at decoded offset ${offset} begins like an HTTP message but its start line is not a request line or a status line.`,
  },
  "unterminated-start-line": {
    code: "http-start-line-unterminated",
    message: (offset) =>
      `The payload at decoded offset ${offset} begins like an HTTP message but carries no line terminator, so its start line and header block were not read.`,
  },
  "unterminated-header-block": {
    code: "http-header-block-unterminated",
    message: (offset) =>
      `The HTTP header block at decoded offset ${offset} ends without the empty line that terminates it.`,
  },
  "archive-header-limit": {
    code: "archive-header-limit-reached",
    message: () =>
      `The archive-wide header entry allowance of ${WARC_ARCHIVE_MAX_HEADER_ENTRIES} was reached; the HTTP message and later records were not inventoried.`,
  },
};

/**
 * Decode the embedded HTTP start line and header block. The body is not read:
 * `body_bytes` states how much of the record's payload follows the block, and
 * framing headers are reported as written rather than interpreted.
 *
 * The start line and every header line are read from one bounded window of the
 * payload, so a record that declares a gigabyte of body costs the same as one
 * that declares nothing.
 */
const readHttpMessage = (
  payload: Buffer,
  recordType: string,
  budget: HeaderBudget,
  redaction: RedactionState,
): HttpRead => {
  const limit = Math.min(payload.length, HTTP_START_LINE_BYTES);
  if (recordType !== "request" && recordType !== "response")
    return { message: null, omission: null };
  if (!looksLikeHttpMessage(payload, limit, recordType))
    return { message: null, omission: null };
  const startLine = findLineEnd(payload, 0);
  // A payload that starts like HTTP but carries no line terminator is an
  // unfinished message, not a non-HTTP body. Reporting omission null would let
  // an accurate Content-Length call the record complete-within-scope.
  if (startLine === null)
    return { message: null, omission: "unterminated-start-line" };
  if (startLine.contentEnd > HTTP_START_LINE_BYTES)
    return { message: null, omission: "start-line-limit" };
  const startText = payload.toString("latin1", 0, startLine.contentEnd);
  const parsed =
    recordType === "response"
      ? readHttpStatusLine(startText)
      : readHttpRequestLine(startText);
  if (parsed === null)
    return { message: null, omission: "malformed-start-line" };
  let cursor = startLine.end;
  const fields: WarcHttpHeader[] = [];
  const malformed: string[] = [];
  let headerBytes = startLine.end;
  let terminated = false;
  let previousSensitive = false;
  let foldedUrl: FoldedUrl | undefined;
  let entries = 0;
  let budgetExceeded = false;
  // The block ends at the first empty line. `headerBytes` is measured against
  // the same window, so an unterminated block is reported rather than guessed.
  while (cursor < payload.length) {
    const line = findLineEnd(payload, cursor);
    if (line === null) break;
    if (line.contentEnd - cursor > HTTP_START_LINE_BYTES)
      return { message: null, omission: "header-block-limit" };
    if (line.contentEnd === cursor) {
      foldedUrl?.finish();
      headerBytes = line.end;
      terminated = true;
      break;
    }
    if (entries >= HTTP_HEADER_FIELDS)
      return { message: null, omission: "header-block-limit" };
    if (line.end > HTTP_HEADER_BLOCK_BYTES)
      return { message: null, omission: "header-block-limit" };
    entries += 1;
    if (entries > budget.remaining) {
      budgetExceeded = true;
      cursor = line.end;
      continue;
    }
    const text = payload.toString("latin1", cursor, line.contentEnd);
    const colon = text.indexOf(":");
    const name = colon > 0 ? text.slice(0, colon) : "";
    const sensitive = SENSITIVE_HTTP_HEADERS.has(name.trim().toLowerCase());
    const url = HTTP_URL_HEADERS.has(name.trim().toLowerCase());
    const continuation = /^[ \t]/u.test(text);
    if (!continuation) {
      foldedUrl?.finish();
      foldedUrl = url ? new FoldedUrl(redaction) : undefined;
    }
    const value = colon > 0 ? trimHttpSpaces(text, colon + 1) : "";
    if (
      colon <= 0 ||
      !TOKEN.test(name) ||
      HTTP_FORBIDDEN_VALUE_BYTES.test(value)
    ) {
      const index = malformed.length;
      malformed.push(
        sanitizedMalformedHeader(text, previousSensitive, redaction),
      );
      if (foldedUrl !== undefined) {
        const prefix = continuation ? "" : text.slice(0, colon + 1);
        const value = continuation ? text : text.slice(colon + 1);
        const sensitiveBefore = previousSensitive;
        foldedUrl.add(value, (safe) => {
          malformed[index] = sanitizedMalformedHeader(
            prefix + safe,
            sensitiveBefore,
            redaction,
          );
        });
      }
    } else {
      const index = fields.length;
      fields.push({
        name,
        value: sensitive
          ? null
          : url
            ? withoutUrlUserInfo(value, redaction)
            : value,
      });
      if (foldedUrl !== undefined)
        foldedUrl.add(value, (safe) => {
          fields[index] = { name, value: safe };
        });
    }
    if (!continuation) {
      previousSensitive = sensitive;
    }
    headerBytes = line.end;
    cursor = line.end;
  }
  if (!terminated)
    return { message: null, omission: "unterminated-header-block" };
  if (budgetExceeded)
    return { message: null, omission: "archive-header-limit" };
  budget.remaining -= entries;
  const framingDeclared = fields.some(
    (field) =>
      field.name.toLowerCase() === "content-length" ||
      field.name.toLowerCase() === "transfer-encoding",
  );
  const target = "request_target" in parsed ? parsed.request_target : null;
  const safeTarget =
    target === null
      ? null
      : withoutUrlUserInfo(target, redaction, "request-target");
  const targetOffset =
    target === null
      ? -1
      : startText.indexOf(target, startText.indexOf(" ") + 1);
  const safeStartLine =
    target === null || target === safeTarget
      ? startText
      : `${startText.slice(0, targetOffset)}${safeTarget}${startText.slice(targetOffset + target.length)}`;
  return {
    omission: null,
    message: {
      start_line: safeStartLine,
      version: parsed.version,
      method: "method" in parsed ? parsed.method : null,
      request_target: safeTarget,
      status_code: "status_code" in parsed ? parsed.status_code : null,
      reason_phrase: "reason_phrase" in parsed ? parsed.reason_phrase : null,
      headers: fields,
      malformed_header_lines: malformed,
      header_bytes: headerBytes,
      body_bytes: Math.max(payload.length - headerBytes, 0),
      body_framing_declared: framingDeclared,
    },
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
  if (result.limit === "archive-fields")
    diagnostic(
      ordinal,
      "archive-header-limit-reached",
      `The archive-wide header entry allowance of ${WARC_ARCHIVE_MAX_HEADER_ENTRIES} was reached; later records were not read.`,
    );
  else if (result.limit === "line")
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
  const budget: HeaderBudget = { remaining: WARC_ARCHIVE_MAX_HEADER_ENTRIES };
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
    const redaction: RedactionState = { ambiguousUrl: false };
    const header = readHeaderBlock(data, nextVersion, budget, redaction);
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
    budget.remaining -= header.block.malformed.length;
    const step = readOneRecord(data, header.block, nextVersion, {
      ordinal,
      diagnostic,
      budget,
      redaction,
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
  context: {
    readonly ordinal: number;
    readonly diagnostic: DiagnosticSink;
    readonly budget: HeaderBudget;
    readonly redaction: RedactionState;
  },
): RecordStep => {
  const { ordinal, diagnostic, budget, redaction } = context;
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
        budget,
        redaction,
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
    budget,
    redaction,
  });
  // An omission is only reported when the payload promised an HTTP message, so
  // an ordinary body reads as `http: null` without a diagnostic per record.
  if (record.http_omitted !== null)
    diagnostic(
      ordinal,
      HTTP_OMISSION_DIAGNOSTICS[record.http_omitted].code,
      HTTP_OMISSION_DIAGNOSTICS[record.http_omitted].message(
        offset,
        record.http_omitted,
      ),
    );
  if (record.http !== null && record.http.malformed_header_lines.length > 0)
    diagnostic(
      ordinal,
      "invalid-header-line",
      `The HTTP header block contains ${record.http.malformed_header_lines.length} malformed line(s).`,
    );
  if (redaction.ambiguousUrl)
    diagnostic(
      ordinal,
      "url-credentials-ambiguous",
      "A URL was withheld because its credential span could not be identified safely.",
    );
  return {
    record,
    nextCursor:
      payloadBytes < declaredLength ||
      record.http_omitted === "archive-header-limit"
        ? null
        : payloadStart + payloadBytes,
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
    readonly budget: HeaderBudget;
    readonly redaction: RedactionState;
  },
): WarcRecord => {
  const { block, offset, ordinal, payloadBytes, payload, budget, redaction } =
    input;
  const type = block.fields.get("warc-type") ?? "";
  const version = block.version;
  const contentLength = parseNonNegativeInt(block.fields.get("content-length"));
  const hasPayload = payloadBytes > 0;
  const http = hasPayload
    ? readHttpMessage(payload, type, budget, redaction)
    : { message: null, omission: null };

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
    target_uri: block.fields.has("warc-target-uri")
      ? withoutUrlUserInfo(block.fields.get("warc-target-uri")!, redaction)
      : null,
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
    http: http.message,
    http_omitted: http.omission,
    http_start_line_over_ceiling: http.omission === "start-line-limit",
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
    "Embedded HTTP request and response header blocks are decoded; HTTP bodies, chunked or compressed content codings, and trailers are not.",
    "HTTP authentication and cookie header values and URL authority credentials are withheld; field names remain visible.",
    "Record payload bytes outside the HTTP header block are counted but not retained, so no body content reaches the result.",
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
        http_messages: 0,
        http_omitted: 0,
        malformed_headers: 0,
        diagnostics: 1,
      },
      source_coverage: {
        scope: "record-headers-and-http-headers",
        status: "partial",
        payloads: "header-block-only",
        http_headers: "decoded",
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
    (total, record) =>
      total +
      record.malformed_header_lines.length +
      (record.http?.malformed_header_lines.length ?? 0),
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
      http_messages: stream.records.filter((record) => record.http !== null)
        .length,
      http_omitted: stream.records.filter(
        (record) => record.http_omitted !== null,
      ).length,
      malformed_headers: malformedHeaders,
      diagnostics: stream.diagnostics.length,
    },
    source_coverage: {
      scope: "record-headers-and-http-headers",
      status,
      payloads: "header-block-only",
      http_headers: "decoded",
      http_bodies: "not-decoded",
      digests: "not-verified",
      related_records: "not-linked",
      network: "not-contacted",
    },
    limitations: limitationsFor(decoded.value.compression, status),
  });
};
