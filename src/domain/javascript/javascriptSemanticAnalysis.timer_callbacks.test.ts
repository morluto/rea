import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * A schedule imported from Node's `timers` module requires a function in
 * argument 0. Node validates it before creating a handle, so a provable literal
 * that is not a function throws `ERR_INVALID_ARG_TYPE: The "callback" argument
 * must be of type function` synchronously and no timer exists.
 *
 * Only exactly readable literals are decided: an identifier or a call may still
 * be a function at runtime.
 */
const nodeTimersCalls = (call: string) =>
  analyzeJavaScriptSemantics(
    `import { setTimeout, setInterval, setImmediate } from "node:timers"; function g(fn) { ${call}; }`,
  ).timerOperations.map(({ kind, method }) => ({ kind, method }));

/** A bare global timer may belong to a browser, where a string is evaluated. */
const globalTimerCalls = (call: string) =>
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
] as const)("emits no node timers schedule for %s", (_name, call) => {
  expect(nodeTimersCalls(call)).toEqual([]);
});

it.each([
  ["a function expression", `setTimeout(function () {}, 0)`, "setTimeout"],
  ["an arrow function", `setTimeout(() => {}, 0)`, "setTimeout"],
  ["an identifier", `setTimeout(fn, 0)`, "setTimeout"],
  ["an identifier without a delay", `setTimeout(fn)`, "setTimeout"],
  ["a call result", `setTimeout(select(), 0)`, "setTimeout"],
  ["a class expression", `setTimeout(class {}, 0)`, "setTimeout"],
  ["a resolved setImmediate", `setImmediate(fn)`, "setImmediate"],
  ["a resolved setInterval", `setInterval(fn, 10)`, "setInterval"],
] as const)("keeps the node timers schedule for %s", (_name, call, method) => {
  expect(nodeTimersCalls(call)).toEqual([{ kind: "schedule", method }]);
});

/**
 * Browser and Electron renderer sources reach this analysis without a
 * Node/browser distinction, and there a string callback is evaluated by the
 * host. A bare global timer therefore keeps its schedule whatever the argument.
 */
it.each([
  ["a string callback", `setTimeout("code", 0)`],
  ["a string setInterval callback", `setInterval("code", 0)`],
  ["a null callback", `setTimeout(null, 0)`],
] as const)("keeps the bare global timer for %s", (_name, call) => {
  expect(globalTimerCalls(call)).toHaveLength(1);
});

it("keeps a cancellation whose handle is a real timer", () => {
  const operations = analyzeJavaScriptSemantics(`
    import { setTimeout } from "node:timers";
    const handle = setTimeout(() => {}, 10);
    clearTimeout(handle);
  `).timerOperations;
  expect(operations.map(({ kind }) => kind)).toEqual(["schedule", "cancel"]);
  expect(operations[1]?.resolution).toBe("complete");
});
