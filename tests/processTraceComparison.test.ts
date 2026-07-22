import { describe, expect, it } from "vitest";

import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../src/contracts/processCaptureExample.js";
import {
  processCaptureSchema,
  type ProcessCapture,
} from "../src/domain/processCapture.js";
import {
  compareProcessTraces,
  processTraceSpecificationSchema,
  type ProcessTraceSpecification,
} from "../src/domain/processTraceComparison.js";

const emptyCapture = processCaptureSchema.parse(EMPTY_PROCESS_CAPTURE_EXAMPLE);

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
): ProcessCapture => ({
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

describe("process trace specification", () => {
  it("rejects cycles, implicit concurrency, overlap, and unsatisfiable variants", () => {
    const base = partialSpecification();
    expect(
      processTraceSpecificationSchema.safeParse({
        ...base,
        language: {
          kind: "partial_order",
          happens_before: [
            { before: "ready", after: "worker" },
            { before: "worker", after: "ready" },
          ],
          unordered_groups: [{ events: ["status", "done"] }],
        },
      }).success,
    ).toBe(false);
    expect(
      processTraceSpecificationSchema.safeParse({
        version: 1,
        events: base.events.slice(0, 3),
        language: {
          kind: "partial_order",
          happens_before: [{ before: "ready", after: "status" }],
          not_before: [{ event: "worker", anchor: "ready" }],
          unordered_groups: [],
        },
      }).success,
    ).toBe(false);
    expect(
      processTraceSpecificationSchema.safeParse({
        version: 1,
        events: [
          {
            id: "invalid-ignore",
            source: "terminal_raw",
            exact: "ready",
            ignore_fields: ["at_ms"],
          },
        ],
        language: {
          kind: "finite_traces",
          variants: [{ id: "one", trace: ["invalid-ignore"] }],
        },
      }).success,
    ).toBe(false);
    expect(
      processTraceSpecificationSchema.safeParse({
        version: 1,
        events: [
          {
            id: "invalid-ignore",
            source: "terminal_raw",
            exact: terminal,
            ignore_fields: ["at_ms"],
          },
        ],
        language: {
          kind: "finite_traces",
          variants: [{ id: "one", trace: ["invalid-ignore"] }],
        },
      }).success,
    ).toBe(false);
    expect(
      processTraceSpecificationSchema.safeParse({
        version: 1,
        events: base.events.slice(0, 2),
        language: { kind: "partial_order" },
      }).success,
    ).toBe(false);
    expect(
      processTraceSpecificationSchema.safeParse({
        version: 1,
        events: [base.events[0], { ...base.events[0], id: "duplicate" }],
        language: {
          kind: "partial_order",
          unordered_groups: [{ events: ["ready", "duplicate"] }],
        },
      }).success,
    ).toBe(false);
    expect(
      processTraceSpecificationSchema.safeParse({
        version: 1,
        events: [
          {
            ...base.events[0],
            cardinality: { kind: "exact", count: 2 },
          },
        ],
        language: {
          kind: "finite_traces",
          variants: [{ id: "once", trace: ["ready"] }],
        },
      }).success,
    ).toBe(false);
    expect(
      processTraceSpecificationSchema.safeParse({
        version: 1,
        events: [base.events[0]],
        language: {
          kind: "finite_traces",
          variants: [
            { id: "first", trace: ["ready"] },
            { id: "duplicate", trace: ["ready"] },
          ],
        },
      }).success,
    ).toBe(false);
  });
});

describe("process trace comparison", () => {
  it("accepts only explicitly declared concurrent schedules without timestamp causality", () => {
    const left = capture(values(["terminal", "process", "http", "websocket"]));
    const right = capture(values(["terminal", "http", "process", "websocket"]));
    const comparison = compareProcessTraces(
      left,
      right,
      partialSpecification(),
    );

    expect(comparison.verdict).toBe("equivalent");
    expect(comparison.left.raw_trace.map(({ event_id }) => event_id)).toEqual([
      "ready",
      "worker",
      "status",
      "done",
    ]);
    expect(comparison.right.raw_trace.map(({ event_id }) => event_id)).toEqual([
      "ready",
      "status",
      "worker",
      "done",
    ]);
    expect(comparison.left.satisfied_constraints).toContain(
      "unordered:worker:status",
    );
  });

  it("returns the minimal journal slice for a reversed required edge", () => {
    const baseline = capture(
      values(["terminal", "process", "http", "websocket"]),
    );
    const reversed = capture(
      values(["process", "terminal", "http", "websocket"]),
    );
    const comparison = compareProcessTraces(
      baseline,
      reversed,
      partialSpecification(),
    );

    expect(comparison).toMatchObject({
      verdict: "different",
      diagnostic: {
        kind: "edge",
        side: "right",
        event_ids: ["ready", "worker"],
        locations: [{ capture_order: 2 }, { capture_order: 1 }],
      },
    });
  });

  it("enforces explicit negative not-before constraints", () => {
    const specification: ProcessTraceSpecification = {
      version: 1,
      events: [
        {
          id: "ready",
          source: "terminal_raw",
          exact: terminal,
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
        happens_before: [],
        not_before: [{ event: "done", anchor: "ready" }],
        unordered_groups: [],
        prefix: [],
        suffix: [],
      },
    };
    const normal = capture(
      values(["terminal", "process", "http", "websocket"]),
    );
    const invalid = capture(
      values(["websocket", "terminal", "process", "http"]),
    );

    expect(compareProcessTraces(normal, invalid, specification)).toMatchObject({
      verdict: "different",
      diagnostic: {
        kind: "edge",
        side: "right",
        event_ids: ["done", "ready"],
      },
    });
  });

  it("supports declared optional events and bounded duplicates", () => {
    const first = { sequence: 0, at_ms: 1, data: "tick" };
    const second = { sequence: 1, at_ms: 2, data: "tick" };
    const one = capture({
      frames: [first],
      process_samples: [],
      filesystem_checkpoints: [],
      protocol_events: [],
      shim_events: [],
      event_journal: [{ capture_order: 0, collection: "frames", index: 0 }],
    });
    const two = capture({
      frames: [first, second],
      process_samples: [],
      filesystem_checkpoints: [],
      protocol_events: [],
      shim_events: [],
      event_journal: [
        { capture_order: 0, collection: "frames", index: 0 },
        { capture_order: 1, collection: "frames", index: 1 },
      ],
    });
    const specification: ProcessTraceSpecification = {
      version: 1,
      events: [
        {
          id: "tick1",
          source: "terminal_raw",
          exact: first,
          cardinality: { kind: "required" },
        },
        {
          id: "tick2",
          source: "terminal_raw",
          exact: second,
          cardinality: { kind: "optional" },
        },
      ],
      language: {
        kind: "finite_traces",
        variants: [
          { id: "one", trace: ["tick1"] },
          { id: "two", trace: ["tick1", "tick2"] },
        ],
      },
    };

    expect(compareProcessTraces(one, two, specification)).toMatchObject({
      verdict: "equivalent",
      left: { matched_variant: "one" },
      right: { matched_variant: "two" },
    });
  });

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

    const noJournal = { ...complete, event_journal: [] };
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
    expect(() =>
      compareProcessTraces(complete, incompleteJournal, partialSpecification()),
    ).toThrow("Invalid Process Capture v4: event_journal.0.capture_order");
  });
});
