import { boundedList } from "../boundedList.js";
import { ok, err, type Result } from "../result.js";
import type {
  RegionDecodeFailure,
  RegionDecoder,
} from "../firmware/regionDecoder.js";

/**
 * `MAX_AUDIT_MESSAGE_LENGTH` is 8970 bytes plus the daemon's own prefix; a
 * single record far past that is not one auditd wrote, so a line longer than
 * this is treated as unparseable rather than buffered without bound.
 */
const MAX_RECORD_LINE_BYTES = 64 * 1024;
/** The whole log is bounded so a runaway acquisition cannot exhaust memory. */
export const AUDITD_LOG_MAX_FILE_BYTES = 1024 * 1024 * 1024 * 4;
/** Inline events are a sample; totals below cover the whole file. */
export const AUDITD_INLINE_EVENT_LIMIT = 32;
/** Inline diagnostics are a sample too. */
export const AUDITD_INLINE_DIAGNOSTIC_LIMIT = 16;
/** Record types kept per inline event. */
export const AUDITD_INLINE_EVENT_TYPE_LIMIT = 16;

/** `type=... msg=audit(<sec>.<millis>:<serial>): <body>` — the auditd record header. */
const RECORD_HEADER =
  /^(?:node=(?<node>\S+) )?type=(?<type>\S+) msg=audit\((?<sec>\d+)\.(?<millis>\d{1,3}):(?<serial>\d+)\):(?: (?<body>.*))?$/u;
/** `msg=audit(...)` can precede or follow `type=`; auditd always emits type first. */
const AUDIT_REFERENCE = /audit\((\d+)\.(\d{1,3}):(\d+)\)/u;

export interface AuditRecordDiagnostic {
  /** 1-based source line, as counted by the reader. */
  readonly line: number;
  readonly reason: string;
  /** Bounded excerpt of the offending text, never the whole record. */
  readonly excerpt: string;
}

export interface AuditEventTypeCount {
  readonly type: string;
  readonly count: number;
}

export interface AuditEventSummary {
  /** `<seconds>.<millis>:<serial>`, the identity records are joined on. */
  readonly event_id: string;
  readonly event_seconds: number;
  readonly event_millis: number;
  readonly serial: number;
  readonly record_count: number;
  readonly record_types: readonly AuditEventTypeCount[];
  readonly first_line: number;
  readonly last_line: number;
  /** Record types the event repeats with the same `item=` index. */
  readonly duplicate_record_count: number;
  /** A record for this event appeared after a later event started. */
  readonly interleaved: boolean;
}

export interface AuditdLogInventory {
  readonly metadata: {
    readonly kind: "auditd-log";
    readonly line_count: number;
    readonly record_count: number;
    readonly event_count: number;
    readonly event_type_counts: readonly AuditEventTypeCount[];
    readonly malformed_line_count: number;
    readonly malformed_lines: readonly AuditRecordDiagnostic[];
    readonly omitted_malformed_lines: number;
    readonly out_of_order_record_count: number;
    readonly duplicate_record_count: number;
    readonly interleaved_event_count: number;
    readonly events: readonly AuditEventSummary[];
    readonly omitted_events: number;
    readonly trailing_bytes: number;
  };
  readonly limitations: readonly string[];
}

/** One event under construction; records are joined on its full identity. */
interface PendingEvent {
  readonly seconds: number;
  readonly millis: number;
  readonly serial: number;
  recordCount: number;
  readonly typeCounts: Map<string, number>;
  readonly seenRecords: Set<string>;
  firstLine: number;
  lastLine: number;
  duplicateCount: number;
  interleaved: boolean;
}

const eventId = (event: PendingEvent): string =>
  `${String(event.seconds)}.${String(event.millis)}:${String(event.serial)}`;

const sortedCounts = (counts: Map<string, number>): AuditEventTypeCount[] =>
  [...counts]
    .map(([type, count]) => ({ type, count }))
    .sort((left, right) =>
      left.type < right.type ? -1 : left.type > right.type ? 1 : 0,
    );

const failure = (message: string): RegionDecodeFailure => ({
  kind: "format",
  message,
});

/**
 * Feed the admitted file a line at a time and join records on their full audit
 * event identity. A record is counted under the event its own header names, so
 * out-of-order and interleaved writes are reported rather than silently
 * reordered into a tidy timeline.
 */
class AuditdLogScanner {
  readonly #fileBytes: number;
  #pendingLine: Buffer[] = [];
  // not-an-allowance: pending bytes of the line being assembled, bounded by a fixed line ceiling rather than charged from a resource budget.
  #pendingBytes = 0;
  #lineNumber = 0;
  /** Bytes of a final line that ended without a newline. */
  #trailingBytes = 0;
  #recordCount = 0;
  readonly #typeCounts = new Map<string, number>();
  readonly #events = new Map<string, PendingEvent>();
  readonly #eventOrder: string[] = [];
  #malformedCount = 0;
  // sample-cap: the full malformed count is reported beside a sample of the lines.
  readonly #malformed: AuditRecordDiagnostic[] = [];
  #outOfOrderCount = 0;
  #duplicateCount = 0;
  /** Lexicographically ordered event identity; a smaller one is out of order. */
  #maxIdentity: string | null = null;
  #lastEventKey: string | null = null;
  #lineOverflow = false;

  constructor(fileBytes: number) {
    this.#fileBytes = fileBytes;
  }

  write(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      this.#acceptSegment(bytes.subarray(start, index));
      this.#finishLine();
      start = index + 1;
    }
    if (start < bytes.length) this.#acceptSegment(bytes.subarray(start));
    return ok(undefined);
  }

  finish(): Result<AuditdLogInventory, RegionDecodeFailure> {
    if (this.#pendingBytes > 0) {
      this.#trailingBytes = this.#pendingBytes;
      this.#finishLine();
    }
    if (this.#lineOverflow)
      return err(
        failure(
          `the file declares ${String(this.#fileBytes)} bytes but more were supplied`,
        ),
      );
    if (this.#lineNumber === 0)
      return err(failure("file holds no audit records"));
    if (this.#recordCount === 0)
      return err(
        failure(
          `${String(this.#lineNumber)} line(s) were read but none is an auditd record`,
        ),
      );

    const limitations: string[] = [];
    if (this.#malformedCount > 0)
      limitations.push(
        `${String(this.#malformedCount)} line(s) are not auditd records or name an unparseable event identity; their text is not represented`,
      );
    if (this.#outOfOrderCount > 0)
      limitations.push(
        `${String(this.#outOfOrderCount)} record(s) belong to an event that had already been superseded by a later event, so the file's own ordering is preserved rather than reordered`,
      );
    if (this.#duplicateCount > 0)
      limitations.push(
        `${String(this.#duplicateCount)} record(s) repeat a record type and items index already seen in the same event; each occurrence is counted and only the first name is retained`,
      );
    limitations.push(
      "records are inventoried by header and record type: key-value fields, hex/escaped values, argument ordering and decoded syscall or permission meanings are not interpreted",
    );

    const sampled = boundedList(this.#eventOrder, AUDITD_INLINE_EVENT_LIMIT);
    const events = sampled.items.map((key) =>
      this.#summarize(this.#events.get(key)!),
    );
    return ok({
      metadata: {
        kind: "auditd-log",
        line_count: this.#lineNumber,
        record_count: this.#recordCount,
        event_count: this.#events.size,
        event_type_counts: sortedCounts(this.#typeCounts),
        malformed_line_count: this.#malformedCount,
        malformed_lines: this.#malformed,
        omitted_malformed_lines: Math.max(
          0,
          this.#malformedCount - this.#malformed.length,
        ),
        out_of_order_record_count: this.#outOfOrderCount,
        duplicate_record_count: this.#duplicateCount,
        interleaved_event_count: this.#eventOrder.filter(
          (key) => this.#events.get(key)!.interleaved,
        ).length,
        events,
        omitted_events: sampled.omitted,
        trailing_bytes: this.#trailingBytes,
      },
      limitations,
    });
  }

  #acceptSegment(segment: Buffer): void {
    if (this.#lineOverflow) return;
    if (this.#pendingBytes + segment.length > MAX_RECORD_LINE_BYTES) {
      this.#lineOverflow = true;
      this.#pendingLine = [];
      return;
    }
    if (segment.length > 0) this.#pendingLine.push(Buffer.from(segment));
    this.#pendingBytes += segment.length;
  }

  #finishLine(): void {
    this.#lineNumber += 1;
    const lineBytes = Buffer.concat(this.#pendingLine);
    this.#pendingBytes = 0;
    this.#pendingLine = [];

    if (this.#lineOverflow) {
      this.#lineOverflow = false;
      this.#diagnose(
        this.#lineNumber,
        `line exceeds the fixed ${String(MAX_RECORD_LINE_BYTES)}-byte record ceiling`,
        "",
      );
      return;
    }
    this.#acceptLine(lineBytes.toString("utf8"));
  }

  #acceptLine(line: string): void {
    if (line.trim() === "") return;
    const match = RECORD_HEADER.exec(line);
    if (match?.groups === undefined) {
      const reference = AUDIT_REFERENCE.exec(line);
      this.#diagnose(
        this.#lineNumber,
        reference === null
          ? "line is not a `type=… msg=audit(<sec>.<millis>:<serial>):` record"
          : "record header is malformed around its audit event identity",
        line,
      );
      return;
    }
    const seconds = Number(match.groups["sec"]);
    const millis = Number(match.groups["millis"]);
    const serial = Number(match.groups["serial"]);
    const type = match.groups["type"]!;
    if (![seconds, millis, serial].every(Number.isSafeInteger)) {
      this.#diagnose(
        this.#lineNumber,
        "audit event identity exceeds the safe integer range",
        line,
      );
      return;
    }

    this.#recordCount += 1;
    this.#typeCounts.set(type, (this.#typeCounts.get(type) ?? 0) + 1);

    // The event identity is the whole join key: timestamp plus serial, never
    // serial alone, because serials are reused across boots and wraparound.
    const key = occurrenceKey(seconds, millis, serial);
    const identity = `${String(seconds).padStart(12, "0")}.${String(millis).padStart(3, "0")}:${String(serial).padStart(12, "0")}`;
    if (this.#maxIdentity !== null && identity < this.#maxIdentity)
      this.#outOfOrderCount += 1;
    else this.#maxIdentity = identity;

    const existing = this.#events.get(key);
    if (existing !== undefined && this.#lastEventKey !== key)
      existing.interleaved = true;
    const event =
      existing ??
      ({
        seconds,
        millis,
        serial,
        recordCount: 0,
        typeCounts: new Map(),
        seenRecords: new Set(),
        firstLine: this.#lineNumber,
        lastLine: this.#lineNumber,
        duplicateCount: 0,
        interleaved: false,
      } satisfies PendingEvent);
    if (existing === undefined) {
      this.#events.set(key, event);
      this.#eventOrder.push(key);
    }
    this.#lastEventKey = key;

    const recordKey = `${type}\u0000${recordItemsIndex(match.groups["body"])}`;
    if (event.seenRecords.has(recordKey)) {
      event.duplicateCount += 1;
      this.#duplicateCount += 1;
    } else {
      event.seenRecords.add(recordKey);
      event.typeCounts.set(type, (event.typeCounts.get(type) ?? 0) + 1);
    }
    event.recordCount += 1;
    event.lastLine = this.#lineNumber;
  }

  #diagnose(line: number, reason: string, excerpt: string): void {
    this.#malformedCount += 1;
    if (this.#malformed.length >= AUDITD_INLINE_DIAGNOSTIC_LIMIT) return;
    this.#malformed.push({ line, reason, excerpt: excerpt.slice(0, 200) });
  }

  #summarize(event: PendingEvent): AuditEventSummary {
    return {
      event_id: eventId(event),
      event_seconds: event.seconds,
      event_millis: event.millis,
      serial: event.serial,
      record_count: event.recordCount,
      record_types: boundedList(
        sortedCounts(event.typeCounts),
        AUDITD_INLINE_EVENT_TYPE_LIMIT,
      ).items,
      first_line: event.firstLine,
      last_line: event.lastLine,
      duplicate_record_count: event.duplicateCount,
      interleaved: event.interleaved,
    };
  }
}

const occurrenceKey = (seconds: number, millis: number, serial: number) =>
  `${String(seconds)}.${String(millis)}:${String(serial)}`;

/**
 * `item=<n>` is the per-record index auditd gives repeated types. `items=` is
 * the path count on a SYSCALL record, not an index: reading it here made every
 * PATH record of a multi-path event share one key, so the second path was
 * reported as a duplicate and the per-event PATH count came out as one.
 */
const recordItemsIndex = (body: string | undefined): string => {
  const match = body === undefined ? null : /\bitem=(\d+)/u.exec(body);
  return match === null ? "" : match[1]!;
};

/**
 * An auditd log has no magic: recognition reads the first line and accepts it
 * only when that line is a full `type=… msg=audit(<sec>.<millis>:<serial>):`
 * record. One matching line is what distinguishes it from arbitrary text.
 */
export const hasAuditdLogRecord = (prefix: Uint8Array): boolean => {
  if (prefix.length === 0) return false;
  const firstLine = Buffer.from(
    prefix.buffer,
    prefix.byteOffset,
    prefix.byteLength,
  )
    .toString("utf8")
    .split("\n", 1)[0];
  return firstLine !== undefined && RECORD_HEADER.test(firstLine);
};

export const createAuditdLogDecoder = (
  fileBytes: number,
): Result<RegionDecoder<AuditdLogInventory>, RegionDecodeFailure> =>
  Number.isSafeInteger(fileBytes) &&
  fileBytes >= 0 &&
  fileBytes <= AUDITD_LOG_MAX_FILE_BYTES
    ? ok(new AuditdLogScanner(fileBytes))
    : err({
        kind: "limit",
        message: `file is ${String(fileBytes)} bytes, exceeding the fixed ${String(AUDITD_LOG_MAX_FILE_BYTES)}-byte (4 GiB) ceiling`,
        boundary: "file-size",
      });
