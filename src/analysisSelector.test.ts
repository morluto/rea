import { AnalysisInputError } from "./domain/analysisErrorCore.js";
import { expect, it } from "vitest";
import { resolveCliAnalysisSelector } from "./cli/analysisSelector.js";

it.each([
  ["0x1a", "0x1A"],
  ["0x100", "0x0100"],
  ["ram%2f:0X0001A", "ram%2F:0x1a"],
  ["0x20000000000001", "0x020000000000001"],
])(
  "admits equivalent coordinates while preserving the named input: %s / %s",
  (left, right) => {
    expect(
      resolveCliAnalysisSelector(left, right, "address", "xrefs", "native"),
    ).toBe(right);
  },
);

it.each([
  ["ram:0x1", "RAM:0x1"],
  ["0x1", "ram:0x1"],
  ["symbol", "Symbol"],
  ["0x1", "0x2"],
  ["0xinvalid", "0XINVALID"],
])("preserves distinct or unknown identities: %s / %s", (left, right) => {
  expect(() =>
    resolveCliAnalysisSelector(left, right, "address", "xrefs", "native"),
  ).toThrow(AnalysisInputError);
});

it("keeps text selectors exact even when they look like addresses", () => {
  expect(() =>
    resolveCliAnalysisSelector("0x1a", "0x1A", "pattern", "search_strings"),
  ).toThrow(AnalysisInputError);
});
