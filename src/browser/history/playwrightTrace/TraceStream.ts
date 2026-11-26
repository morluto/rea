import { decodeStrictUtf8 } from "../../../domain/strictUtf8.js";
import { getHeapStatistics } from "node:v8";
import { recordedJsonNumber } from "../../../domain/exactJsonNumber.js";
import { LosslessNumber } from "lossless-json";
import type {
  ArtifactEntry,
  ArtifactReader,
} from "../../../resources/index.js";
import {
  AnalysisResourceConstraintError,
  unsupportedTarget,
} from "../../../domain/analysisErrorCore.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../../../domain/parseFailureAnalysisError.js";
import {
  PLAYWRIGHT_TRACE_OPERATION,
  playwrightTraceLimitRecovery,
  type PlaywrightTraceLimits,
  type TraceMember,
  type TraceStream,
  type TraceEvent,
} from "../../../domain/playwrightTrace/playwrightTrace.js";
import { captureObject } from "../CaptureRedaction.js";
import {
  CAPTURE_FORMAT,
  CAPTURE_LIMITS,
  CaptureFormatError,
} from "../CaptureFormatError.js";
import {
  parseCaptureJsonForRetainedTypes,
  type SelectiveCaptureJsonResult,
} from "../CaptureJson.js";
import { TraceInventory, traceIdentity } from "./TraceInventory.js";
import { traceLines, type TraceLineBudget } from "./TraceLines.js";
import { projectTraceEvent } from "./TraceEventProjection.js";

const RETAINED_TRACE_TYPES: ReadonlySet<string> = new Set([
  "context-options",
  "before",
  "after",
  "console",
  "resource-snapshot",
  "screencast-frame",
]);

const text = (value: unknown) => (typeof value === "string" ? value : null);
const number = (value: unknown) =>
  value instanceof LosslessNumber ? recordedJsonNumber(value.value) : null;

const ensureTraceHeapHeadroom = (
  inputBytes: number,
  multiplier: number,
): void => {
  const required = 32 * 1024 * 1024 + inputBytes * multiplier;
  if (required > getHeapStatistics().total_available_size)
    throw new AnalysisResourceConstraintError(
      PLAYWRIGHT_TRACE_OPERATION,
      "memory",
      "Insufficient heap headroom for trace record expansion.",
      { input_bytes: inputBytes, required_headroom_bytes: required },
      { measuredExhaustion: true },
    );
};

const readRecord = (
  bytes: Buffer,
  limits: PlaywrightTraceLimits,
): SelectiveCaptureJsonResult => {
  ensureTraceHeapHeadroom(bytes.length, 4);
  let value: string;
  try {
    value = decodeStrictUtf8(bytes, "preserve");
  } catch (cause) {
    throw new CaptureFormatError(
      "malformed",
      "Trace line is not valid UTF-8.",
      "",
      cause,
    );
  }
  return parseCaptureJsonForRetainedTypes(
    value,
    "Playwright trace",
    RETAINED_TRACE_TYPES,
    {
      // Each parser node is charged against a share of the retained facts.
      maximumNodes: Math.floor(limits.facts_bytes / 256),
      maximumDepth: limits.nesting_depth,
      beforeMaterialize: () => ensureTraceHeapHeadroom(bytes.length, 64),
    },
  );
};

const hasPartialHeadline = (event: TraceEvent): boolean =>
  (event.kind === "network" &&
    (event.method === null || event.url === null || event.status === null)) ||
  (event.kind === "console" && event.text === null) ||
  (event.kind === "action-before" && event.method === null) ||
  (event.kind === "screenshot" && event.resource_references.length === 0);

interface TraceStreamInput {
  readonly inventory: TraceInventory;
  readonly reader: ArtifactReader;
  readonly entry: ArtifactEntry;
  readonly member: TraceMember;
  readonly budget: TraceLineBudget;
  readonly profileKnown: boolean;
  readonly signal?: AbortSignal;
}

/** A member's facts remain provisional until its ZIP stream verifies CRC and size. */
class TraceStreamRead {
  readonly stream: TraceStream;
  readonly pending: TraceEvent[] = [];
  readonly diagnostics: { line: number; code: string; message: string }[] = [];
  readonly omitted = new Map<string, number>();
  #headerSeen = false;
  constructor(readonly input: TraceStreamInput) {
    const { member, profileKnown } = input;
    this.stream = {
      stream_id: traceIdentity("trace_stream", member.member_id),
      member_id: member.member_id,
      role: member.path.endsWith(".network") ? "network" : "trace",
      version: profileKnown ? 10 : null,
      state: profileKnown ? "supported" : "unknown",
      lines: 0,
      supported_events: 0,
      omitted_event_types: [],
      producer: null,
    };
  }
  diagnostic(line: number, code: string, message: string): void {
    this.input.inventory.reserve(1024);
    this.diagnostics.push({ line, code, message });
  }
  header(raw: unknown, line: number): void {
    const { inventory } = this.input;
    this.#headerSeen = true;
    if (!captureObject(raw) || raw.type !== "context-options") {
      this.diagnostic(
        line,
        "missing-context-header",
        "A trace member has no initial context-options record; its event version stays unknown.",
      );
      return;
    }
    const version = number(raw.version);
    if (version !== null && version !== 10)
      throw unsupportedTarget(
        PLAYWRIGHT_TRACE_OPERATION,
        inventory.artifact.path,
        "playwright-trace",
        "Only Playwright trace version 10 is supported.",
      );
    if (version !== 10) {
      this.diagnostic(
        line,
        "unknown-version",
        "The context header does not declare numeric trace version 10.",
      );
      return;
    }
    this.stream.version = 10;
    this.stream.state = "supported";
    this.stream.producer = {
      playwright_version: text(raw.playwrightVersion),
      browser_name: text(raw.browserName),
      origin: text(raw.origin),
    };
    inventory.retain(this.stream.producer);
  }
  record(line: { line: number; bytes: Buffer }): void {
    const { inventory, member } = this.input;
    let parsed: SelectiveCaptureJsonResult;
    try {
      parsed = readRecord(line.bytes, inventory.limits);
    } catch (cause) {
      if (!(cause instanceof CaptureFormatError)) throw cause;
      if (isParseLimit(cause, CAPTURE_FORMAT)) {
        const { name, maximum } = cause.failure.limit;
        if (name !== "nesting-depth" && name !== "parser-nodes") throw cause;
        const nesting = name === "nesting-depth";
        // Parser nodes are derived from facts_bytes, so that field recovers them.
        throw parseLimitConstraint(
          PLAYWRIGHT_TRACE_OPERATION,
          "memory",
          cause,
          {
            reportedLimitContext: {
              [nesting ? "nesting_levels" : "parser_nodes"]: maximum,
            },
            ...playwrightTraceLimitRecovery(
              nesting ? "nesting_depth" : "facts_bytes",
              inventory.limits,
            ),
          },
        );
      }
      this.diagnostic(line.line, "malformed-record", cause.message);
      this.#headerSeen = true;
      return;
    }
    if (parsed.kind === "skipped") {
      if (this.stream.role === "trace" && !this.#headerSeen) {
        this.#headerSeen = true;
        this.diagnostic(
          line.line,
          "missing-context-header",
          "A trace member has no initial context-options record; its event version stays unknown.",
        );
        return;
      }
      if (!this.omitted.has(parsed.type))
        inventory.reserve(512 + parsed.type.length * 12);
      this.omitted.set(parsed.type, (this.omitted.get(parsed.type) ?? 0) + 1);
      return;
    }
    const raw = parsed.value;
    if (this.stream.role === "trace" && !this.#headerSeen) {
      this.header(raw, line.line);
      return;
    }
    if (!captureObject(raw) || typeof raw.type !== "string") {
      this.diagnostic(
        line.line,
        "malformed-record",
        "An event must be an object with a type string.",
      );
      return;
    }
    if (raw.type === "context-options") {
      this.stream.state = "unknown";
      this.diagnostic(
        line.line,
        "duplicate-context-header",
        "Repeated context headers make the remaining stream version unknown; later events are not interpreted.",
      );
      return;
    }
    let event: TraceEvent | undefined;
    try {
      event = projectTraceEvent(raw, {
        event_id: traceIdentity("trace_event", [member.member_id, line.line]),
        stream_id: this.stream.stream_id,
        ordinal: line.line - 1,
        source: {
          member_id: member.member_id,
          line: line.line,
          record_pointer: raw.type === "resource-snapshot" ? "/snapshot" : "",
        },
      });
    } catch (cause) {
      if (!(cause instanceof CaptureFormatError)) throw cause;
      this.diagnostic(line.line, "malformed-record", cause.message);
      return;
    }
    if (event !== undefined) {
      inventory.reserve(event.resource_references.length * 512);
      inventory.retain(event);
      this.pending.push(event);
      const partial = hasPartialHeadline(event);
      if (partial)
        this.diagnostic(
          line.line,
          "partial-event",
          "Selected headline fields are unavailable; known facts remain retained without assuming absent values.",
        );
      return;
    }
    if (!this.omitted.has(raw.type))
      inventory.reserve(512 + raw.type.length * 12);
    this.omitted.set(raw.type, (this.omitted.get(raw.type) ?? 0) + 1);
    if (
      [
        "before",
        "after",
        "console",
        "resource-snapshot",
        "screencast-frame",
      ].includes(raw.type)
    )
      this.diagnostic(
        line.line,
        "malformed-event",
        "A supported event is missing its required payload identity.",
      );
  }
  async read(): Promise<TraceStream> {
    const { inventory, reader, entry, member, budget, signal } = this.input;
    if (entry.kind !== "file" || entry.encrypted) {
      this.stream.state = "unavailable";
      inventory.diagnostic(
        member,
        null,
        "unavailable-stream",
        "A selected stream is encrypted or is not a regular archive member.",
      );
      return this.stream;
    }
    const content = await reader.open(entry, signal);
    for await (const line of traceLines(content, budget, signal)) {
      this.stream.lines = line.line;
      if (line.bytes.length === 0) continue;
      if (this.stream.role === "network" && this.stream.state !== "supported")
        continue;
      if (
        this.stream.role === "trace" &&
        this.#headerSeen &&
        this.stream.state !== "supported"
      )
        continue;
      this.record(line);
    }
    member.decoded = true;
    if (this.stream.version === null)
      inventory.diagnostic(
        member,
        null,
        "unknown-stream-version",
        "This stream has no unambiguous v10 trace profile; its events were not interpreted.",
      );
    for (const diagnostic of this.diagnostics)
      inventory.diagnostic(
        member,
        diagnostic.line,
        diagnostic.code,
        diagnostic.message,
      );
    this.stream.supported_events = this.pending.length;
    this.stream.omitted_event_types = Array.from(
      this.omitted,
      ([type, count]) => ({ type, count }),
    );
    inventory.retain(this.stream);
    for (const event of this.pending) inventory.events.push(event);
    return this.stream;
  }
}

export const readTraceStream = (input: TraceStreamInput) =>
  new TraceStreamRead(input).read();
