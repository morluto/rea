import { expect, it } from "vitest";

import type { JavaScriptApplicationGraph } from "./javascriptApplicationGraph.js";
import { reconciliationInputStatus } from "./javascriptRuntimeReconciliationGraph.js";

type Input = Parameters<typeof reconciliationInputStatus>[0];
type Coverage = JavaScriptApplicationGraph["coverage"];

// Only the coverage facts the reading consumes; the rest of a parsed layer or
// capture does not affect it.
const layer = (coverage: Coverage): Input["layers"][number] =>
  ({ graph: { coverage } }) as unknown as Input["layers"][number];
const capture = (
  status: "complete_within_window" | "attach_limited" | "truncated",
): Input["captures"][number] =>
  ({
    inspection: { completeness: { status, conditions: [status] } },
  }) as unknown as Input["captures"][number];

const complete: Coverage = {
  status: "complete",
  truncated: false,
  omitted_count: 0,
  limits: [],
};
const unknown = (status: "unknown" | "unavailable"): Coverage => ({
  status,
  truncated: false,
  omitted_count: null,
  limits: [],
});

it("reads complete inputs as complete and a limited capture as a known gap", () => {
  expect(
    reconciliationInputStatus({
      layers: [layer(complete)],
      captures: [capture("complete_within_window")],
    }),
  ).toBe("complete");
  expect(
    reconciliationInputStatus({
      layers: [layer(complete)],
      captures: [capture("attach_limited")],
    }),
  ).toBe("partial");
  expect(
    reconciliationInputStatus({
      layers: [layer(complete)],
      captures: [capture("truncated")],
    }),
  ).toBe("truncated");
});

it.each(["unknown", "unavailable"] as const)(
  "reads a %s static graph as unknown, even beside a truncated capture",
  (status) => {
    expect(
      reconciliationInputStatus({
        layers: [layer(complete), layer(unknown(status))],
        captures: [capture("truncated")],
      }),
    ).toBe("unknown");
  },
);
