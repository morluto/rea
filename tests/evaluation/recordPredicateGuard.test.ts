import { expect, it } from "vitest";
import { recordPredicateCounts } from "../../scripts/verify/record-predicate-guard.mjs";

it("counts both function forms and does not depend on the parameter name", () => {
  const predicate =
    'typeof input === "object" && input !== null && !Array.isArray(input)';
  expect(
    recordPredicateCounts(`function isObject(input) { return ${predicate}; }`)
      .bodies,
  ).toBe(1);
  expect(
    recordPredicateCounts(`const isObject = (input) => ${predicate};`).bodies,
  ).toBe(1);
  expect(
    recordPredicateCounts(
      `const a = (input) => ${predicate}; const b = (input) => ${predicate};`,
    ).bodies,
  ).toBe(2);
});
