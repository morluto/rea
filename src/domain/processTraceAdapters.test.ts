import { describe, expect, it } from "vitest";

import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../contracts/processCaptureExample.js";
import {
  compareProcessCaptures,
  parseProcessCapture,
} from "./processCapture.js";
import type { ProcessTraceSpecification } from "./processTraceComparison.js";
const beforeCheckpoint = {
  name: "before",
  at_ms: 0,
  files: [],
  effects: [],
  truncated: false,
};
const afterCheckpoint = {
  name: "after_settlement",
  at_ms: 50,
  files: [],
  effects: [],
  truncated: false,
};

const capture = {
  ...EMPTY_PROCESS_CAPTURE_EXAMPLE,
  event_journal: [
    { capture_order: 0, collection: "filesystem_checkpoints", index: 0 },
    { capture_order: 1, collection: "lifecycle", index: 0 },
    { capture_order: 2, collection: "lifecycle", index: 1 },
    { capture_order: 3, collection: "filesystem_checkpoints", index: 1 },
  ],
} as const;

const traceSpecification: ProcessTraceSpecification = {
  version: 1,
  events: [
    {
      id: "before",
      source: "filesystem",
      exact: beforeCheckpoint,
      cardinality: { kind: "required" },
    },
    {
      id: "exit",
      source: "lifecycle",
      exact: { event: "exit", ...capture.exit },
      cardinality: { kind: "required" },
    },
    {
      id: "settlement",
      source: "lifecycle",
      exact: { event: "settlement", ...capture.settlement },
      cardinality: { kind: "required" },
    },
    {
      id: "after",
      source: "filesystem",
      exact: afterCheckpoint,
      cardinality: { kind: "required" },
    },
  ],
  language: {
    kind: "finite_traces",
    variants: [
      {
        id: "normal",
        trace: ["before", "exit", "settlement", "after"],
      },
    ],
  },
};

describe("declared trace comparison adapters", () => {
  it("treats only explicitly ignored schedule metadata as reorderable", () => {
    const httpPayload = {
      protocol: "http" as const,
      direction: "request" as const,
      method: "GET",
      path: "/status",
      data: "",
      outcome: "unmatched" as const,
    };
    const websocketPayload = {
      protocol: "websocket" as const,
      direction: "received" as const,
      method: null,
      path: "/ws",
      data: "done",
      outcome: "matched" as const,
    };
    const scheduledCapture = (order: "http-first" | "websocket-first") => {
      const protocolEvents =
        order === "http-first"
          ? [
              { sequence: 0, at_ms: 1, ...httpPayload },
              { sequence: 1, at_ms: 2, ...websocketPayload },
            ]
          : [
              { sequence: 0, at_ms: 1, ...websocketPayload },
              { sequence: 1, at_ms: 2, ...httpPayload },
            ];
      return parseProcessCapture({
        ...capture,
        protocol_events: protocolEvents,
        event_journal: [
          {
            capture_order: 0,
            collection: "filesystem_checkpoints",
            index: 0,
          },
          { capture_order: 1, collection: "protocol_events", index: 0 },
          { capture_order: 2, collection: "protocol_events", index: 1 },
          { capture_order: 3, collection: "lifecycle", index: 0 },
          { capture_order: 4, collection: "lifecycle", index: 1 },
          {
            capture_order: 5,
            collection: "filesystem_checkpoints",
            index: 1,
          },
        ],
      });
    };
    const specification: ProcessTraceSpecification = {
      version: 1,
      events: [
        {
          id: "status",
          source: "http",
          exact: httpPayload,
          ignore_fields: ["sequence", "at_ms"],
          cardinality: { kind: "required" },
        },
        {
          id: "done",
          source: "websocket",
          exact: websocketPayload,
          ignore_fields: ["sequence", "at_ms"],
          cardinality: { kind: "required" },
        },
      ],
      language: {
        kind: "partial_order",
        happens_before: [],
        not_before: [],
        unordered_groups: [{ events: ["status", "done"] }],
        prefix: [],
        suffix: [],
      },
    };

    expect(
      compareProcessCaptures(
        scheduledCapture("http-first"),
        scheduledCapture("websocket-first"),
        { traceSpecification: specification },
      ),
    ).toMatchObject({
      status: "unchanged",
      protocol: "unchanged",
      trace: {
        verdict: "equivalent",
        left: { raw_trace: [{ event_id: "status" }, { event_id: "done" }] },
        right: { raw_trace: [{ event_id: "done" }, { event_id: "status" }] },
      },
    });
  });
});

describe("declared trace comparison coverage", () => {
  it("does not mask an unselected source in a covered legacy dimension", () => {
    const http = {
      sequence: 0,
      at_ms: 1,
      protocol: "http" as const,
      direction: "request" as const,
      method: "GET",
      path: "/status",
      data: "",
      outcome: "unmatched" as const,
    };
    const websocket = (data: string) => ({
      sequence: 1,
      at_ms: 2,
      protocol: "websocket" as const,
      direction: "received" as const,
      method: null,
      path: "/ws",
      data,
      outcome: "matched" as const,
    });
    const withProtocol = (data: string) =>
      parseProcessCapture({
        ...capture,
        protocol_events: [http, websocket(data)],
        event_journal: [
          {
            capture_order: 0,
            collection: "filesystem_checkpoints",
            index: 0,
          },
          { capture_order: 1, collection: "protocol_events", index: 0 },
          { capture_order: 2, collection: "protocol_events", index: 1 },
          { capture_order: 3, collection: "lifecycle", index: 0 },
          { capture_order: 4, collection: "lifecycle", index: 1 },
          {
            capture_order: 5,
            collection: "filesystem_checkpoints",
            index: 1,
          },
        ],
      });
    const specification: ProcessTraceSpecification = {
      version: 1,
      events: [
        {
          id: "status",
          source: "http",
          exact: http,
          cardinality: { kind: "required" },
        },
      ],
      language: {
        kind: "finite_traces",
        variants: [{ id: "status", trace: ["status"] }],
      },
    };

    expect(
      compareProcessCaptures(withProtocol("left"), withProtocol("right"), {
        traceSpecification: specification,
      }),
    ).toMatchObject({
      status: "changed",
      protocol: "changed",
      trace: { verdict: "equivalent" },
    });
  });
});

describe("declared trace comparison nonconformance", () => {
  it("does not call identical captures changed when both violate the language", () => {
    const parsedCapture = parseProcessCapture(capture);
    const specification: ProcessTraceSpecification = {
      ...traceSpecification,
      language: {
        kind: "finite_traces",
        variants: [
          {
            id: "reversed",
            trace: ["after", "settlement", "exit", "before"],
          },
        ],
      },
    };

    expect(
      compareProcessCaptures(parsedCapture, parsedCapture, {
        traceSpecification: specification,
      }),
    ).toMatchObject({
      status: "unchanged",
      trace: { verdict: "nonconforming" },
    });
  });

  it("does not mask distinct payloads when both traces are nonconforming", () => {
    const withTerminal = (data: string) =>
      parseProcessCapture({
        ...capture,
        frames: [{ sequence: 0, at_ms: 1, data }],
        event_journal: [
          {
            capture_order: 0,
            collection: "filesystem_checkpoints",
            index: 0,
          },
          { capture_order: 1, collection: "frames", index: 0 },
          { capture_order: 2, collection: "lifecycle", index: 0 },
          { capture_order: 3, collection: "lifecycle", index: 1 },
          {
            capture_order: 4,
            collection: "filesystem_checkpoints",
            index: 1,
          },
        ],
      });
    const specification: ProcessTraceSpecification = {
      version: 1,
      events: [
        {
          id: "expected",
          source: "terminal_raw",
          exact: { sequence: 0, at_ms: 1, data: "expected" },
          cardinality: { kind: "required" },
        },
      ],
      language: {
        kind: "finite_traces",
        variants: [{ id: "expected", trace: ["expected"] }],
      },
    };

    expect(
      compareProcessCaptures(withTerminal("left"), withTerminal("right"), {
        traceSpecification: specification,
      }),
    ).toMatchObject({
      status: "changed",
      terminal: "changed",
      trace: { verdict: "nonconforming" },
    });
  });
});
