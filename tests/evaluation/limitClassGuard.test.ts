import { expect, it } from "vitest";
import { localLimitErrorClassCount } from "../../scripts/verify/limit-class-guard.mjs";

it("counts plain-Error limit classes in every layout", () => {
  expect(
    localLimitErrorClassCount("class ProbeLimitFailure extends Error {}"),
  ).toBe(1);
  expect(
    localLimitErrorClassCount(
      "export class ProbeBudgetError<T> extends Error {}",
    ),
  ).toBe(1);
  expect(
    localLimitErrorClassCount(
      "class ProbeExhausted<T extends Map<string, number>>\n  extends Error {}",
    ),
  ).toBe(1);
  expect(
    localLimitErrorClassCount("class ProbeExceeded\n  extends Error {}"),
  ).toBe(1);
});

it("ignores classes on the shared owners and unrelated names", () => {
  expect(
    localLimitErrorClassCount(
      'class ProbeLimit extends ParseFailureError<"limit"> {}',
    ),
  ).toBe(0);
  expect(localLimitErrorClassCount("class ProbeFailure extends Error {}")).toBe(
    0,
  );
  expect(
    localLimitErrorClassCount("class ProbeLimit extends ErrorBase {}"),
  ).toBe(0);
});
