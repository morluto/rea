import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const nodeTimersCalls = (call: string) =>
  analyzeJavaScriptSemantics(
    `import { setTimeout, setInterval, setImmediate } from "node:timers"; function g(fn) { ${call}; }`,
  ).timerOperations.map(({ kind, method }) => ({ kind, method }));

it.each([
  ["a BigInt setTimeout delay", `setTimeout(() => {}, 1n)`],
  ["a Symbol setTimeout delay", `setTimeout(() => {}, Symbol("delay"))`],
  ["a BigInt setInterval delay", `setInterval(() => {}, 1n)`],
  ["a Symbol setInterval delay", `setInterval(() => {}, Symbol("delay"))`],
] as const)("emits no node timers schedule for %s", (_name, call) => {
  expect(nodeTimersCalls(call)).toEqual([]);
});

it.each([
  ["a numeric delay", `setTimeout(() => {}, 10)`, "setTimeout"],
  ["a string delay", `setTimeout(() => {}, "10")`, "setTimeout"],
  ["a null delay", `setTimeout(() => {}, null)`, "setTimeout"],
  ["no delay at all", `setTimeout(() => {})`, "setTimeout"],
  [
    "a setImmediate with BigInt argument",
    `setImmediate(() => {}, 1n)`,
    "setImmediate",
  ],
] as const)("keeps the node timers schedule for %s", (_name, call, method) => {
  expect(nodeTimersCalls(call)).toEqual([{ kind: "schedule", method }]);
});

it("does not link cancellation to a timer rejected for invalid delay", () => {
  const operations = analyzeJavaScriptSemantics(`
    import { setTimeout, clearTimeout } from "node:timers";
    const handle = setTimeout(() => {}, 1n);
    clearTimeout(handle);
  `).timerOperations;

  expect(operations).toMatchObject([
    {
      kind: "cancel",
      linkedTimerId: null,
      resolution: "unresolved",
    },
  ]);
});
