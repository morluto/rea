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

it("does not emit child listener interactions for a direct spawn call with a rejected listener", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    spawn("worker").on("exit", 1);
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
  ["a leading spread on once", `e.once(...args, 0)`, "once"],
] as const)("keeps the event operation for %s", (_name, call, method) => {
  expect(eventsFor(call)).toEqual([
    { kind: "register", method, eventName: null },
  ]);
});

it("keeps the event operation and resolves event name for a leading spread with a literal array", () => {
  expect(eventsFor(`e.on(...["x", fn], 1)`)).toEqual([
    { kind: "register", method: "on", eventName: "x" },
  ]);
});

it.each([
  ["a short-circuiting logical OR non-function", `true || handler`],
  ["a short-circuiting logical AND non-function", `false && handler`],
  ["a constant conditional non-function consequent", `true ? 1 : handler`],
  ["a constant conditional non-function alternate", `false ? handler : 1`],
  ["a constant nullish coalescing non-nullish primitive", `1 ?? handler`],
  ["a constant nullish coalescing NaN", `NaN ?? handler`],
  ["a constant nullish coalescing Infinity", `Infinity ?? handler`],
  ["a RegExp literal short-circuiting logical OR", `/x/ || handler`],
  ["a positive numeric unary short-circuiting logical OR", `+1 || handler`],
  [
    "an unknown logical AND short-circuiting to a non-function",
    `maybeHandler && 1`,
  ],
])(
  "prunes statically unreachable listener branches on child process: %s",
  (_name, expr) => {
    const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", ${expr});
  `);
    expect(ir.childProcessInteractions).toEqual([]);
    expect(ir.eventOperations).toEqual([]);
  },
);

it.each([
  ["a reachable logical OR function branch", `false || handler`],
  ["a reachable logical AND function branch", `true && handler`],
  ["a reachable conditional function consequent", `true ? handler : 1`],
  ["a reachable conditional function alternate", `false ? 1 : handler`],
  ["a reachable nullish coalescing default function", `null ?? handler`],
])(
  "retains reachable callable listener branches on child process: %s",
  (_name, expr) => {
    const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", ${expr});
  `);
    expect(ir.childProcessInteractions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "listener",
          method: "on",
          eventName: "exit",
        }),
      ]),
    );
  },
);

it("does not emit event operations for an unshadowed process emitter with a rejected listener", () => {
  const ir = analyzeJavaScriptSemantics(`
    process.on("exit", 1);
  `);
  expect(ir.eventOperations).toEqual([]);
});

it("keeps valid listener operations on unshadowed global process", () => {
  const ir = analyzeJavaScriptSemantics(`
    process.on("exit", () => {});
  `);
  expect(ir.eventOperations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "register",
        method: "on",
        eventName: "exit",
      }),
    ]),
  );
});

it("retains an uncertain candidate if global process listener methods are overridden", () => {
  const ir = analyzeJavaScriptSemantics(`
    process.on = function (event) { return this.addListener(event, () => {}); };
    process.on("exit", 1);
  `);
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

it("retains an uncertain candidate if global process escapes to unknown code", () => {
  const ir = analyzeJavaScriptSemantics(`
    function customize(p) { p.on = () => {}; }
    customize(process);
    process.on("exit", 1);
  `);
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

it("does not emit event operations for an imported process emitter with a rejected listener", () => {
  const ir = analyzeJavaScriptSemantics(`
    import proc from "node:process";
    proc.on("exit", 1);
  `);
  expect(ir.eventOperations).toEqual([]);
});

it("keeps valid listener operations on an imported process emitter", () => {
  const ir = analyzeJavaScriptSemantics(`
    import proc from "node:process";
    proc.on("exit", () => {});
  `);
  expect(ir.eventOperations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "register",
        method: "on",
        eventName: "exit",
      }),
    ]),
  );
});

it("retains an uncertain candidate if an imported process emitter escapes to unknown code", () => {
  const ir = analyzeJavaScriptSemantics(`
    import proc from "node:process";
    function customize(p) { p.on = () => {}; }
    customize(proc);
    proc.on("exit", 1);
  `);
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

it("does not emit child listener interactions for a mutable child binding without reassignment", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    let child = spawn("worker");
    child.on("exit", 1);
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("retains partial candidate after reassignment of a child binding", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    let child = spawn("worker");
    child = custom;
    child.on("exit", 1);
  `);
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

it("retains partial candidates when child_process namespace escapes to an opaque helper", () => {
  const ir = analyzeJavaScriptSemantics(`
    import * as cp from "node:child_process";
    import { spawn } from "node:child_process";
    function wrap(pkg) { pkg.ChildProcess.prototype.on = () => {}; }
    wrap(cp);
    const child = spawn("worker");
    child.on("exit", 1);
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

it("retains partial candidate when direct eval may replace a mutable child receiver", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    function register(custom) {
      let child = spawn("worker");
      eval("child = custom");
      child.on("exit", 1);
    }
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

it("does not emit child listener interactions for an immutable alias to a spawn call", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    const alias = child;
    alias.on("exit", 1);
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("retains partial candidate when direct eval changes a listener method through an immutable alias", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    const alias = child;
    eval("alias.on = function () {}");
    alias.on("exit", 1);
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
  ["an empty array spread", `...[]`],
  ["a nested empty array spread", `...[...[]]`],
  ["a spread of a non-callable number", `...[1]`],
])("does not emit child listener interaction for %s", (_name, expr) => {
  const ir = analyzeJavaScriptSemantics(`
      import { spawn } from "node:child_process";
      const child = spawn("worker");
      child.on("exit", ${expr});
    `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("retains child listener interaction when spread provides a callable function", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", ...[() => {}]);
  `);
  expect(ir.childProcessInteractions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "listener",
        method: "on",
        eventName: "exit",
        resolution: "complete",
      }),
    ]),
  );
  expect(ir.eventOperations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "register",
        method: "on",
        eventName: "exit",
        resolution: "complete",
      }),
    ]),
  );
});

it.each([
  ["trailing argument after empty spread", `...[], () => {}`],
  ["nested empty spread before callable", `...[...[], () => {}]`],
])("retains valid listener across empty spreads: %s", (_name, args) => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", ${args});
  `);
  expect(ir.childProcessInteractions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "listener",
        method: "on",
        eventName: "exit",
        resolution: "complete",
      }),
    ]),
  );
  expect(ir.eventOperations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "register",
        method: "on",
        eventName: "exit",
        resolution: "complete",
      }),
    ]),
  );
});

it("retains imported timer when empty spread precedes callback", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { setTimeout } from "node:timers";
    setTimeout(...[], () => {});
  `);
  expect(ir.timerOperations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "schedule",
        method: "setTimeout",
      }),
    ]),
  );
});

it("drops child listener when delete expression short-circuits nullish coalescing", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const obj = {};
    const child = spawn("worker");
    child.on("exit", (delete obj.value) ?? handler);
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("drops child listener when non-empty template literal short-circuits logical OR", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", \`not-a-listener\` || handler);
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("retains child listener when template literal evaluates to empty string via escaped line break", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", \`\\\n\` || (() => {}));
  `);
  expect(ir.childProcessInteractions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "listener",
        method: "on",
        eventName: "exit",
        resolution: "complete",
      }),
    ]),
  );
  expect(ir.eventOperations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "register",
        method: "on",
        eventName: "exit",
        resolution: "complete",
      }),
    ]),
  );
});

it("retains candidate and records resource limit when nested spreads exceed depth limit", () => {
  let expr = "1";
  for (let i = 0; i < 260; i++) {
    expr = `[...${expr}]`;
  }
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", ...${expr});
  `);
  expect(ir.coverage.resourceLimits ?? []).toContain("expression-depth");
  expect(ir.childProcessInteractions.length).toBeGreaterThan(0);
});

it("drops child listener when template literal short-circuits nullish coalescing", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", \`bad\` ?? handler);
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("drops child listener and event operation when leading spread resolves to invalid listener", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on(...["exit", 1]);
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("retains child listener and event operation when leading spread resolves to valid listener", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on(...["exit", () => {}]);
  `);
  expect(ir.childProcessInteractions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "listener",
        method: "on",
        eventName: "exit",
        resolution: "complete",
      }),
    ]),
  );
  expect(ir.eventOperations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "register",
        method: "on",
        eventName: "exit",
        resolution: "complete",
      }),
    ]),
  );
});

it("retains candidate when Array.prototype[Symbol.iterator] has changed", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    Array.prototype[Symbol.iterator] = function* () {
      yield "exit";
      yield () => {};
    };
    const child = spawn("worker");
    child.on(...["exit", 1]);
  `);
  expect(ir.childProcessInteractions.length).toBeGreaterThan(0);
  expect(ir.eventOperations.length).toBeGreaterThan(0);
});

it("drops child listener and event operation for a dynamic import expression", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", import("node:fs"));
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("iteratively follows emitter alias chains and bounds traversal at resource limit", () => {
  const chain = Array.from({ length: 10 }, (_, i) =>
    i === 0 ? "const a0 = spawn('worker');" : `const a${i} = a${i - 1};`,
  ).join("\n");
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    ${chain}
    a9.on("exit", 1);
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("drops rejected listener for EventEmitter constructed via namespace import", () => {
  const ir = analyzeJavaScriptSemantics(`
    import * as events from "node:events";
    const e = new events.EventEmitter();
    e.on("ready", 1);
  `);
  expect(ir.eventOperations).toEqual([]);
});

it("drops rejected listener for EventEmitter constructed via default import", () => {
  const ir = analyzeJavaScriptSemantics(`
    import events from "node:events";
    const e = new events.EventEmitter();
    e.on("ready", 1);
  `);
  expect(ir.eventOperations).toEqual([]);
});

it("retains candidate for EventEmitter when namespace import escapes", () => {
  const ir = analyzeJavaScriptSemantics(`
    import * as events from "node:events";
    opaqueHelper(events);
    const e = new events.EventEmitter();
    e.on("ready", 1);
  `);
  expect(ir.eventOperations.length).toBeGreaterThan(0);
});

it("iteratively evaluates truthiness for deep chains of logical NOT without recursion", () => {
  const nots = "!".repeat(50);
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", ${nots}true ? 1 : () => {});
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("preserves candidate when chain of logical NOT exceeds expression depth limit", () => {
  const nots = "!".repeat(300);
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", ${nots}true ? 1 : () => {});
  `);
  expect(ir.childProcessInteractions.length).toBeGreaterThan(0);
  expect(ir.eventOperations.length).toBeGreaterThan(0);
});

it("efficiently indexes bindings across many local declarations and rejected listeners", () => {
  const localDecls = Array.from(
    { length: 50 },
    (_, i) => `const local_${i} = ${i};`,
  ).join("\n");
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    import * as events from "node:events";
    ${localDecls}
    const child = spawn("worker");
    const e = new events.EventEmitter();
    child.on("exit", 1);
    child.on("error", "not-a-fn");
    e.on("ready", 42);
    process.on("exit", false);
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("retains candidates when pre-indexed relevant binding escapes despite many local declarations", () => {
  const localDecls = Array.from(
    { length: 50 },
    (_, i) => `const local_${i} = ${i};`,
  ).join("\n");
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    import * as events from "node:events";
    ${localDecls}
    opaqueHelper(events);
    const e = new events.EventEmitter();
    e.on("ready", 42);
  `);
  expect(ir.eventOperations.length).toBeGreaterThan(0);
});

it("efficiently indexes required module effects across many unrelated export writes and rejected listeners", () => {
  const unrelatedWrites = Array.from(
    { length: 50 },
    (_, i) => `cp.extraMethod_${i} = function() {};`,
  ).join("\n");
  const ir = analyzeJavaScriptSemantics(`
    const cp = require("node:child_process");
    ${unrelatedWrites}
    const child = cp.spawn("worker");
    child.on("exit", 1);
    child.on("error", "not-a-fn");
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("retains candidates when pre-indexed required module effect overrides prototype despite many unrelated export writes", () => {
  const unrelatedWrites = Array.from(
    { length: 50 },
    (_, i) => `cp.extraMethod_${i} = function() {};`,
  ).join("\n");
  const ir = analyzeJavaScriptSemantics(`
    const cp = require("node:child_process");
    ${unrelatedWrites}
    cp.ChildProcess.prototype.off = function (event) { return this.removeAllListeners(event); };
    const child = cp.spawn("worker");
    child.on("exit", 1);
  `);
  expect(ir.childProcessInteractions.length).toBeGreaterThan(0);
});

it("prunes non-nullish binary and update results before exploring ?? fallback", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", (1 + 1) ?? (() => {}));
    child.on("error", (a === b) ?? (() => {}));
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("rejects provably non-thenable primitive await results", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", await 1);
    child.on("error", await "not-a-fn");
    child.on("close", await (1 + 1));
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("retains candidates when await target is a callable or dynamic expression", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", await (() => {}));
    child.on("error", await getHandlerPromise());
  `);
  expect(ir.childProcessInteractions.length).toBeGreaterThan(0);
  expect(ir.eventOperations.length).toBeGreaterThan(0);
});

it("propagates non-nullishness through conditional results when exploring ?? fallback", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", (flag ? 1 : 2) ?? (() => {}));
    child.on("error", (flag ? "bad" : "also-bad") ?? (() => {}));
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("retains candidates when conditional branch in ?? left operand may be nullish", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", (flag ? 1 : null) ?? (() => {}));
  `);
  expect(ir.childProcessInteractions.length).toBeGreaterThan(0);
  expect(ir.eventOperations.length).toBeGreaterThan(0);
});

it("rejects optional chains whose base is statically nullish", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", null?.handler);
    child.on("error", undefined?.handler);
    child.on("close", null?.a.b);
    child.on("disconnect", undefined?.());
    child.on("message", (flag ? null : undefined)?.handler);
  `);
  expect(ir.childProcessInteractions).toEqual([]);
  expect(ir.eventOperations).toEqual([]);
});

it("retains candidates when optional chain base is unknown or potentially callable", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", opts?.handler);
    child.on("error", getHandlers()?.onError);
  `);
  expect(ir.childProcessInteractions.length).toBeGreaterThan(0);
  expect(ir.eventOperations.length).toBeGreaterThan(0);
});

it("resolves nullish optional chains in ?? fallback operands", () => {
  const ir = analyzeJavaScriptSemantics(`
    import { spawn } from "node:child_process";
    const child = spawn("worker");
    child.on("exit", (null?.handler) ?? (() => {}));
  `);
  expect(ir.childProcessInteractions.length).toBeGreaterThan(0);
  expect(ir.eventOperations.length).toBeGreaterThan(0);
});
