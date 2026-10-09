import { expect, it } from "vitest";

import {
  parseProcessScenario,
  processComparisonContract,
  processScenarioCommitment,
} from "./processScenario.js";

const baseScenario = { executable: "/usr/bin/true" };

it("defaults the finalization interval to zero without changing committed identity", () => {
  const scenario = parseProcessScenario(baseScenario);

  expect(scenario, "parsed scenario carries the default").toMatchObject({
    finalization_ms: 0,
  });
  expect(
    Object.hasOwn(processScenarioCommitment(scenario), "finalization_ms"),
    "full scenario commitment omits a zero interval",
  ).toBe(false);
  expect(
    Object.hasOwn(processComparisonContract(scenario), "finalization_ms"),
    "comparison contract omits a zero interval",
  ).toBe(false);
});

it("commits a positive finalization interval in both identity projections", () => {
  const scenario = parseProcessScenario({
    ...baseScenario,
    finalization_ms: 500,
  });

  expect(
    processScenarioCommitment(scenario),
    "full scenario commitment records the interval",
  ).toMatchObject({ finalization_ms: 500 });
  expect(
    processComparisonContract(scenario),
    "comparison contract records the interval",
  ).toMatchObject({ finalization_ms: 500 });
});

it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects the finalization interval %j",
  (finalization_ms) => {
    expect(() =>
      parseProcessScenario({ ...baseScenario, finalization_ms }),
    ).toThrow();
  },
);
