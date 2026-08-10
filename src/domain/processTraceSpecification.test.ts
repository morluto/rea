import { describe, expect, it } from "vitest";
import {
  processTraceSpecificationSchema,
  type ProcessTraceSpecification,
} from "./processTraceComparison.js";
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
