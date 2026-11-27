import { createHash } from "node:crypto";

import { boundedList } from "../boundedList.js";
import { ok, err, type Result } from "../result.js";
import { decodeUtf8PreservingBomOrNull } from "../strictUtf8.js";
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
/**
 * Records whose digest is retained per event for duplicate detection. A
 * retained event can still hold an unbounded run of records, so the digest set
 * is bounded too; records past it are counted but no longer checked.
 */
export const AUDITD_RETAINED_RECORD_LIMIT = 1024;
/**
 * Distinct `type=` labels whose whole-file totals are retained once the
 * retained event window has filled. A log's record types are a small, fixed
 * vocabulary, but a crafted header can name any token, so past the window the
 * label is retained only while it fits; records under an unretained label are
 * still counted as records but not under their type.
 */
export const AUDITD_RETAINED_TYPE_LIMIT = 256;
/**
 * Hosts whose event ordering is tracked independently. A centralized log names
 * one `node=` per source host, so this matches the retained-event budget for
 * one host; past it a node stops contributing ordering facts rather than
 * growing the map with the file.
 */
export const AUDITD_ORDERING_NODE_LIMIT = 256;
/**
 * Distinct `type=` labels counted per event. Unlike the whole-file totals this
 * counts every record of the types it meets, so a capped event's per-type
 * counts are exact for the types it lists and omit any first seen past the cap.
 */
export const AUDITD_RETAINED_EVENT_TYPE_LIMIT = 64;
/**
 * Distinct labels past the per-event type cap whose identity is retained so a
 * repeat counts once. Past it the omitted-label count is a lower bound and the
 * event says so, instead of a set that grows with the file.
 */
export const AUDITD_RETAINED_OMITTED_TYPE_LIMIT = 64;
/**
 * Bytes decoded per `String.fromCodePoint` call in the header mapping. The
 * call receives its code points as arguments, so a single spread over a
 * multi-megabyte candidate prefix overflows the call stack.
 */
const HEADER_DECODE_CHUNK = 4096;

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
  /** The excerpt's raw bytes, present only when they are not valid UTF-8. */
  readonly excerpt_hex?: string;
}

export interface AuditEventTypeCount {
  /** The label as UTF-8 text; lossy only when `type_hex` is present. */
  readonly type: string;
  /** The label's raw bytes, present only when they are not valid UTF-8. */
  readonly type_hex?: string;
  readonly count: number;
}

export interface AuditEventSummary {
  /**
   * `<node> <seconds>.<millis>:<serial>`, the identity records are joined on.
   * The node part is the node's bytes with `%` and every byte outside printable
   * ASCII percent-encoded, so distinct raw nodes never share an identity.
   */
  readonly event_id: string;
  /**
   * The `node=` host as UTF-8 text, or `null` when unqualified. Lossy only when
   * `node_hex` is present.
   */
  readonly node: string | null;
  /** The node's raw bytes, present only when they are not valid UTF-8. */
  readonly node_hex?: string;
  readonly event_seconds: number;
  readonly event_millis: number;
  readonly serial: number;
  readonly record_count: number;
  readonly record_types: readonly AuditEventTypeCount[];
  /**
   * Distinct `type=` labels not in `record_types` because the event held its
   * per-event type cap, plus the labels the display list dropped. Each label's
   * records are still counted in `record_count`.
   */
  readonly record_types_omitted: number;
  /**
   * False when more distinct labels passed the per-event cap than were retained,
   * so `record_types_omitted` is a lower bound.
   */
  readonly record_types_omitted_exact: boolean;
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
     * Events the sample does not list. Past the retained window events are
     * counted without joining their records; `event_count_upper_bound` says
     * whether that count, and therefore this difference, can over-count.
     */
    readonly omitted_events: number;
    /**
     * True when an event past the retained window was counted once per run of
     * its records rather than once, so `event_count` (and `omitted_events`) may
     * include repeats of an event already counted.
     */
    readonly event_count_upper_bound: boolean;
    /**
     * Always false. A tail run repeats an event whenever it rejoins one already
     * counted, so no total past the window is a guaranteed minimum; the field
     * remains in the contract so a caller can read both bounds unconditionally.
     */
    readonly event_count_lower_bound: boolean;
    /**
     * True when the tail held no identity for some records, so an event the
     * total counted may have been counted before and the total says nothing
     * about how many distinct events exist. Both bound flags stay false.
     */
    readonly event_count_identity_omitted: boolean;
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
  /**
   * Per-label record counts, retained only up to `AUDITD_RETAINED_EVENT_TYPE_LIMIT`
   * distinct labels. A label met past the cap is not counted here; it is tallied
   * as an omitted distinct label instead, so a repeat of it cannot inflate that
   * count and the map cannot grow with the event.
   */
  readonly typeCounts: Map<string, number>;
  /**
   * Distinct labels first named past the per-event type cap. It is a set rather
   * than a counter so a label that repeats past the cap is one omitted name, not
   * two; its size is the omitted distinct-label count.
   */
  readonly omittedTypeLabels: Set<string>;
  /** A label past the cap could not be retained, so the omitted count is a floor. */
  omittedTypeLabelsSaturated: boolean;
  /** Whether this event is already in the affected-event tally. */
  typeOmissionCounted: boolean;
  /** Record digests already seen in this event, bounded by the record limit. */
  readonly seenRecords: Set<string>;
  firstLine: number;
  lastLine: number;
  duplicateCount: number;
  interleaved: boolean;
}

const eventId = (event: PendingEvent): string =>
  `${event.node === undefined ? "" : `${identityNode(event.node)} `}${String(event.seconds)}.${event.millisText.padStart(3, "0")}:${String(event.serial)}`;

// Ordered by the byte-faithful label, so the order is the source bytes' order
// and a lossy display label cannot make two entries compare equal.
const sortedCounts = (counts: Map<string, number>): AuditEventTypeCount[] =>
  [...counts]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([type, count]) => typeCount(type, count));

/**
 * Decode a record line so distinct raw bytes stay distinct. A lossy UTF-8
 * decode folds every invalid sequence to U+FFFD, which would let two headers
 * that differ only in invalid bytes share a `node=`, `type=`, or identity. Each
 * byte maps to its own code point (ASCII to U+0000..U+007F, the rest into a
 * private block above U+00FF), so the mapping is one-to-one, `\S` still matches
 * every byte a token can hold, and no two inputs collide.
 */
const decodeHeaderBytes = (bytes: Uint8Array): string => {
  // Chunked so the code points reach `fromCodePoint` as a bounded argument
  // list. Spreading a header-sized array overflows the call stack, and this
  // runs on every candidate prefix from format recognition.
  let text = "";
  for (let start = 0; start < bytes.length; start += HEADER_DECODE_CHUNK) {
    const codePoints: number[] = [];
    for (const byte of bytes.subarray(start, start + HEADER_DECODE_CHUNK))
      codePoints.push(byte < 0x80 ? byte : 0x100 + byte);
    text += String.fromCodePoint(...codePoints);
  }
  return text;
};

/** The raw bytes a `decodeHeaderBytes` string stands for. */
const headerBytes = (text: string): Buffer =>
  Buffer.from(
    Array.from(text, (character) => {
      const code = character.codePointAt(0)!;
      return code < 0x80 ? code : code - 0x100;
    }),
  );

/**
 * Project byte-faithful header text for the caller. Valid UTF-8 is returned as
 * written; otherwise the text is a lossy decode and `hex` carries the source
 * bytes, so the inventory never reports a value the record does not hold.
 */
const sourceText = (
  text: string,
): { readonly text: string; readonly hex?: string } => {
  const bytes = headerBytes(text);
  // A leading BOM is source text here, not a signature to strip.
  const decoded = decodeUtf8PreservingBomOrNull(bytes);
  return decoded === null
    ? { text: bytes.toString("utf8"), hex: bytes.toString("hex") }
    : { text: decoded };
};

/** Percent-encode a node for the join identity: injective and printable. */
const identityNode = (text: string): string => {
  let encoded = "";
  for (const byte of headerBytes(text))
    encoded +=
      byte > 0x20 && byte < 0x7f && byte !== 0x25
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  return encoded;
};

const typeCount = (type: string, count: number): AuditEventTypeCount => {
  const label = sourceText(type);
  return label.hex === undefined
    ? { type: label.text, count }
    : { type: label.text, type_hex: label.hex, count };
};

const failure = (message: string): RegionDecodeFailure => ({
  kind: "malformed",
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
  // not-an-allowance: observed per-type record totals for the whole file; admitted at most AUDITD_RETAINED_TYPE_LIMIT distinct labels, which the scanner tallies rather than refuses.
  readonly #typeCounts = new Map<string, number>();
  // not-an-allowance: distinct record-type labels the tail (events past the window) held past AUDITD_RETAINED_TYPE_LIMIT; a tally reported as an omission.
  #omittedTypeCount = 0;
  readonly #events = new Map<string, PendingEvent>();
  /** First-seen order of the retained events, bounded to the sample. */
  readonly #sampleOrder: string[] = [];
  // not-an-allowance: a tally of the events currently retained in the window, compared with the retention ceiling but never charged against a resource budget.
  #windowEventCount = 0;
  /**
   * Events past the retained window, counted as the number of runs of records
   * that do not continue the previous record's identity. That is exact for a
   * contiguous tail and an over-count for an interleaved one, so the reported
   * event total is an upper bound.
   */
  #beyondWindowEventCount = 0;
  #malformedCount = 0;
  // sample-cap: the full malformed count is reported beside a sample of the lines.
  readonly #malformed: AuditRecordDiagnostic[] = [];
  #outOfOrderCount = 0;
  #duplicateCount = 0;
  /** Sampled events whose type map exceeded the inline type limit. */
  #typeSampleLimitedEventCount = 0;
  /** Events whose record types exceeded AUDITD_RETAINED_EVENT_TYPE_LIMIT. */
  #eventTypeOmittedEventCount = 0;
  /** Events whose omitted labels exceeded AUDITD_RETAINED_OMITTED_TYPE_LIMIT. */
  #omittedLabelSaturatedEventCount = 0;
  /** Every retained event seen out of sequence, not just the sampled ones. */
  #interleavedEventCount = 0;
  /** Records whose event already held its full digest quota, so not checked. */
  #identityLimitedEventCount = 0;
  /**
   * Identities already counted as a tail event start, bounded like the retained
   * window. A hit means a tail event was counted once per run, so the total
   * repeats an event and can only be an upper bound.
   */
  readonly #tailEventKeys = new Set<string>();
  #tailOverCount = false;
  /**
   * True once the tail met an identity it could not hold in the bounded set
   * above. From then on a membership miss no longer proves the event was not
   * counted before, so the total cannot be bounded at all.
   */
  #tailIdentityOmitted = false;
  /** Records past the retained window, whose identity is not joined. */
  #skippedRecordCount = 0;
  /**
   * Per-node greatest event identity seen, so ordering is judged within a host.
   * A centralized log interleaves unrelated hosts: one host's serial says
   * nothing about another's sequence, so a single global maximum would report a
   * normal mixed-node acquisition as out of order. Bounded like the type table:
   * a node past the cap stops contributing ordering facts rather than growing
   * this map with the file.
   */
  readonly #maxIdentityByNode = new Map<string, string>();
  /**
   * True once a node past the ordering cap could not be tracked. From then on
   * the out-of-order count is a lower bound rather than the whole story.
   */
  #orderingNodeOmitted = false;
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

    const limitations = this.#limitations();
    const events = this.#sampleOrder.map((key) =>
      this.#summarize(this.#events.get(key)!),
    );
    if (this.#typeSampleLimitedEventCount > 0)
      limitations.push(
        `${String(AUDITD_INLINE_EVENT_TYPE_LIMIT)} record types are listed per sampled event, ordered by name; ${String(this.#typeSampleLimitedEventCount)} sampled event(s) hold more, so their record_types_omitted counts the omitted type names while record_count counts every record`,
      );
    return ok({
      metadata: {
        kind: "auditd-log",
        line_count: this.#lineNumber,
        record_count: this.#recordCount,
        event_count: this.#windowEventCount + this.#beyondWindowEventCount,
        // Past the window an event is counted once per run of its records, so a
        // run that repeats a counted identity repeats an event and the total can
        // only be an upper bound. A single repeated identity is no exception:
        // the run still adds to the total, so no honest lower bound exists. An
        // identity the tail could not hold leaves no bound at all.
        event_count_upper_bound:
          this.#tailOverCount && !this.#tailIdentityOmitted,
        event_count_lower_bound: false,
        event_count_identity_omitted: this.#tailIdentityOmitted,
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

  /** What the scan could not establish, in a fixed order. */
  #limitations(): string[] {
    const limitations: string[] = [];
    if (this.#malformedCount > 0)
      limitations.push(
        `${String(this.#malformedCount)} line(s) are not auditd records or name an unparseable event identity; their text is not represented`,
      );
    if (this.#outOfOrderCount > 0)
      limitations.push(
        `${String(this.#outOfOrderCount)} record(s) belong to an event that had already been superseded by a later event on the same node, so the file's own ordering is preserved rather than reordered`,
      );
    if (this.#orderingNodeOmitted)
      limitations.push(
        `ordering is tracked for at most ${String(AUDITD_ORDERING_NODE_LIMIT)} hosts; records of hosts past that cap are not compared with their own earlier events, so out_of_order_record_count is a lower bound`,
      );
    if (this.#duplicateCount > 0)
      limitations.push(
        `${String(this.#duplicateCount)} record(s) repeat a record already seen in the same event, byte for byte; each occurrence is counted and only the first name is retained`,
      );
    if (this.#beyondWindowEventCount > 0 || this.#skippedRecordCount > 0)
      limitations.push(
        `per-record identity is retained for the most recent ${String(AUDITD_RETAINED_EVENT_LIMIT)} events; ${String(this.#beyondWindowEventCount)} further event start(s) and ${String(this.#skippedRecordCount)} record(s) past that window are counted in the totals, but their duplicate, interleaving and event-start status is not established, so event_count can be an upper bound when the tail interleaves events`,
      );
    if (this.#tailIdentityOmitted)
      limitations.push(
        `the tail met more event identities than it retained past ${String(AUDITD_RETAINED_EVENT_LIMIT)}; past that point a repeated run may be an event already counted, so event_count is neither an upper nor a lower bound and no bound flag is set`,
      );
    else if (this.#tailOverCount)
      limitations.push(
        "the tail repeated an event across a noncontiguous run, so it was counted once per run; event_count is an upper bound, not an exact count",
      );
    if (this.#identityLimitedEventCount > 0)
      limitations.push(
        `duplicate detection retains at most ${String(AUDITD_RETAINED_RECORD_LIMIT)} record digests per event; ${String(this.#identityLimitedEventCount)} record(s) past that limit are counted and tallied by type but no longer checked for repetition, so duplicate_record_count is a lower bound`,
      );
    if (this.#eventTypeOmittedEventCount > 0)
      limitations.push(
        `a retained event's per-type counts stop at ${String(AUDITD_RETAINED_EVENT_TYPE_LIMIT)} distinct types; ${String(this.#eventTypeOmittedEventCount)} event(s) hold types past that, so their record_types omits those labels and record_types_omitted counts the omitted labels while record_count counts every record`,
      );
    if (this.#omittedLabelSaturatedEventCount > 0)
      limitations.push(
        `distinct labels past a retained event's type cap are retained for repetition checks only up to ${String(AUDITD_RETAINED_OMITTED_TYPE_LIMIT)}; ${String(this.#omittedLabelSaturatedEventCount)} event(s) named more, so their record_types_omitted is a lower bound and record_types_omitted_exact is false`,
      );
    if (this.#omittedTypeCount > 0)
      limitations.push(
        `${String(this.#omittedTypeCount)} record(s) past the retained window name a type beyond the ${String(AUDITD_RETAINED_TYPE_LIMIT)} distinct types whose totals are kept, so event_type_counts omits those types although record_count counts every record`,
      );
    limitations.push(
      "records are inventoried by header and record type: key-value fields, hex/escaped values, argument ordering and decoded syscall or permission meanings are not interpreted",
    );

    return limitations;
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
    // The header is printable ASCII, so it must decode exactly: a lossy decode
    // maps different invalid bytes to the same U+FFFD and two distinct `node=`
    // or `type=` values would then share an identity. Decoding the header's raw
    // bytes with an ASCII fence keeps those bytes apart; the body stays opaque
    // and is never decoded for identity. Duplicate detection hashes the line's
    // raw bytes for the same reason.
    const line = decodeHeaderBytes(lineBytes);
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
    const typeCount = this.#typeCounts.get(type);
    if (typeCount !== undefined) this.#typeCounts.set(type, typeCount + 1);
    else if (
      this.#windowEventCount < AUDITD_RETAINED_EVENT_LIMIT ||
      this.#typeCounts.size < AUDITD_RETAINED_TYPE_LIMIT
    )
      this.#typeCounts.set(type, 1);
    else this.#omittedTypeCount += 1;

    // The event identity is the whole join key: node, timestamp and serial.
    // Serial and timestamp are only unique enough to join on within one host,
    // so a centralized log's node= prefix has to stay part of the identity.
    // Ordering stays temporal (timestamp then serial) and is judged per node:
    // two hosts emit at the same millisecond with unrelated serials, which is
    // not a reordering.
    const key = occurrenceKey(node, seconds, millis, serial);
    const identity = `${String(seconds).padStart(12, "0")}.${millisText.padStart(3, "0")}:${String(serial).padStart(12, "0")}`;
    const nodeKey = node ?? "";
    const maxIdentity = this.#maxIdentityByNode.get(nodeKey);
    if (maxIdentity === undefined || identity >= maxIdentity) {
      if (
        maxIdentity !== undefined ||
        this.#maxIdentityByNode.size < AUDITD_ORDERING_NODE_LIMIT
      )
        this.#maxIdentityByNode.set(nodeKey, identity);
      else this.#orderingNodeOmitted = true;
    } else this.#outOfOrderCount += 1;

    const existing = this.#events.get(key);
    if (
      existing === undefined &&
      this.#windowEventCount >= AUDITD_RETAINED_EVENT_LIMIT
    ) {
      // The event's identity was not retained, so only a record that does not
      // share the previous record's identity can be shown to start one. A
      // contiguous tail is therefore exact, while an interleaved one is counted
      // once per run it appears in, which counts an event more than once.
      if (this.#lastEventKey !== key) {
        this.#beyondWindowEventCount += 1;
        if (this.#tailEventKeys.has(key)) this.#tailOverCount = true;
        else if (this.#tailEventKeys.size < AUDITD_RETAINED_EVENT_LIMIT)
          this.#tailEventKeys.add(key);
        // Past that cap the set no longer names every tail event it met, so a
        // later miss no longer proves the identity is new. Set the omission from
        // here on, whether or not this particular record repeats.
        else this.#tailIdentityOmitted = true;
      }
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
        typeOmissionCounted: false,
        omittedTypeLabels: new Set(),
        omittedTypeLabelsSaturated: false,
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
    const duplicate = event.seenRecords.has(recordKey);
    if (duplicate) {
      event.duplicateCount += 1;
      this.#duplicateCount += 1;
    } else {
      // At the limit the digest is not retained, so a repeat after this point
      // is counted as another record rather than a duplicate. The limitation
      // says so instead of letting the set grow with the file.
      if (event.seenRecords.size < AUDITD_RETAINED_RECORD_LIMIT)
        event.seenRecords.add(recordKey);
      else this.#identityLimitedEventCount += 1;
    }
    // Type counts are kept apart from digest retention: a record past the digest
    // limit is still tallied under its type, so a listed count is exact rather
    // than stopping where duplicate detection did. A duplicate is the only
    // record not tallied, because it repeats one already counted here.
    if (!duplicate) this.#tallyEventType(event, type);
    event.recordCount += 1;
    event.lastLine = this.#lineNumber;
  }

  /**
   * Tally one non-duplicate record under its event's type. The per-event map
   * and the omitted-label set are both bounded, so neither grows with the file.
   */
  #tallyEventType(event: PendingEvent, type: string): void {
    const typeCount = event.typeCounts.get(type);
    if (typeCount !== undefined) event.typeCounts.set(type, typeCount + 1);
    else if (event.typeCounts.size < AUDITD_RETAINED_EVENT_TYPE_LIMIT)
      event.typeCounts.set(type, 1);
    else {
      // The cap is on distinct labels: a label past it is one omitted name
      // however many records carry it, and the set makes a repeat cheap. The
      // event is tallied once because the limitation counts affected events,
      // not labels or records.
      // Past AUDITD_RETAINED_OMITTED_TYPE_LIMIT a new label is not retained, so
      // the omitted count becomes a floor and the event says so.
      const known = event.omittedTypeLabels.has(type);
      if (
        !known &&
        event.omittedTypeLabels.size < AUDITD_RETAINED_OMITTED_TYPE_LIMIT
      )
        event.omittedTypeLabels.add(type);
      else if (!known && !event.omittedTypeLabelsSaturated) {
        event.omittedTypeLabelsSaturated = true;
        this.#omittedLabelSaturatedEventCount += 1;
      }
      if (!event.typeOmissionCounted) {
        event.typeOmissionCounted = true;
        this.#eventTypeOmittedEventCount += 1;
      }
    }
  }

  #diagnose(line: number, reason: string, excerpt: string): void {
    this.#malformedCount += 1;
    if (this.#malformed.length >= AUDITD_INLINE_DIAGNOSTIC_LIMIT) return;
    // The excerpt is cut on source bytes (one character per byte here), then
    // projected, so it never splits an encoding and reports what the line held.
    const projected = sourceText(excerpt.slice(0, 200));
    this.#malformed.push(
      projected.hex === undefined
        ? { line, reason, excerpt: projected.text }
        : { line, reason, excerpt: projected.text, excerpt_hex: projected.hex },
    );
  }

  #summarize(event: PendingEvent): AuditEventSummary {
    if (event.typeCounts.size > AUDITD_INLINE_EVENT_TYPE_LIMIT)
      this.#typeSampleLimitedEventCount += 1;
    // Records under a type the display list drops travel as the list's omitted
    // count, so a reader can still account for every record. A label passed over
    // the per-event cap is not kept, so `omitted` carries distinct labels only.
    const listed = boundedList(
      sortedCounts(event.typeCounts),
      AUDITD_INLINE_EVENT_TYPE_LIMIT,
      event.omittedTypeLabels.size,
    );
    const node = event.node === undefined ? undefined : sourceText(event.node);
    return {
      event_id: eventId(event),
      node: node?.text ?? null,
      ...(node?.hex === undefined ? {} : { node_hex: node.hex }),
      event_seconds: event.seconds,
      event_millis: event.millis,
      serial: event.serial,
      record_count: event.recordCount,
      record_types: listed.items,
      record_types_omitted: listed.omitted,
      record_types_omitted_exact: !event.omittedTypeLabelsSaturated,
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
  // Read the first line through the same byte-faithful decoding the scanner
  // uses, so recognition and inspection accept the same headers.
  const newline = prefix.indexOf(0x0a);
  const firstLine = decodeHeaderBytes(
    newline < 0 ? prefix : prefix.subarray(0, newline),
  );
  return RECORD_HEADER.test(firstLine);
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
