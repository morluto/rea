import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * A listener must be a function, and Node throws `ERR_INVALID_ARG_TYPE` before
 * anything is registered or removed when it is not.
 *
 * Measured on Node 24.22.1:
 *
 *   emitter.on(1)                    -> THREW ERR_INVALID_ARG_TYPE
 *   emitter.on("x", 1)               -> THREW ERR_INVALID_ARG_TYPE
 *   emitter.on("x", null)            -> THREW ERR_INVALID_ARG_TYPE
 *   emitter.on("x", true)            -> THREW ERR_INVALID_ARG_TYPE
 *   emitter.on("x", {} / [])         -> THREW ERR_INVALID_ARG_TYPE
 *   emitter.once / addListener /
 *   prependListener / prependOnceListener / off / removeListener, same
 *   emitter.on("x", () => {})        -> ok
 *   emitter.on("x", function () {})  -> ok
 */
const eventsFor = (call: string) =>
  analyzeJavaScriptSemantics(
    `import { EventEmitter } from "node:events";\nconst e = new EventEmitter();\nfunction g(fn, args) { ${call}; }`,
  ).eventOperations.map(({ kind, method, eventName }) => ({
    kind,
    method,
    eventName,
  }));

it.each([
  ["a numeric listener", `e.on("x", 1)`],
  ["a string listener", `e.on("x", "fn")`],
  ["a template-literal listener", 'e.on("x", `fn`)'],
  ["a boolean listener", `e.on("x", true)`],
  ["a null listener", `e.on("x", null)`],
  ["a void listener", `e.on("x", void 0)`],
  ["a BigInt listener", `e.on("x", 0n)`],
  ["a RegExp listener", `e.on("x", /re/)`],
  ["an object listener", `e.on("x", {})`],
  ["an array listener", `e.on("x", [])`],
  ["a once numeric listener", `e.once("x", 1)`],
  ["an addListener numeric listener", `e.addListener("x", 1)`],
  ["a prependListener numeric listener", `e.prependListener("x", 1)`],
  ["a prependOnceListener numeric listener", `e.prependOnceListener("x", 1)`],
  ["a removeListener numeric listener", `e.removeListener("x", 1)`],
  ["an off numeric listener", `e.off("x", 1)`],
] as const)("emits no event operation for %s", (_name, call) => {
  expect(eventsFor(call)).toEqual([]);
});

it.each([
  ["an arrow listener", `e.on("x", () => {})`, "on"],
  ["a function-expression listener", `e.on("x", function () {})`, "on"],
  ["a class-expression listener", `e.on("x", class {})`, "on"],
  ["an identifier listener", `e.on("x", fn)`, "on"],
  ["a call-result listener", `e.on("x", make())`, "on"],
  ["a spread listener", `e.on("x", ...listeners)`, "on"],
  ["an once arrow listener", `e.once("x", () => {})`, "once"],
  [
    "a removeListener identifier",
    `e.removeListener("x", fn)`,
    "removeListener",
  ],
] as const)("keeps the event operation for %s", (_name, call, method) => {
  expect(eventsFor(call)).toEqual([
    { kind: expect.any(String) as unknown as string, method, eventName: "x" },
  ]);
});

/**
 * `emit` passes its remaining arguments to listeners that already exist, so it
 * does not validate them the way a registration does.
 */
it("keeps an emit with a literal payload", () => {
  expect(eventsFor(`e.emit("x", 1)`)).toEqual([
    { kind: "dispatch", method: "emit", eventName: "x" },
  ]);
});

/** `removeAllListeners` takes only an optional event name, never a listener. */
it("keeps removeAllListeners with a literal event name", () => {
  expect(eventsFor(`e.removeAllListeners("x")`)).toEqual([
    { kind: "remove", method: "removeAllListeners", eventName: "x" },
  ]);
});
