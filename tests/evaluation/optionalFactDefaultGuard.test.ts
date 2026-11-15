import { expect, it } from "vitest";
import {
  isComparisonOrCountFile,
  optionalFactDefaultCount,
} from "../../scripts/verify/optional-fact-default-guard.mjs";

it("counts property reads defaulted to 0, [] or false in any layout", () => {
  expect(optionalFactDefaultCount("const n = report.count ?? 0;")).toBe(1);
  expect(optionalFactDefaultCount("side?.omitted_fields ?? 0")).toBe(1);
  expect(optionalFactDefaultCount("const xs = result.items ?? [];")).toBe(1);
  expect(optionalFactDefaultCount("flags.complete ?? false")).toBe(1);
  expect(optionalFactDefaultCount("const n =\n  report.count ??\n  0;\n")).toBe(
    1,
  );
  expect(optionalFactDefaultCount("(left.exported_types?.length ?? 0)")).toBe(
    1,
  );
});

it("ignores accumulators, indexed reads and other defaults", () => {
  expect(optionalFactDefaultCount("counts.get(key) ?? 0")).toBe(0);
  expect(optionalFactDefaultCount("bytes[offset] ?? 0")).toBe(0);
  expect(optionalFactDefaultCount("report.count ?? 0.5")).toBe(0);
  expect(optionalFactDefaultCount("report.count ?? 10")).toBe(0);
  expect(optionalFactDefaultCount("report.count ?? null")).toBe(0);
  expect(optionalFactDefaultCount("report.count ?? fallback.count")).toBe(0);
});

it("selects comparison, coverage and count files only", () => {
  expect(isComparisonOrCountFile("src/domain/artifactComparison.ts")).toBe(
    true,
  );
  expect(
    isComparisonOrCountFile("src/domain/process/processCaptureCoverage.ts"),
  ).toBe(true);
  expect(isComparisonOrCountFile("src/domain/evidence.ts")).toBe(false);
});
