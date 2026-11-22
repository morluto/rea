import { createHash } from "node:crypto";

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
/**
 * Events whose per-record identity is retained for duplicate and interleaving
 * detection. A 4 GiB admission can hold millions of events, so state is kept
 * for a bounded window; records past it are counted but not joined.
 */
export const AUDITD_RETAINED_EVENT_LIMIT = 4096;

/** `type=... msg=audit(<sec>.<millis>:<serial>): <body>` — the auditd record header. */
// The body is opaque bytes: a literal CR, U+2028 or U+2029 can reach it through
// an encoded message, and `.` would reject the whole record for them.
const RECORD_HEADER =
  /^(?:node=(?<node>\S+) )?type=(?<type>\S+) msg=audit\((?<sec>\d+)\.(?<millis>\d{1,3}):(?<serial>\d+)\):(?: (?<body>[\s\S]*))?$/u;
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
  /** `<node> <seconds>.<millis>:<serial>`, the identity records are joined on. */
  readonly event_id: string;
  /** The `node=` host the event's records name, or `null` when unqualified. */
  readonly node: string | null;
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
    /**
     * Events the retained window did not hold. Past the retention limit a
     * record's siblings are not joined, so an interleaved event there can be
     * counted more than once; `event_count_lower_bound` says whether that could
     * have happened.
     */
    readonly omitted_events: number;
    /**
     * True once an event fell past the retained window and its records were no
     * longer joined: `event_count` and `omitted_events` are then lower bounds,
     * because an interleaved event there can be counted once per run of its
     * records rather than once.
     */
    readonly event_count_lower_bound: boolean;
    readonly trailing_bytes: number;
  };
  readonly limitations: readonly string[];
}

/** One event under construction; records are joined on its full identity. */
interface PendingEvent {
  readonly node: string | undefined;
  /** Original millis spelling, so padded and unpadded records share a key. */
  readonly millisText: string;
  readonly seconds: number;
  readonly millis: number;
  readonly serial: number;
  recordCount: number;
  readonly typeCounts: Map<string, number>;
  /** Record digests already seen in this event; the retention window bounds it. */
  readonly seenRecords: Set<string>;
  firstLine: number;
  lastLine: number;
  duplicateCount: number;
  interleaved: boolean;
}

const eventId = (event: PendingEvent): string =>
  `${event.node === undefined ? "" : `${event.node} `}${String(event.seconds)}.${event.millisText.padStart(3, "0")}:${String(event.serial)}`;

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
  // not-an-allowance: bytes of the line being assembled that were dropped after it overflowed the fixed line ceiling; only fed to the trailing-byte tally, never charged from a resource budget.
  #pendingFlushedBytes = 0;
  #lineNumber = 0;
  // not-an-allowance: bytes of a final line that ended without a newline, a tally of what the file held rather than a budget.
  #trailingBytes = 0;
  #recordCount = 0;
  readonly #typeCounts = new Map<string, number>();
  readonly #events = new Map<string, PendingEvent>();
  /** First-seen order of the retained events, bounded to the sample. */
  readonly #sampleOrder: string[] = [];
  // not-an-allowance: a tally of the events currently retained in the window, compared with the retention ceiling but never charged against a resource budget.
  #windowEventCount = 0;
  /**
   * Events past the retained window. Their identity is not joined, so only a
   * record that does not share the previous record's identity can be shown to
   * start one. This is an exact count for a log whose records are contiguous
   * and a lower bound for an interleaved one, so it is reported as such.
   */
  #beyondWindowEventCount = 0;
  #malformedCount = 0;
  // sample-cap: the full malformed count is reported beside a sample of the lines.
  readonly #malformed: AuditRecordDiagnostic[] = [];
  #outOfOrderCount = 0;
  #duplicateCount = 0;
  /** Every retained event seen out of sequence, not just the sampled ones. */
  #interleavedEventCount = 0;
  /** Records past the retained window, whose identity is not joined. */
  #skippedRecordCount = 0;
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
    if (this.#pendingBytes > 0 || this.#pendingFlushedBytes > 0) {
      this.#trailingBytes = this.#pendingBytes + this.#pendingFlushedBytes;
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
        `${String(this.#duplicateCount)} record(s) repeat a record already seen in the same event, byte for byte; each occurrence is counted and only the first name is retained`,
      );
    if (this.#beyondWindowEventCount > 0 || this.#skippedRecordCount > 0)
      limitations.push(
        `per-record identity is retained for the most recent ${String(AUDITD_RETAINED_EVENT_LIMIT)} events; at least ${String(this.#beyondWindowEventCount)} further events and ${String(this.#skippedRecordCount)} record(s) past that window are counted in the totals, but their duplicate, interleaving and event-start status is not established, so event_count and omitted_events are lower bounds`,
      );
    limitations.push(
      "records are inventoried by header and record type: key-value fields, hex/escaped values, argument ordering and decoded syscall or permission meanings are not interpreted",
    );

    const events = this.#sampleOrder.map((key) =>
      this.#summarize(this.#events.get(key)!),
    );
    return ok({
      metadata: {
        kind: "auditd-log",
        line_count: this.#lineNumber,
        record_count: this.#recordCount,
        event_count: this.#windowEventCount + this.#beyondWindowEventCount,
        event_count_lower_bound:
          this.#beyondWindowEventCount > 0 || this.#skippedRecordCount > 0,
        event_type_counts: sortedCounts(this.#typeCounts),
        malformed_line_count: this.#malformedCount,
        malformed_lines: this.#malformed,
        omitted_malformed_lines: Math.max(
          0,
          this.#malformedCount - this.#malformed.length,
        ),
        out_of_order_record_count: this.#outOfOrderCount,
        duplicate_record_count: this.#duplicateCount,
        interleaved_event_count: this.#interleavedEventCount,
        events,
        omitted_events:
          this.#windowEventCount + this.#beyondWindowEventCount - events.length,
        trailing_bytes: this.#trailingBytes,
      },
      limitations,
    });
  }

  #acceptSegment(segment: Buffer): void {
    if (this.#lineOverflow) {
      this.#pendingFlushedBytes += segment.length;
      return;
    }
    if (this.#pendingBytes + segment.length > MAX_RECORD_LINE_BYTES) {
      this.#lineOverflow = true;
      this.#pendingFlushedBytes = this.#pendingBytes + segment.length;
      this.#pendingBytes = 0;
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
    this.#pendingFlushedBytes = 0;
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
    this.#acceptLine(lineBytes);
  }

  #acceptLine(lineBytes: Buffer): void {
    // Header bytes are printable ASCII, so the decoded string is a faithful
    // identity. The body can hold bytes UTF-8 cannot represent, which decode
    // to the same U+FFFD, so duplicate detection hashes the line's raw bytes
    // rather than that lossy text.
    const line = lineBytes.toString("utf8");
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
    const millisText = match.groups["millis"]!;
    const millis = Number(millisText);
    const serial = Number(match.groups["serial"]);
    const node = match.groups["node"];
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

    // The event identity is the whole join key: node, timestamp and serial.
    // Serial and timestamp are only unique enough to join on within one host,
    // so a centralized log's node= prefix has to stay part of the identity.
    // Ordering stays temporal (timestamp then serial); node only splits events.
    const key = occurrenceKey(node, seconds, millis, serial);
    const identity = `${String(seconds).padStart(12, "0")}.${millisText.padStart(3, "0")}:${String(serial).padStart(12, "0")}`;
    if (this.#maxIdentity !== null && identity < this.#maxIdentity)
      this.#outOfOrderCount += 1;
    else this.#maxIdentity = identity;

    const existing = this.#events.get(key);
    if (
      existing === undefined &&
      this.#windowEventCount >= AUDITD_RETAINED_EVENT_LIMIT
    ) {
      // The event's identity was not retained, so only a record that does not
      // share the previous record's identity can be shown to start one. The
      // same run of records is not recounted, which keeps a contiguous tail
      // exact and makes an interleaved one a lower bound.
      if (this.#lastEventKey !== key) this.#beyondWindowEventCount += 1;
      this.#skippedRecordCount += 1;
      this.#lastEventKey = key;
      return;
    }

    if (existing !== undefined && this.#lastEventKey !== key) {
      if (!existing.interleaved) this.#interleavedEventCount += 1;
      existing.interleaved = true;
    }
    const event =
      existing ??
      ({
        node,
        millisText,
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
      this.#windowEventCount += 1;
      if (this.#sampleOrder.length < AUDITD_INLINE_EVENT_LIMIT)
        this.#sampleOrder.push(key);
    }
    this.#lastEventKey = key;

    // Duplicate detection is per record content, not per record type: a long
    // execve argument list can span several EXECVE records with no item= index,
    // and those are legitimate continuations, not repeats. The line's raw bytes
    // are hashed, so two records that differ only in bytes UTF-8 cannot
    // represent stay distinct instead of decoding to the same U+FFFD. The
    // digest keeps retained state to one short key per record per event; the
    // retention window bounds how many events hold those keys at once.
    const recordKey = createHash("sha256").update(lineBytes).digest("base64");
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
      node: event.node ?? null,
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

const occurrenceKey = (
  node: string | undefined,
  seconds: number,
  millis: number,
  serial: number,
) =>
  `${node ?? ""}\u0000${String(seconds)}.${String(millis)}:${String(serial)}`;

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
