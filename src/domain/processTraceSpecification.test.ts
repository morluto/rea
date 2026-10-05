import { describe, expect, it } from "vitest";
import {
  processTraceSpecificationSchema,
  type ProcessTraceSpecification,
} from "./processTraceComparison.js";

const ready = { sequence: 0, at_ms: 10, data: "ready" };
const worker = {
  at_ms: 20,
  pid: 1,
  parent_pid: 0,
  command: "worker",
  process_group_id: 1,
  session_id: 1,
};
const specification = (): ProcessTraceSpecification => ({
  events: [
    {
      id: "ready",
      source: "terminal_raw",
      exact: ready,
      cardinality: { kind: "required" },
    },
    {
      id: "worker",
      source: "process",
      exact: worker,
      cardinality: { kind: "required" },
    },
  ],
  language: {
    kind: "partial_order",
    happens_before: [{ before: "ready", after: "worker" }],
    not_before: [],
    unordered_groups: [],
    prefix: ["ready"],
    suffix: ["worker"],
  },
});

describe("process trace specification", () => {
  it("rejects cycles, implicit ordering gaps, invalid ignores, and unsatisfiable variants", () => {
    const base = specification();
    expect(
      processTraceSpecificationSchema.safeParse({
        ...base,
        language: {
          kind: "partial_order",
          happens_before: [
            { before: "ready", after: "worker" },
            { before: "worker", after: "ready" },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      processTraceSpecificationSchema.safeParse({
        ...base,
        language: { kind: "partial_order" },
      }).success,
    ).toBe(false);
    expect(
      processTraceSpecificationSchema.safeParse({
        events: [
          {
            id: "bad",
            source: "terminal_raw",
            exact: "ready",
            ignore_fields: ["at_ms"],
          },
        ],
        language: {
          kind: "finite_traces",
          variants: [{ id: "one", trace: ["bad"] }],
        },
      }).success,
    ).toBe(false);
    expect(
      processTraceSpecificationSchema.safeParse({
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
  });
});
