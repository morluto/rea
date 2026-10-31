import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * Node's `Promise` constructor calls the executor synchronously and throws a
 * `TypeError` when it is not callable — before any promise object exists. A
 * provable literal that cannot be a function, or a missing argument, is
 * therefore not a promise construction.
 *
 * Measured on Node 24.22.1:
 *
 *   new Promise() / (1) / ("work") / (true) / (null) / (void 0)   -> THREW TypeError
 *   new Promise(1n) / (/re/) / ([]) / ({})                        -> THREW TypeError
 *   new Promise(() => {}) / (function () {}) / (class {})         -> OK Promise
 */
const promisesFor = (source: string) =>
  analyzeJavaScriptSemantics(source).promiseOperations.map(
    ({ kind, method, sourceResolution }) => ({
      kind,
      method,
      sourceResolution,
    }),
  );

it.each([
  ["no argument", `new Promise()`],
  ["a numeric executor", `new Promise(1)`],
  ["a negative numeric executor", `new Promise(-1)`],
  ["a string executor", `new Promise("work")`],
  ["a template-literal executor", "new Promise(`work`)"],
  ["a boolean executor", `new Promise(true)`],
  ["a negated boolean executor", `new Promise(!0)`],
  ["a null executor", `new Promise(null)`],
  ["a void executor", `new Promise(void 1)`],
  ["a BigInt executor", `new Promise(1n)`],
  ["a RegExp executor", `new Promise(/re/)`],
  // Babel stores an overflowing numeric literal as `Infinity`, which is not
  // callable either.
  ["an overflowing numeric executor", `new Promise(1e309)`],
  ["an Infinity executor", `new Promise(Infinity)`],
  ["a NaN executor", `new Promise(NaN)`],
  ["an array executor", `new Promise([])`],
  ["an object executor", `new Promise({})`],
] as const)("emits no promise for %s", (_name, source) => {
  expect(promisesFor(source + ";")).toEqual([]);
});

it.each([
  ["an arrow executor", `new Promise(() => {})`],
  ["an async arrow executor", `new Promise(async () => {})`],
  ["a function expression executor", `new Promise(function () {})`],
  ["a class expression executor", `new Promise(class {})`],
] as const)("keeps the promise for %s", (_name, source) => {
  expect(promisesFor(source + ";")).toHaveLength(1);
});

it("keeps a promise whose executor is an identifier", () => {
  expect(promisesFor(`const p = new Promise(run);`)).toEqual([
    { kind: "constructor", method: "new", sourceResolution: "complete" },
  ]);
});

it("keeps a promise whose executor is a call result", () => {
  expect(promisesFor(`const p = new Promise(makeExecutor());`)).toHaveLength(1);
});

it("keeps a promise whose executor is a spread", () => {
  expect(promisesFor(`const p = new Promise(...list);`)).toHaveLength(1);
});

/**
 * Filtering happens at the candidate-push site rather than inside
 * `promiseCandidateDetails`, which also decides whether `await` becomes an
 * `awaited-expression`. A rejected executor must produce neither fact.
 */
it("emits no awaited-expression task for an awaited rejected executor", () => {
  expect(promisesFor(`async function f() { await new Promise(1); }`)).toEqual(
    [],
  );
});

it("keeps the awaited ownership for a callable executor under await", () => {
  const operations = analyzeJavaScriptSemantics(
    `async function f() { await new Promise(() => {}); }`,
  ).promiseOperations;
  expect(operations).toHaveLength(1);
  expect(operations[0]?.kind).toBe("constructor");
  expect(operations[0]?.ownership).toBe("awaited");
});
