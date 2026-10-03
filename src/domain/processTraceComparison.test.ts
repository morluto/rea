import { describe, expect, it } from "vitest";
import { parseProcessCapture } from "./processCapture.js";
import {
  compareProcessTraces,
  processTraceComparisonResultSchema,
  type ProcessTraceSpecification,
} from "./processTraceComparison.js";
import {
  capture,
  partialSpecification,
  terminal,
  values,
  websocket,
} from "./processTraceComparison.fixture.js";

describe("process trace comparison: declared schedules", () => {
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
    expect(
      processTraceComparisonResultSchema.safeParse({
        ...comparison,
        right: { ...comparison.right, matched_variant: "invented" },
      }).success,
    ).toBe(false);
  });
  it("enforces explicit negative not-before constraints", () => {
    const specification: ProcessTraceSpecification = {
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
});

describe("process trace comparison: evidence sufficiency", () => {
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
      "Invalid process capture: event_journal.0.capture_order",
    );
  });
});
