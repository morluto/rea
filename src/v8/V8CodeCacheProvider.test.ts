import { expect, it } from "vitest";

import {
  MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES,
  MAX_INSPECT_V8_CODE_CACHE_STRINGS,
  MIN_INSPECT_V8_CODE_CACHE_STRING_BYTES,
  inspectV8CodeCacheInputSchema,
} from "../domain/v8/v8CodeCache.js";
import { V8CodeCacheBudgetFailure } from "./V8CodeCache.errors.js";
import {
  observationBudgetRecovery,
  observationBudgetRemediation,
} from "./V8CodeCacheProvider.js";

/**
 * The observation budget has two caller-selected limits, each with a ceiling:
 * `max_strings` tops out at `MAX_INSPECT_V8_CODE_CACHE_STRINGS` and `min_string_bytes`
 * at `MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES`. An admitted file can exceed the
 * budget with both already at their maximum, and then no input change is a legal retry.
 *
 * The recovery is asserted as the decision it is — which retries remain, and whether a
 * smaller artifact is the only option — rather than by matching the advice sentence, so
 * a reworded message cannot break these and wrong advice cannot pass them.
 */
const input = (overrides: Record<string, number> = {}) =>
  inspectV8CodeCacheInputSchema.parse({
    path: "/artifacts/module.jsc",
    ...overrides,
  });

const exhausted = (limit: number) =>
  new V8CodeCacheBudgetFailure("max_strings", limit, "budget exhausted");

it("leaves both retries open while both budgets have headroom", () => {
  // The default `min_string_bytes` is the schema minimum, so lowering it is not an
  // option here; raising either bound is.
  expect(observationBudgetRecovery(exhausted(16), input())).toEqual({
    boundary: "max_strings",
    canRaiseMaxStrings: true,
    canRaiseMinStringBytes: true,
    canLowerMinStringBytes: false,
    requiresSmallerArtifact: false,
  });
});

it("offers no retry when both budgets are already at their ceilings", () => {
  // This is the case the review named: an admitted file with more than 65536 runs of at
  // least 256 bytes reaches the branch, and neither suggested retry is admissible.
  expect(
    observationBudgetRecovery(
      exhausted(MAX_INSPECT_V8_CODE_CACHE_STRINGS),
      input({
        max_strings: MAX_INSPECT_V8_CODE_CACHE_STRINGS,
        min_string_bytes: MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES,
      }),
    ),
  ).toEqual({
    boundary: "max_strings",
    canRaiseMaxStrings: false,
    canRaiseMinStringBytes: false,
    canLowerMinStringBytes: true,
    requiresSmallerArtifact: true,
  });
});

it("drops only the run-length retry when min_string_bytes is at its ceiling", () => {
  expect(
    observationBudgetRecovery(
      exhausted(16),
      input({ min_string_bytes: MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES }),
    ),
  ).toMatchObject({
    canRaiseMaxStrings: true,
    canRaiseMinStringBytes: false,
    requiresSmallerArtifact: false,
  });
});

it("drops only the count retry when max_strings is at its ceiling", () => {
  expect(
    observationBudgetRecovery(
      exhausted(MAX_INSPECT_V8_CODE_CACHE_STRINGS),
      input({ max_strings: MAX_INSPECT_V8_CODE_CACHE_STRINGS }),
    ),
  ).toMatchObject({
    canRaiseMaxStrings: false,
    canRaiseMinStringBytes: true,
    requiresSmallerArtifact: false,
  });
});

it("requires a smaller artifact only when the run length cannot drop", () => {
  expect(
    observationBudgetRecovery(
      new V8CodeCacheBudgetFailure(
        "min_string_bytes",
        4096,
        "budget exhausted",
      ),
      input({ min_string_bytes: MIN_INSPECT_V8_CODE_CACHE_STRING_BYTES }),
    ),
  ).toMatchObject({
    boundary: "min_string_bytes",
    canLowerMinStringBytes: false,
    requiresSmallerArtifact: true,
  });
});

/**
 * The sentence is rendered from the recovery struct, so what it must be held to is that
 * it does not advise a knob the struct closed. Matching the wording would break on a
 * reword without catching wrong advice; asserting the branches catches the advice.
 */
it.each([
  [
    "no retry left",
    exhausted(MAX_INSPECT_V8_CODE_CACHE_STRINGS),
    input({
      max_strings: MAX_INSPECT_V8_CODE_CACHE_STRINGS,
      min_string_bytes: MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES,
    }),
  ],
  [
    "only the run length closed",
    exhausted(16),
    input({ min_string_bytes: MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES }),
  ],
  [
    "only the count closed",
    exhausted(MAX_INSPECT_V8_CODE_CACHE_STRINGS),
    input({ max_strings: MAX_INSPECT_V8_CODE_CACHE_STRINGS }),
  ],
  ["both open", exhausted(16), input()],
] as const)("never advises a closed budget when %s", (_label, cause, input) => {
  const recovery = observationBudgetRecovery(cause, input);
  const advice = observationBudgetRemediation(cause, input);
  if (!recovery.canRaiseMaxStrings)
    expect(advice).not.toMatch(/Raise max_strings/u);
  if (!recovery.canRaiseMinStringBytes)
    expect(advice).not.toMatch(/Raise min_string_bytes/u);
  if (recovery.requiresSmallerArtifact)
    expect(advice).toMatch(/smaller artifact/u);
});
