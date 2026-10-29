import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * A timer schedule requires a function in argument 0. Node validates it before
 * creating a handle, so a provable literal that is not a function throws
 * `ERR_INVALID_ARG_TYPE: The "callback" argument must be of type function`
 * synchronously and no timer exists. Only exactly readable literals are decided:
 * an identifier or a call may still be a function at runtime.
 */
const schedulesFor = (call: string) =>
  analyzeJavaScriptSemantics(`function g(fn) { ${call}; }`).timerOperations.map(
    ({ kind, method }) => ({ kind, method }),
  );

it.each([
  ["a string callback", `setTimeout("code", 0)`],
  ["a template-literal callback", "setTimeout(`code`, 0)"],
  ["a numeric callback", `setTimeout(1, 0)`],
  ["a BigInt callback", `setTimeout(1n, 0)`],
  ["a boolean callback", `setTimeout(true, 0)`],
  ["a null callback", `setTimeout(null, 0)`],
  ["a void callback", `setTimeout(void 0, 0)`],
  ["an array callback", `setTimeout([], 0)`],
  ["an object callback", `setTimeout({}, 0)`],
  ["no arguments at all", `setTimeout()`],
  ["a setImmediate string callback", `setImmediate("code")`],
  ["a setInterval string callback", `setInterval("code", 0)`],
] as const)("emits no timer for %s", (_name, call) => {
  expect(schedulesFor(call)).toEqual([]);
});

it.each([
  ["a function expression", `setTimeout(function () {}, 0)`],
  ["an arrow function", `setTimeout(() => {}, 0)`],
  ["an identifier", `setTimeout(fn, 0)`],
  ["an identifier without a delay", `setTimeout(fn)`],
  ["a call result", `setTimeout(select(), 0)`],
  ["a class expression", `setTimeout(class {}, 0)`],
] as const)("keeps the timer for %s", (_name, call) => {
  expect(schedulesFor(call)).toEqual([
    {
      kind: "schedule",
      method: call.startsWith("setImmediate") ? "setImmediate" : "setTimeout",
    },
  ]);
});

it("keeps a cancellation whose handle is a real timer", () => {
  const operations = analyzeJavaScriptSemantics(`
    const handle = setTimeout(() => {}, 10);
    clearTimeout(handle);
  `).timerOperations;
  expect(operations.map(({ kind }) => kind)).toEqual(["schedule", "cancel"]);
  expect(operations[1]?.resolution).toBe("complete");
});
