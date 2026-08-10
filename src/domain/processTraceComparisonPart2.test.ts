import { describe, expect, it } from "vitest";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../contracts/processCaptureExample.js";
import { parseProcessCapture, type ProcessCapture } from "./processCapture.js";
import {
  compareProcessTraces,
  type ProcessTraceSpecification,
} from "./processTraceComparison.js";
const emptyCapture = parseProcessCapture(EMPTY_PROCESS_CAPTURE_EXAMPLE);
const capture = (
  values: Pick<
    ProcessCapture,
    | "frames"
    | "process_samples"
    | "filesystem_checkpoints"
    | "protocol_events"
    | "shim_events"
  > & {
    readonly event_journal: NonNullable<ProcessCapture["event_journal"]>;
  },
  options: {
    readonly truncated?: boolean;
    readonly residualUnknowns?: ProcessCapture["residual_unknowns"];
  } = {},
): ProcessCapture =>
  parseProcessCapture({
    ...emptyCapture,
    frames: values.frames,
    process_samples: values.process_samples,
    filesystem_checkpoints: emptyCapture.filesystem_checkpoints,
    shim_events: values.shim_events,
    protocol_events: values.protocol_events,
    event_journal: [
      {
        capture_order: 0,
        collection: "filesystem_checkpoints",
        index: 0,
      },
      ...values.event_journal.map((entry) => ({
        ...entry,
        capture_order: entry.capture_order + 1,
      })),
      {
        capture_order: values.event_journal.length + 1,
        collection: "lifecycle",
        index: 0,
      },
      {
        capture_order: values.event_journal.length + 2,
        collection: "lifecycle",
        index: 1,
      },
      {
        capture_order: values.event_journal.length + 3,
        collection: "filesystem_checkpoints",
        index: 1,
      },
    ],
    truncated: options.truncated ?? false,
    residual_unknowns: options.residualUnknowns ?? [],
  });
const terminal = { sequence: 0, at_ms: 900, data: "Ready" };
const processStarted = {
  at_ms: 1,
  pid: 1,
  parent_pid: 0,
  command: "worker",
  process_group_id: 1,
  session_id: 1,
};
const http = {
  sequence: 0,
  at_ms: 2,
  protocol: "http" as const,
  direction: "request" as const,
  method: "GET",
  path: "/status",
  data: "",
  outcome: "unmatched" as const,
};
const websocket = {
  sequence: 1,
  at_ms: 3,
  protocol: "websocket" as const,
  direction: "received" as const,
  method: null,
  path: "/ws",
  data: "done",
  outcome: "matched" as const,
};
const values = (
  order: readonly ("terminal" | "process" | "http" | "websocket")[],
): Parameters<typeof capture>[0] => ({
  frames: [terminal],
  process_samples: [processStarted],
  filesystem_checkpoints: [],
  protocol_events: [http, websocket],
  shim_events: [],
  event_journal: order.map((event, captureOrder) => ({
    capture_order: captureOrder,
    collection:
      event === "terminal"
        ? "frames"
        : event === "process"
          ? "process_samples"
          : "protocol_events",
    index: event === "websocket" ? 1 : 0,
  })),
});
const partialSpecification = (): ProcessTraceSpecification => ({
  version: 1,
  events: [
    {
      id: "ready",
      source: "terminal_raw",
      exact: terminal,
      cardinality: { kind: "required" },
    },
    {
      id: "worker",
      source: "process",
      exact: processStarted,
      cardinality: { kind: "required" },
    },
    {
      id: "status",
      source: "http",
      exact: http,
      cardinality: { kind: "required" },
    },
    {
      id: "done",
      source: "websocket",
      exact: websocket,
      cardinality: { kind: "required" },
    },
  ],
  language: {
    kind: "partial_order",
    happens_before: [
      { before: "ready", after: "worker" },
      { before: "ready", after: "status" },
      { before: "worker", after: "done" },
      { before: "status", after: "done" },
    ],
    not_before: [{ event: "done", anchor: "ready" }],
    unordered_groups: [{ events: ["worker", "status"] }],
    prefix: ["ready"],
    suffix: ["done"],
  },
});
describe("process trace comparison", () => {
  it("enforces exact and range cardinality for one repeated predicate", () => {
    const repeated = (count: number) =>
      capture({
        frames: Array.from({ length: count }, (_, sequence) => ({
          sequence,
          at_ms: sequence,
          data: "tick",
        })),
        process_samples: [],
        filesystem_checkpoints: [],
        protocol_events: [],
        shim_events: [],
        event_journal: Array.from({ length: count }, (_, index) => ({
          capture_order: index,
          collection: "frames" as const,
          index,
        })),
      });
    const event: Omit<
      ProcessTraceSpecification["events"][number],
      "cardinality"
    > = {
      id: "tick",
      source: "terminal_raw",
      exact: { data: "tick" },
      ignore_fields: ["sequence", "at_ms"],
    };
    const rangeSpecification: ProcessTraceSpecification = {
      version: 1,
      events: [{ ...event, cardinality: { kind: "range", min: 2, max: 3 } }],
      language: {
        kind: "partial_order",
        happens_before: [],
        not_before: [],
        unordered_groups: [],
        prefix: [],
        suffix: [],
      },
    };
    expect(
      compareProcessTraces(repeated(2), repeated(3), rangeSpecification),
    ).toMatchObject({ verdict: "equivalent" });
    expect(
      compareProcessTraces(repeated(1), repeated(2), rangeSpecification),
    ).toMatchObject({
      verdict: "different",
      diagnostic: { kind: "cardinality", side: "left" },
    });
    expect(
      compareProcessTraces(repeated(2), repeated(4), rangeSpecification),
    ).toMatchObject({
      verdict: "different",
      diagnostic: { kind: "cardinality", side: "right" },
    });
    const exactSpecification: ProcessTraceSpecification = {
      version: 1,
      events: [{ ...event, cardinality: { kind: "exact", count: 2 } }],
      language: {
        kind: "finite_traces",
        variants: [{ id: "two", trace: ["tick", "tick"] }],
      },
    };
    expect(
      compareProcessTraces(repeated(2), repeated(2), exactSpecification),
    ).toMatchObject({ verdict: "equivalent" });
    expect(
      compareProcessTraces(repeated(3), repeated(2), exactSpecification),
    ).toMatchObject({
      verdict: "different",
      diagnostic: { kind: "cardinality", side: "left" },
    });
  });
  it("never proves equivalence from truncated, unknown, or journal-free evidence", () => {
    const complete = capture(
      values(["terminal", "process", "http", "websocket"]),
    );
    const truncated = capture(
      values(["terminal", "process", "http", "websocket"]),
      { truncated: true },
    );
    expect(
      compareProcessTraces(complete, truncated, partialSpecification()).verdict,
    ).toBe("unknown");
    const unknown = capture(
      values(["terminal", "process", "http", "websocket"]),
      { residualUnknowns: [{ scope: "protocol", reason: "gap" }] },
    );
    expect(
      compareProcessTraces(complete, unknown, partialSpecification()).verdict,
    ).toBe("unknown");
    const noJournal = parseProcessCapture({
      ...complete,
      event_journal: [],
    });
    const comparison = compareProcessTraces(
      complete,
      noJournal,
      partialSpecification(),
    );
    expect(comparison).toMatchObject({
      verdict: "unknown",
      diagnostic: { kind: "journal", side: "right" },
    });
    const incompleteJournal = {
      ...complete,
      event_journal: (complete.event_journal ?? []).slice(1),
    };
    expect(() => parseProcessCapture(incompleteJournal)).toThrow(
      "Invalid Process Capture v4: event_journal.0.capture_order",
    );
  });
});
