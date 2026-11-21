import { expect, it } from "vitest";

import type { JavaScriptApplicationGraph } from "./javascriptApplicationGraph.js";
import { reconciliationInputCoverage } from "./javascriptRuntimeReconciliationGraph.js";

const status = (input: Input) => reconciliationInputCoverage(input).status;

type Input = Parameters<typeof reconciliationInputCoverage>[0];
type Coverage = JavaScriptApplicationGraph["coverage"];

// Only the coverage facts the reading consumes; the rest of a parsed layer or
// capture does not affect it.
const layer = (coverage: Coverage): Input["layers"][number] =>
  ({ graph: { coverage } }) as unknown as Input["layers"][number];
const capture = (
  status: "complete_within_window" | "attach_limited" | "truncated",
): Input["captures"][number] =>
  ({
    inspection: {
      completeness: {
        status,
        conditions: [status],
        attach_limited_sections: status === "attach_limited" ? ["scripts"] : [],
        unavailable_sections: [],
      },
    },
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
    status({
      layers: [layer(complete)],
      captures: [capture("complete_within_window")],
    }),
  ).toBe("complete");
  expect(
    status({
      layers: [layer(complete)],
      captures: [capture("attach_limited")],
    }),
  ).toBe("partial");
  expect(
    status({
      layers: [layer(complete)],
      captures: [capture("truncated")],
    }),
  ).toBe("truncated");
});

it.each(["unknown", "unavailable"] as const)(
  "reads a %s static graph as unknown and keeps a truncated capture's truncation",
  (graphStatus) => {
    expect(
      reconciliationInputCoverage({
        layers: [layer(complete), layer(unknown(graphStatus))],
        captures: [capture("truncated")],
      }),
    ).toMatchObject({
      status: "unknown",
      truncated: true,
      captureOmissions: { known: false },
    });
  },
);
