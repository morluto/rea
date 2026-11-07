import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

it("keeps optional and non-function listener candidates for unknown emitter APIs", () => {
  const operations = analyzeJavaScriptSemantics(`
    function update(bus) {
      bus.off("x");
      bus.on("x", "named-handler");
    }
  `).eventOperations;
  expect(operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "remove",
        method: "off",
        eventName: "x",
        resolution: "partial",
      }),
      expect.objectContaining({
        kind: "register",
        method: "on",
        eventName: "x",
        resolution: "partial",
      }),
    ]),
  );
});

it("does not emit generic listener candidates for a rejected Node child listener", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", 1);
  `);
  expect(ir.eventOperations).toEqual([]);
  expect(ir.childProcessInteractions).toEqual([]);
});

it.each([
  `ChildProcess.prototype.off = function (event) { return this.removeAllListeners(event); };`,
  `cp.ChildProcess.prototype.off = function (event) { return this.removeAllListeners(event); };`,
])(
  "retains a candidate when ChildProcess prototype is modified: %s",
  (mutation) => {
    const operations = analyzeJavaScriptSemantics(`
    import * as cp from "node:child_process";
    import { spawn, ChildProcess } from "node:child_process";
    ${mutation}
    const child = spawn("worker");
    child.off("exit");
  `).eventOperations;
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "remove",
          method: "off",
          eventName: "exit",
        }),
      ]),
    );
  },
);

it("retains an uncertain child listener interaction when child.on is overridden", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on = function (event) { return this.addListener(event, () => {}); };
    child.on("exit");
  `);
  expect(ir.childProcessInteractions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "listener",
        method: "on",
        eventName: "exit",
        resolution: "partial",
      }),
    ]),
  );
  expect(ir.eventOperations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "register",
        method: "on",
        eventName: "exit",
        resolution: "partial",
      }),
    ]),
  );
});

it.each([
  `e.off = function () {};`,
  `EventEmitter.prototype.off = function () {};`,
])("retains a candidate when emitter behavior is modified: %s", (mutation) => {
  const operations = analyzeJavaScriptSemantics(`
    import { EventEmitter } from "node:events";
    const e = new EventEmitter();
    ${mutation}
    e.off("x");
  `).eventOperations;
  expect(operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "remove",
        method: "off",
        eventName: "x",
      }),
    ]),
  );
});

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

/**
 * Two review findings.
 *
 * Babel stores `1e999` as a `NumericLiteral` holding `Infinity`, which the
 * exact-value reader refuses to price, so the non-finite value was missed:
 *
 *   e.on("x", 1e999)  -> THREW ERR_INVALID_ARG_TYPE
 *
 * A leading spread shifts the runtime argument positions, so argument 1 is not
 * provably the listener:
 *
 *   e.on(...["x", fn], 1)  -> registers fn; the trailing 1 is ignored
 */
it.each([
  ["an overflowing numeric listener", `e.on("x", 1e999)`],
  ["another overflowing numeric listener", `e.on("x", 1e400)`],
] as const)("emits no event operation for %s", (_name, call) => {
  expect(eventsFor(call)).toEqual([]);
});

it.each([
  ["a leading spread", `e.on(...args, 1)`, "on"],
  ["a leading spread with a literal array", `e.on(...["x", fn], 1)`, "on"],
  ["a leading spread on once", `e.once(...args, 0)`, "once"],
] as const)("keeps the event operation for %s", (_name, call, method) => {
  expect(eventsFor(call)).toEqual([
    { kind: "register", method, eventName: null },
  ]);
});
