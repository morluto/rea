import { expect, it } from "vitest";

import {
  MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES,
  MAX_INSPECT_V8_CODE_CACHE_STRINGS,
  inspectV8CodeCacheInputSchema,
} from "../domain/v8/v8CodeCache.js";
import { V8CodeCacheBudgetFailure } from "./V8CodeCache.errors.js";
import { observationBudgetRemediation } from "./V8CodeCacheProvider.js";

/**
 * The observation budget has two caller-selected limits, and each has a ceiling:
 * `max_strings` tops out at `MAX_INSPECT_V8_CODE_CACHE_STRINGS` and `min_string_bytes`
 * at `MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES`. An admitted file can exceed the
 * budget with both already at their maximum, in which case neither of the old
 * suggestions was a legal retry.
 */
const input = (overrides: Record<string, number> = {}) =>
  inspectV8CodeCacheInputSchema.parse({
    path: "/artifacts/module.jsc",
    ...overrides,
  });

const exhausted = (limit: number) =>
  new V8CodeCacheBudgetFailure("max_strings", limit, "budget exhausted");

it("suggests both budgets while both still have headroom", () => {
  const remediation = observationBudgetRemediation(exhausted(16), input());
  expect(remediation).toContain("Raise max_strings");
  expect(remediation).toContain("raise min_string_bytes");
});

it("does not suggest raising min_string_bytes at its ceiling", () => {
  const remediation = observationBudgetRemediation(
    exhausted(16),
    input({ min_string_bytes: MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES }),
  );
  expect(remediation).toContain("Raise max_strings");
  expect(remediation).not.toContain("raise min_string_bytes above");
  expect(remediation).toContain("ceiling");
});

it("does not suggest raising max_strings at its ceiling", () => {
  const remediation = observationBudgetRemediation(
    exhausted(MAX_INSPECT_V8_CODE_CACHE_STRINGS),
    input({ max_strings: MAX_INSPECT_V8_CODE_CACHE_STRINGS }),
  );
  expect(remediation).not.toContain("Raise max_strings above");
  expect(remediation).toContain("Raise min_string_bytes above");
  expect(remediation).toContain("ceiling");
});

it("offers no retry when both budgets are already at their ceilings", () => {
  // This is the case the review named: an admitted file with more than 65536 runs of
  // at least 256 bytes reaches this branch, and neither suggested retry is valid.
  const remediation = observationBudgetRemediation(
    exhausted(MAX_INSPECT_V8_CODE_CACHE_STRINGS),
    input({
      max_strings: MAX_INSPECT_V8_CODE_CACHE_STRINGS,
      min_string_bytes: MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES,
    }),
  );
  expect(remediation).not.toContain("Raise max_strings above");
  expect(remediation).not.toContain("raise min_string_bytes above");
  expect(remediation).toContain("select a smaller artifact");
});

it("keeps the run-length direction for the other boundary", () => {
  const remediation = observationBudgetRemediation(
    new V8CodeCacheBudgetFailure("min_string_bytes", 4096, "budget exhausted"),
    input(),
  );
  expect(remediation).toContain("Lower min_string_bytes");
});
