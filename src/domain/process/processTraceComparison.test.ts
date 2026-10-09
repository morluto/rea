import { describe, expect, it } from "vitest";
import { parseProcessCapture } from "./processCaptureParsing.js";
import { type ProcessTraceSpecification } from "./processTraceSpecification.js";
import { processTraceComparisonResultSchema } from "./processTraceEvaluation.js";
import {
  capture,
  partialSpecification,
  processStarted,
  terminal,
  values,
} from "./processTraceComparison.fixture.js";

import { compareProcessTraces } from "./processTraceComparison.js";
describe("generic capture trace comparison", () => {
  it("requires explicit partial ordering and never infers causality from timestamps", () => {
    const specification = partialSpecification();
    const left = capture(values(["terminal", "process"]));
    const right = capture(values(["process", "terminal"]));
    expect(compareProcessTraces(left, right, specification)).toMatchObject({
      verdict: "different",
      diagnostic: { kind: "edge", side: "right" },
    });

    const concurrent: ProcessTraceSpecification = {
      ...specification,
      language: {
        kind: "partial_order",
        happens_before: [],
        not_before: [],
        unordered_groups: [{ events: ["ready", "worker"] }],
        prefix: [],
        suffix: [],
      },
    };
    expect(compareProcessTraces(left, right, concurrent)).toMatchObject({
      verdict: "equivalent",
    });
  });

  it("rejects malformed result contracts", () => {
    const result = compareProcessTraces(
      capture(values(["terminal", "process"])),
      capture(values(["terminal", "process"])),
      partialSpecification(),
    );
    expect(
      processTraceComparisonResultSchema.safeParse({
        ...result,
        right: {
          ...result.right,
          status: "fail",
          matched_variant: "invented",
        },
      }).success,
    ).toBe(false);
  });

  it("supports declared optional events and bounded duplicates", () => {
    const first = { sequence: 0, at_ms: 1, data: "tick" };
    const second = { sequence: 1, at_ms: 2, data: "tick" };
    const one = capture({
      frames: [first],
      process_samples: [],
      event_journal: [{ collection: "frames", index: 0 }],
    });
    const two = capture({
      frames: [first, second],
      process_samples: [],
      event_journal: [
        { collection: "frames", index: 0 },
        { collection: "frames", index: 1 },
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

describe("process trace constraints and evidence sufficiency", () => {
  it("enforces exact and range cardinality for a repeated terminal observation", () => {
    const repeated = (count: number) =>
      capture({
        frames: Array.from({ length: count }, (_, sequence) => ({
          sequence,
          at_ms: sequence,
          data: "tick",
        })),
        process_samples: [],
        event_journal: Array.from({ length: count }, (_, index) => ({
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

  it("enforces an explicit not-before relation between terminal and process events", () => {
    const specification: ProcessTraceSpecification = {
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
      ],
      language: {
        kind: "partial_order",
        happens_before: [],
        not_before: [{ event: "ready", anchor: "worker" }],
        unordered_groups: [],
        prefix: [],
        suffix: [],
      },
    };
    const readyFirst = capture(values(["terminal", "process"]));
    const workerFirst = capture(values(["process", "terminal"]));

    expect(
      compareProcessTraces(workerFirst, readyFirst, specification),
    ).toMatchObject({
      verdict: "different",
      diagnostic: {
        kind: "edge",
        side: "right",
        event_ids: ["ready", "worker"],
      },
    });
    expect(
      compareProcessTraces(workerFirst, workerFirst, specification),
    ).toMatchObject({ verdict: "equivalent" });
  });
});

describe("unknown process trace evidence", () => {
  it("never proves equivalence from truncated, unknown, or journal-free evidence", () => {
    const complete = capture(values(["terminal", "process"]));
    const truncated = capture(values(["terminal", "process"]), {
      omittedTerminalFrame: true,
    });
    expect(
      compareProcessTraces(complete, truncated, partialSpecification()).verdict,
    ).toBe("unknown");
    const unknown = capture(values(["terminal", "process"]), {
      residualUnknowns: [{ scope: "process", reason: "sampled" }],
    });
    expect(
      compareProcessTraces(complete, unknown, partialSpecification()).verdict,
    ).toBe("unknown");
    expect(
      compareProcessTraces(complete, unknown, partialSpecification()),
    ).toMatchObject({
      verdict: "unknown",
      right: {
        status: "unknown",
        matched_variant: null,
        satisfied_constraints: [],
        raw_trace: [{ event_id: "ready" }, { event_id: "worker" }],
      },
    });
    const noJournal = parseProcessCapture({ ...complete, event_journal: [] });
    expect(
      compareProcessTraces(complete, noJournal, partialSpecification()),
    ).toMatchObject({
      verdict: "unknown",
      diagnostic: { kind: "journal", side: "right" },
    });

    expect(() =>
      parseProcessCapture({
        ...complete,
        event_journal: complete.event_journal.slice(1),
      }),
    ).toThrow("event_journal");
  });
});
