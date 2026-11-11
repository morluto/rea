import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { analyzeCommonJsSemanticFixture } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";

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

const eventsForSource = (
  source: string,
  analyze = analyzeJavaScriptSemantics,
) =>
  analyze(source).eventOperations.map(({ kind, method, eventName }) => ({
    kind,
    method,
    eventName,
  }));

const eventsForCommonJsSource = (source: string) =>
  eventsForSource(source, analyzeCommonJsSemanticFixture);

it.each([
  ["a missing on listener", `e.on("x")`],
  ["a missing once listener", `e.once("x")`],
  ["a missing addListener listener", `e.addListener("x")`],
  ["a missing prependListener listener", `e.prependListener("x")`],
  ["a missing prependOnceListener listener", `e.prependOnceListener("x")`],
  ["a missing removeListener listener", `e.removeListener("x")`],
  ["a missing off listener", `e.off("x")`],
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
 * A listener method called without a listener argument passes `undefined` to
 * Node's `checkListener`, which throws before anything is registered or
 * removed. The argument position is empty, so no function can arrive there.
 *
 * Measured on Node 22.23.3:
 *
 *   emitter.on()                     -> THREW ERR_INVALID_ARG_TYPE
 *   emitter.on("x")                  -> THREW ERR_INVALID_ARG_TYPE
 *   emitter.once("x")                -> THREW ERR_INVALID_ARG_TYPE
 *   emitter.addListener("x")         -> THREW ERR_INVALID_ARG_TYPE
 *   emitter.prependListener("x")     -> THREW ERR_INVALID_ARG_TYPE
 *   emitter.prependOnceListener("x") -> THREW ERR_INVALID_ARG_TYPE
 *   emitter.removeListener("x")      -> THREW ERR_INVALID_ARG_TYPE
 *   emitter.off("x") / emitter.off() -> THREW ERR_INVALID_ARG_TYPE
 *
 * A spread still reaches the position through the call, so it is untouched.
 */
it.each([
  ["a missing listener", `e.on("x")`],
  ["a missing once listener", `e.once("x")`],
  ["a missing addListener listener", `e.addListener("x")`],
  ["a missing prependListener listener", `e.prependListener("x")`],
  ["a missing prependOnceListener listener", `e.prependOnceListener("x")`],
  ["a missing removeListener listener", `e.removeListener("x")`],
  ["a missing off listener", `e.off("x")`],
  ["no arguments at all", `e.on()`],
  ["no off arguments at all", `e.off()`],
] as const)("emits no event operation for %s", (_name, call) => {
  expect(eventsFor(call)).toEqual([]);
});

it("keeps the event operation for a spread call with no fixed listener", () => {
  expect(eventsFor(`e.on(...pairs)`)).toEqual([
    {
      kind: expect.any(String) as unknown as string,
      method: "on",
      eventName: null,
    },
  ]);
});

it.each([
  [
    "a named import",
    `import { EventEmitter } from "node:events";`,
    "EventEmitter",
  ],
  ["a default import", `import EE from "node:events";`, "EE"],
] as const)(
  "drops a missing listener on a receiver built from %s",
  (_name, header, constructor) => {
    expect(
      eventsForSource(`${header}
const e = new ${constructor}();
e.on("x");`),
    ).toEqual([]);
  },
);

/** Unknown hosts retain candidates; only the CommonJS wrapper proves require. */
it.each([
  [
    "a destructured require",
    `const { EventEmitter } = require("events");`,
    "EventEmitter",
  ],
  [
    "a member require",
    `const events = require("node:events");`,
    "events.EventEmitter",
  ],
] as const)(
  "requires CommonJS authority to reject a missing listener from %s",
  (_name, header, constructor) => {
    const source = `${header}
const e = new (${constructor})();
e.on("x");`;
    expect(eventsForSource(source)).toContainEqual({
      kind: "register",
      method: "on",
      eventName: "x",
    });
    expect(eventsForCommonJsSource(source)).toEqual([]);
  },
);

it("keeps an ESM receiver when a candidate loader may replace its prototype", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const e = new EventEmitter();
require("node:events").EventEmitter.prototype.on = replacement;
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

it("keeps a missing listener when the receiver was reassigned", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const e = new EventEmitter();
e = other;
e.on("x");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "x" });
});

/**
 * `checkListener` is Node's own contract. An EventEmitter-style receiver that
 * this module does not construct from `events.EventEmitter` may define a
 * one-argument form: Socket.IO's `socket.off("x")` removes every listener for
 * the event, so the operation must survive as an unresolved candidate.
 */
it("keeps a one-argument removal on a receiver with no proven Node emitter", () => {
  expect(
    eventsForSource(`function g(socket) { socket.off("x"); }`),
  ).toContainEqual({ kind: "remove", method: "off", eventName: "x" });
});

/**
 * A subclass may default the listener position, which makes `bus.on("ready")`
 * a real registration even though the module never proves Node's rejection.
 * Measured on Node 22.23.3: this class stores `"ready"` and does not throw.
 */
it("keeps the registration of a subclass that defaults its listener", () => {
  const events = eventsForSource(
    `import { EventEmitter } from "node:events";
class Bus extends EventEmitter {
  on(name, fn = () => {}) { return super.on(name, fn); }
}
const bus = new Bus();
bus.on("ready");`,
  );
  expect(events).toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it.each([
  ["extra.EventEmitter", "extra", "{ EventEmitter: Bus }"],
  ["extra.deep.EventEmitter", "extra", "{ deep: { EventEmitter: Bus } }"],
  ["default.EventEmitter", "default", "{ EventEmitter: Bus }"],
] as const)(
  "keeps custom nested events exports as candidates: %s",
  (selected, changed, replacement) => {
    for (const listener of ["", ", () => {}"]) {
      expect(
        eventsForSource(`import A from "events";
import B from "node:events";
import { Bus } from "./bus.js";
A.${changed} = ${replacement};
const e = new B.${selected}();
e.on("ready"${listener});`),
      ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
    }
  },
);

it("still rejects a canonical class through a namespace default export", () => {
  expect(
    eventsForSource(`import * as events from "node:events";
const e = new events.default.EventEmitter();
e.on("ready");`),
  ).toEqual([]);
});

/**
 * A member write replaces the method the native contract belongs to. Measured
 * on Node 22.23.3: `e.on = (name, fn = () => {}) => ...` stores `"ready"`, so
 * `checkListener` never runs and the one-argument call is a real registration.
 */
it("keeps the registration of a receiver whose method was replaced", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const e = new EventEmitter();
e.on = (name, fn = () => {}) => EventEmitter.prototype.on.call(e, name, fn);
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/**
 * Every instance shares the constructor's prototype, so replacing the method
 * there replaces it for this receiver too.
 */
it("keeps the registration of a receiver whose prototype was replaced", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
EventEmitter.prototype.on = function (name, fn = () => {}) { return this; };
const e = new EventEmitter();
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/**
 * The proof is keyed on the selected method, so a write to an unrelated member
 * must not weaken it: `tag` never answers `on`.
 */
it("still rejects a missing listener beside an unrelated member write", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const e = new EventEmitter();
e.tag = 1;
e.on("ready");`),
  ).toEqual([]);
});

/**
 * A namespace import constructs the class through a member expression, so the
 * constructor has no binding of its own and the prototype write is recorded
 * against the module instead. Measured on Node 22.22.2: rewriting `on` to
 * delegate to the `addListener` captured before the rewrite stores `"ready"`
 * for a one-argument call. Delegating to `this.addListener` instead overflows
 * the stack, because Node defines `addListener` as the same function as `on`.
 */
it("keeps the registration of a receiver built from a namespace member", () => {
  expect(
    eventsForSource(`import * as events from "node:events";
const original = events.EventEmitter.prototype.addListener;
const e = new events.EventEmitter();
events.EventEmitter.prototype.on = function (name, fn = () => {}) { return original.call(this, name, fn); };
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/** A member require reaches the same class through the same member expression. */
it("keeps the registration of a receiver built from a member require", () => {
  expect(
    eventsForCommonJsSource(`const events = require("node:events");
const original = events.EventEmitter.prototype.addListener;
const e = new events.EventEmitter();
events.EventEmitter.prototype.on = function (name, fn = () => {}) { return original.call(this, name, fn); };
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/**
 * Handing the instance to another call lets that call replace the method.
 * Measured on Node 22.22.2: `configure(e)` replaces `on` with a form that
 * defaults the listener, so `e.on("ready")` registers.
 */
it("keeps the registration of a receiver that was passed to a call", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const e = new EventEmitter();
function configure(target) {
  target.on = (name, fn = () => {}) => target.addListener(name, fn);
}
configure(e);
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

it.each([
  ["inline", "", "process.getBuiltinModule('events').EventEmitter"],
  [
    "qualified",
    "",
    "globalThis.process.getBuiltinModule('node:events').EventEmitter",
  ],
  [
    "bound alias",
    "const events = process.getBuiltinModule('events'); const alias = events;",
    "alias.EventEmitter",
  ],
  [
    "destructured global getter",
    "const { getBuiltinModule: get } = process;",
    "get('events').EventEmitter",
  ],
  [
    "extracted global getter",
    "const get = process.getBuiltinModule;",
    "get('events').EventEmitter",
  ],
  [
    "qualified global getter",
    "const get = globalThis.process.getBuiltinModule;",
    "get('events').EventEmitter",
  ],
  [
    "global getter alias",
    "const get0 = process.getBuiltinModule; const get = get0;",
    "get('events').EventEmitter",
  ],
  [
    "process object alias",
    "const host = process;",
    "host.getBuiltinModule('events').EventEmitter",
  ],
  [
    "stored global getter",
    "const holder = { get: process.getBuiltinModule };",
    "holder.get('events').EventEmitter",
  ],
  [
    "imported process",
    "import process from 'node:process';",
    "process.getBuiltinModule('events').EventEmitter",
  ],
  [
    "imported getter",
    "import { getBuiltinModule } from 'node:process';",
    "getBuiltinModule('events').EventEmitter",
  ],
  [
    "extracted imported getter",
    "import * as process from 'node:process'; const get = process.getBuiltinModule;",
    "get('events').EventEmitter",
  ],
] as const)(
  "orders shared prototype changes through %s builtin acquisition",
  (_name, setup, constructor) => {
    const source = (
      before: boolean,
    ) => `import { EventEmitter } from "node:events";
${setup}
const e = new EventEmitter();
${before ? `${constructor}.prototype.on = replacement;` : ""}
e.on("ready");
${before ? "" : `${constructor}.prototype.on = replacement;`}`;
    expect(eventsForSource(source(true))).toContainEqual({
      kind: "register",
      method: "on",
      eventName: "ready",
    });
    expect(eventsForSource(source(false))).toEqual([]);
  },
);

it("retains a prototype exposed through builtin acquisition", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
const e = new EventEmitter();
configure(process.getBuiltinModule('events').EventEmitter.prototype);
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

it("keeps builtin acquisition effects whose callback timing is unknown", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
function patch() { process.getBuiltinModule('events').EventEmitter.prototype.on = replacement; }
const e = new EventEmitter();
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

it("does not grant native constructor proof from effect-only builtin acquisition", () => {
  expect(
    eventsForSource(`const events = process.getBuiltinModule('events');
const e = new events.EventEmitter();
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

it.each([
  ["inline named", "", "(await import('node:events')).EventEmitter"],
  ["inline default", "", "(await import('events')).default"],
  [
    "conditional namespace",
    "",
    "(await (flag ? import('events') : import('node:events'))).EventEmitter",
  ],
  [
    "sequence namespace",
    "",
    "(await (sideEffect(), import('events'))).EventEmitter",
  ],
  [
    "assignment namespace",
    "let namespacePromise;",
    "(await (namespacePromise = import('events'))).EventEmitter",
  ],
  ["logical namespace", "", "(await (other || import('events'))).EventEmitter"],
  [
    "bound namespace",
    "const events = await import('events');",
    "events.EventEmitter",
  ],
  [
    "destructured named",
    "const { EventEmitter: EE } = await import('node:events');",
    "EE",
  ],
  [
    "bound alias",
    "const events = await import('events'); const alias = events;",
    "alias.EventEmitter",
  ],
] as const)(
  "orders shared prototype changes through %s dynamic import",
  (_name, setup, constructor) => {
    const source = (
      before: boolean,
    ) => `import { EventEmitter } from "node:events";
${setup}
const e = new EventEmitter();
${before ? `${constructor}.prototype.on = replacement;` : ""}
e.on("ready");
${before ? "" : `${constructor}.prototype.on = replacement;`}`;
    expect(eventsForSource(source(true))).toContainEqual({
      kind: "register",
      method: "on",
      eventName: "ready",
    });
    expect(eventsForSource(source(false))).toEqual([]);
  },
);

it("retains a prototype exposed through awaited import", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
const e = new EventEmitter();
configure((await import('events')).EventEmitter.prototype);
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

it.each([
  "flag ? import('events') : import('node:events')",
  "sideEffect(), import('events')",
  "promise = import('events')",
  "other || import('events')",
])("orders escapes through awaited branch namespaces: %s", (acquisition) => {
  const source = (
    before: boolean,
  ) => `import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
let promise;
const e = new EventEmitter();
${before ? `configure((await (${acquisition})).EventEmitter.prototype);` : ""}
e.on("ready");
${before ? "" : `configure((await (${acquisition})).EventEmitter.prototype);`}`;
  expect(eventsForSource(source(true))).toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
  expect(eventsForSource(source(false))).toEqual([]);
});

it("keeps dynamic import effects whose callback timing is unknown", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
async function patch() { (await import('events')).EventEmitter.prototype.on = replacement; }
const e = new EventEmitter();
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

// These callback/Promise routes retain uncertainty without proving a module origin.
it.each([
  "await import('events').then(ns => { ns.EventEmitter.prototype.on = replacement; });",
  "await import('events').then(({ default: EE }) => { EE.prototype.on = replacement; });",
  "const promise = import('events'); (await promise).EventEmitter.prototype.on = replacement;",
  "const [ns] = await Promise.all([import('events')]); ns.EventEmitter.prototype.on = replacement;",
])("preserves uncertain dynamic acquisition effects: %s", (mutation) => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const e = new EventEmitter();
${mutation}
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

// These Promise aliases remain conservative without a shared-module origin fact.
it.each([
  "const pending = import('node:events'); const ns = await pending;",
  "const pending = import('node:events'); const alias = pending; const ns = await alias;",
  "const { pending } = { pending: import('node:events') }; const ns = await pending;",
  "const [pending] = [import('node:events')]; const ns = await pending;",
  "const pending = flag ? import('events') : import('node:events'); const ns = await pending;",
])(
  "preserves unknown initializer mutations through Promise aliases: %s",
  (setup) => {
    expect(
      eventsForSource(`import { EventEmitter } from "node:events";
import { initialize } from "./initialize.js";
${setup}
ns.EventEmitter.init = initialize;
const e = new EventEmitter();
e.on("ready");`),
    ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
  },
);

it("does not grant native constructor proof from effect-only dynamic import", () => {
  expect(
    eventsForSource(`const events = await import('events');
const e = new events.EventEmitter();
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/**
 * The added checks must not withdraw the proof from an untouched namespace
 * receiver, or the guard would never apply to the member-expression forms.
 */
it("still rejects a missing listener on an untouched namespace receiver", () => {
  expect(
    eventsForSource(`import * as events from "node:events";
const e = new events.EventEmitter();
e.on("ready");`),
  ).toEqual([]);
});

/**
 * A call that runs after the registration cannot change whether that
 * registration threw. Measured on Node 22.22.2: `e.on("x")` throws
 * `ERR_INVALID_ARG_TYPE` before `configure(e)` or `e.emit("done")` run, so a
 * later escape is not evidence about this call.
 */
it("still rejects a missing listener registered before the receiver escapes", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const e = new EventEmitter();
e.on("ready");
function configure(target) {
  target.on = (name, fn = () => {}) => target.addListener(name, fn);
}
configure(e);
e.emit("done");`),
  ).not.toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/**
 * `prototype[key]` records an unknown property name, which still covers the
 * method this call selects. Measured on Node 22.22.2: after that write
 * `e.on("ready")` stores one listener.
 */
it("keeps the registration of a receiver whose method is replaced by key", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const original = EventEmitter.prototype.addListener;
const key = "on";
EventEmitter.prototype[key] = function (name, fn = () => {}) { return original.call(this, name, fn); };
const e = new EventEmitter();
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/**
 * A write through an inline require belongs to the module rather than to a
 * binding. Measured on Node 22.22.2: it replaces `on` for every instance, so
 * `e.on("ready")` stores one listener.
 */
it("keeps the registration of a receiver after an inline require write", () => {
  expect(
    eventsForCommonJsSource(`const original = require("node:events").EventEmitter.prototype.addListener;
require("node:events").EventEmitter.prototype.on = function (name, fn = () => {}) { return original.call(this, name, fn); };
const { EventEmitter } = require("node:events");
const e = new EventEmitter();
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/**
 * Handing the prototype object itself to a call lets that call install a
 * method. Measured on Node 22.22.2: after `configure(EventEmitter.prototype)`
 * installs a defaulting wrapper, `e.on("ready")` stores one listener.
 */
it("keeps the registration after the prototype object escapes", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
function configure(proto) {
  const saved = proto.on;
  proto.on = function (name, fn = () => {}) { return saved.call(this, name, fn); };
}
configure(EventEmitter.prototype);
const e = new EventEmitter();
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/**
 * Replacing the receiver's own prototype changes which method answers the call.
 * Measured on Node 22.22.2: with `e.__proto__` set to an object that defaults
 * the listener, `e.on("ready")` does not throw.
 */
it("keeps the registration after the receiver prototype is replaced", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const e = new EventEmitter();
const saved = EventEmitter.prototype.on;
e.__proto__ = { on(name, fn = () => {}) { return saved.call(this, name, fn); } };
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/**
 * Handing the class itself to a call opens the same route as handing out its
 * prototype. Measured on Node 22.22.2: after `configure(EventEmitter)` installs
 * a defaulting wrapper, `e.on("ready")` does not throw.
 */
it("keeps the registration after the class object escapes", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
function configure(Ctor) {
  Ctor.prototype.on = function (name, fn = () => {}) {
    return EventEmitter.prototype.addListener.call(this, name, fn);
  };
}
const e = new EventEmitter();
configure(EventEmitter);
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/**
 * Node runs `EventEmitter.init` while constructing, so a replaced hook can give
 * every new instance its own method. Measured on Node 22.22.2: `e.on("ready")`
 * does not throw after `init` is replaced with a wrapper that installs one.
 */
it("keeps the registration after the init hook is replaced", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const savedInit = EventEmitter.init;
EventEmitter.init = function (opts) {
  savedInit.call(this, opts);
  this.on = function (name, fn = () => {}) {
    return EventEmitter.prototype.addListener.call(this, name, fn);
  };
};
const e = new EventEmitter();
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/**
 * Node invokes `EventEmitter.init.call(this, opts)`. The initializer function is
 * mutable: an external configurator can replace its `.call` slot with a wrapper
 * that installs an own defaulting listener method. Measured on Node 24.22.1:
 * `e.on("ready")` then registers one listener without throwing.
 */
it.each([
  [
    "a named import",
    'import { EventEmitter } from "node:events";',
    "EventEmitter",
    "EventEmitter.init",
  ],
  [
    "a namespace",
    'import * as events from "node:events";',
    "events.EventEmitter",
    "events.EventEmitter.init",
  ],
  [
    "an initializer alias",
    'import { EventEmitter } from "node:events"; const init = EventEmitter.init;',
    "EventEmitter",
    "init",
  ],
  [
    "a required module",
    'const events = require("node:events");',
    "events.EventEmitter",
    "events.EventEmitter.init",
    true,
  ],
  [
    "an inline require",
    'import { EventEmitter } from "node:events";',
    "EventEmitter",
    'require("events").EventEmitter.init',
    true,
  ],
  [
    "a named initializer import",
    'import { EventEmitter, init } from "node:events";',
    "EventEmitter",
    "init",
  ],
  [
    "a named initializer alias",
    'import { EventEmitter, init } from "node:events"; const initialize = init;',
    "EventEmitter",
    "initialize",
  ],
  [
    "a namespace initializer",
    'import * as events from "node:events";',
    "events.EventEmitter",
    "events.init",
  ],
  [
    "a member required initializer",
    'const EventEmitter = require("node:events"); const init = require("events").init;',
    "EventEmitter",
    "init",
    true,
  ],
] as const)(
  "checks initializer escape timing through %s",
  (_name, header, constructor, initializer, commonJs: boolean = false) => {
    const events = commonJs ? eventsForCommonJsSource : eventsForSource;
    const source = (before: boolean) => `${header}
import { configure } from "./configure.js";
${before ? `configure(${initializer});` : ""}
const e = new ${constructor}();
${before ? "" : `configure(${initializer});`}
e.on("ready");`;
    expect(events(source(true))).toContainEqual({
      kind: "register",
      method: "on",
      eventName: "ready",
    });
    expect(events(source(false))).toEqual([]);
  },
);

it("keeps the registration after a destructured required initializer escapes", () => {
  expect(
    eventsForCommonJsSource(`const { EventEmitter, init } = require("node:events");
import { configure } from "./configure.js";
configure(init);
const e = new EventEmitter();
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/**
 * The inherited call slot is mutable, and init.prototype.constructor leads back
 * to init itself. Existing prototype/escape facts must retain both surfaces.
 */
it.each([
  "EventEmitter.init.__proto__",
  "Reflect.getPrototypeOf(EventEmitter.init)",
  "EventEmitter.init.prototype",
  "init.__proto__",
  "Reflect.getPrototypeOf(init)",
  "init.prototype",
])(
  "keeps the registration when the initializer is reachable through %s",
  (surface) => {
    expect(
      eventsForSource(`import { EventEmitter, init } from "node:events";
import { configure } from "./configure.js";
configure(${surface});
const e = new EventEmitter();
e.on("ready");`),
    ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
  },
);

it.each(["EventEmitter.init", "init"])(
  "still rejects a missing listener when only %s.call escapes",
  (initializer) => {
    expect(
      eventsForSource(`import { EventEmitter, init } from "node:events";
import { configure } from "./configure.js";
configure(${initializer}.call);
const e = new EventEmitter();
e.on("ready");`),
    ).toEqual([]);
  },
);

it.each(["init.call = replacement;", "init.__proto__ = replacement;"])(
  "checks named initializer mutation timing for %s",
  (mutation) => {
    const source = (
      before: boolean,
    ) => `import { EventEmitter, init } from "node:events";
${before ? mutation : ""}
const e = new EventEmitter();
${before ? "" : mutation}
e.on("ready");`;
    expect(eventsForSource(source(true))).toContainEqual({
      kind: "register",
      method: "on",
      eventName: "ready",
    });
    expect(eventsForSource(source(false))).toEqual([]);
  },
);

it("still rejects a missing listener beside an unrelated imported initializer escape", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { init } from "./unrelated.js";
import { configure } from "./configure.js";
configure(init);
const e = new EventEmitter();
e.on("ready");`),
  ).toEqual([]);
});

it("keeps the registration after an initializer alias call slot is replaced", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const init = EventEmitter.init;
init.call = replacement;
const e = new EventEmitter();
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/**
 * Two specifiers name the same mutable module, so a replacement installed
 * through one import answers the other. Measured on Node 22.22.2: `e.on("ready")`
 * does not throw after the class is replaced through the first import.
 */
it("keeps the registration after the class is replaced through another import", () => {
  expect(
    eventsForSource(`import first from "events";
import second from "node:events";
first.EventEmitter = class extends first.EventEmitter {
  on(name, fn = () => {}) { return super.on(name, fn); }
};
const e = new second.EventEmitter();
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/**
 * An `init` property on an unrelated object cannot reshape the class. Measured
 * on Node 22.22.2: `e.on("x")` still throws after `config.init = true`.
 */
it("still rejects a missing listener beside an unrelated init write", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const config = {};
config.init = true;
const e = new EventEmitter();
e.on("x");`),
  ).toEqual([]);
});

/**
 * Only a hook installed before the construction can shape the instance, so a
 * later class-level write leaves this receiver on the native method. Measured
 * on Node 22.22.2: `e.on("x")` still throws after `EventEmitter.init` is
 * replaced on an already-built receiver.
 */
it("still rejects a missing listener when the init hook changes later", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const e = new EventEmitter();
EventEmitter.init = function () {};
e.on("x");`),
  ).toEqual([]);
});

/**
 * A direct `eval` can rewrite the receiver with code no write record describes.
 * Measured on Node 22.22.2: `e.on("ready")` registers one listener after the
 * evaluated replacement installs a defaulting method.
 */
it("keeps the registration when eval may replace the method", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const e = new EventEmitter();
eval("e.on = (name, fn = () => {}) => e.addListener(name, fn)");
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

/** The imported helper hides its writes, so only the shared escape proves uncertainty. */
it.each([
  [
    "the class",
    'import { EventEmitter } from "node:events";',
    "EventEmitter",
    "EventEmitter",
  ],
  [
    "the namespace",
    'import * as events from "node:events";',
    "events.EventEmitter",
    "events",
  ],
  [
    "a class alias",
    'import { EventEmitter } from "node:events"; const EE = EventEmitter;',
    "EE",
    "EE",
  ],
  [
    "another import",
    'import first from "events"; import second from "node:events";',
    "second.EventEmitter",
    "first",
  ],
  [
    "a required module",
    'const events = require("node:events");',
    "events.EventEmitter",
    "events",
    true,
  ],
  [
    "an inline require",
    "",
    'require("node:events").EventEmitter',
    'require("events")',
    true,
  ],
] as const)(
  "keeps the registration when %s escapes after construction",
  (_name, header, constructor, escaped, commonJs: boolean = false) => {
    const events = commonJs ? eventsForCommonJsSource : eventsForSource;
    expect(
      events(`import { configure } from "./configure.js";
${header}
const e = new (${constructor})();
configure(${escaped});
e.on("ready");`),
    ).toContainEqual({
      kind: "register",
      method: "on",
      eventName: "ready",
    });
  },
);

it.each([
  [
    "the class",
    'import { EventEmitter } from "node:events";',
    "EventEmitter",
    "EventEmitter",
  ],
  [
    "the namespace",
    'import * as events from "node:events";',
    "events.EventEmitter",
    "events",
  ],
  [
    "another import",
    'import first from "events"; import second from "node:events";',
    "second.EventEmitter",
    "first",
  ],
] as const)(
  "still rejects a missing listener before %s escapes",
  (_name, header, constructor, escaped) => {
    expect(
      eventsForSource(`import { configure } from "./configure.js";
${header}
const e = new (${constructor})();
e.on("ready");
configure(${escaped});`),
    ).not.toContainEqual({
      kind: "register",
      method: "on",
      eventName: "ready",
    });
  },
);

it("still rejects a missing listener when only the prototype method value escapes", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
configure(EventEmitter.prototype.on);
const e = new EventEmitter();
e.on("ready");`),
  ).not.toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it("still rejects a missing listener when only a saved method value escapes", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
const saved = EventEmitter.prototype.on;
configure(saved);
const e = new EventEmitter();
e.on("ready");`),
  ).toEqual([]);
});

it.each([
  "configure(EventEmitter)",
  'eval("EventEmitter.prototype.on = replacement")',
])(
  "still rejects when %s runs after method selection in an argument",
  (effect) => {
    expect(
      eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
const e = new EventEmitter();
e.on((${effect}, "ready"));`),
    ).toEqual([]);
  },
);

it.each(["before", "after"] as const)(
  "keeps the registration when the prototype constructor escapes %s construction",
  (timing) => {
    expect(
      eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
${timing === "before" ? "configure(EventEmitter.prototype.constructor);" : ""}
const e = new EventEmitter();
${timing === "after" ? "configure(EventEmitter.prototype.constructor);" : ""}
e.on("ready");`),
    ).toContainEqual({
      kind: "register",
      method: "on",
      eventName: "ready",
    });
  },
);

it("keeps the registration after an alias of the prototype constructor escapes", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
const Ctor = EventEmitter.prototype.constructor;
const e = new EventEmitter();
configure(Ctor);
e.on("ready");`),
  ).toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it("keeps the registration after a computed prototype constructor escapes", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
const key = "prototype";
const e = new EventEmitter();
configure(EventEmitter[key].constructor);
e.on("ready");`),
  ).toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

/** Shared prototype changes may outlive the activation that made them. */
it("keeps a registration when a class escape may run in an earlier invocation", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
function run(change) {
  const e = new EventEmitter();
  if (!change) e.on("ready");
  configure(EventEmitter);
}
run(true);
run(false);`),
  ).toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it.each([
  [
    "a named import",
    'import { EventEmitter } from "node:events";',
    "EventEmitter",
  ],
  ["a local class alias", 'import { EventEmitter } from "node:events";', "EE"],
  [
    "a required module",
    'const events = require("node:events");',
    "events.EventEmitter",
    true,
  ],
  ["an inline require", "", 'require("node:events").EventEmitter', true],
] as const)(
  "keeps a nested receiver when module eval may change %s",
  (_name, header, constructor, commonJs: boolean = false) => {
    const events = commonJs ? eventsForCommonJsSource : eventsForSource;
    expect(
      events(`${header}
const original = (${constructor === "EE" ? "EventEmitter" : constructor}).prototype.on;
eval(${JSON.stringify(`(${constructor === "EE" ? "EventEmitter" : constructor}).prototype.on = function(name, fn = () => {}) { return original.call(this, name, fn); }`)});
function run() {
  ${constructor === "EE" ? "const EE = EventEmitter;" : ""}
  const e = new (${constructor})();
  e.on("ready");
}
run();`),
    ).toContainEqual({
      kind: "register",
      method: "on",
      eventName: "ready",
    });
  },
);

it("keeps a registration when outer eval may run in an earlier invocation", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const original = EventEmitter.prototype.on;
function run(change) {
  if (change) eval("EventEmitter.prototype.on = function(name, fn = () => {}) { return original.call(this, name, fn); }");
  function listen() {
    const e = new EventEmitter();
    e.on("ready");
  }
  if (!change) listen();
}
run(true);
run(false);`),
  ).toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it("still rejects a missing listener before a top-level eval runs", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const e = new EventEmitter();
e.on("ready");
eval("EventEmitter.prototype.on = replacement");`),
  ).not.toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it("still rejects a missing listener beside a shadowed eval call", () => {
  expect(
    eventsForCommonJsSource(`const { EventEmitter } = require("node:events");
function run(eval) {
  const e = new EventEmitter();
  eval("ordinary callback");
  e.on("ready");
}`),
  ).not.toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it("keeps a registration when indirect eval may reacquire the shared module", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const indirect = eval;
indirect("process.getBuiltinModule('events').EventEmitter.prototype.on = replacement");
function run() {
  const e = new EventEmitter();
  e.on("ready");
}`),
  ).toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it("still rejects a missing listener before a top-level indirect eval", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const indirect = eval;
const e = new EventEmitter();
e.on("ready");
indirect("process.getBuiltinModule('events').EventEmitter.prototype.on = replacement");`),
  ).not.toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it.each([
  "configure(e.constructor);",
  "const Ctor = e.constructor; configure(Ctor);",
  'const key = "constructor"; configure(e[key]);',
  "configure(e.__proto__.constructor);",
])("keeps a registration when the receiver exposes its class: %s", (effect) => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
const e = new EventEmitter();
${effect}
e.on("ready");`),
  ).toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it.each([
  "configure(e.constructor);",
  "const Ctor = e.constructor; configure(Ctor);",
])("still rejects before the receiver exposes its class: %s", (effect) => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
const e = new EventEmitter();
e.on("ready");
${effect}`),
  ).not.toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it("still rejects when only a method reached through the receiver class escapes", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
const e = new EventEmitter();
configure(e.constructor.prototype.on);
e.on("ready");`),
  ).not.toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it("keeps another receiver's registration when a whole instance exposes the shared class", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
const first = new EventEmitter();
const second = new EventEmitter();
configure(first);
second.on("ready");`),
  ).toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it("still rejects before another instance exposes the shared class", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
const first = new EventEmitter();
const second = new EventEmitter();
second.on("ready");
configure(first);`),
  ).not.toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it("still rejects when only another receiver's method value escapes", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
const first = new EventEmitter();
const second = new EventEmitter();
configure(first.on);
second.on("ready");`),
  ).not.toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it("still rejects after an instance constructor slot is replaced", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
const e = new EventEmitter();
e.constructor = Other;
e.on("ready");`),
  ).not.toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
});

it.each(["const copy = { ...first };", "const { tag, ...copy } = first;"])(
  "still rejects when a shallow copy excludes inherited class references: %s",
  (copy) => {
    expect(
      eventsForSource(`import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
const first = new EventEmitter();
const second = new EventEmitter();
${copy}
configure(copy);
second.on("ready");`),
    ).not.toContainEqual({
      kind: "register",
      method: "on",
      eventName: "ready",
    });
  },
);

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

it.each([
  ["direct write", "Function.prototype.call = wrapper;"],
  ["qualified write", "globalThis.Function.prototype.call = wrapper;"],
  [
    "prototype alias",
    "const proto = Function.prototype; proto.call = wrapper;",
  ],
  ["prototype escape", "configure(Function.prototype);"],
  ["unknown property", "Function.prototype[key] = wrapper;"],
])(
  "orders the initializer's inherited call dependency: %s",
  (_name, mutation) => {
    const source = (
      before: boolean,
    ) => `import { EventEmitter } from "node:events";
import { wrapper, configure } from "./patch.js";
${before ? mutation : ""}
const e = new EventEmitter();
${before ? "" : mutation}
e.on("ready");`;
    expect(eventsForSource(source(true))).toContainEqual({
      kind: "register",
      method: "on",
      eventName: "ready",
    });
    expect(eventsForSource(source(false))).toEqual([]);
  },
);

it("keeps unknown timing on the initializer's inherited call dependency", () => {
  expect(
    eventsForSource(`import { EventEmitter } from "node:events";
import { wrapper } from "./patch.js";
function patch() { Function.prototype.call = wrapper; }
const e = new EventEmitter();
e.on("ready");`),
  ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
});

it.each([
  "configure(Function.prototype.call);",
  "Function.prototype.tag = wrapper;",
  "function patch(Function) { Function.prototype.call = wrapper; }",
])(
  "preserves native proof without an inherited call-slot change: %s",
  (mutation) => {
    expect(
      eventsForSource(`import { EventEmitter } from "node:events";
import { wrapper, configure } from "./patch.js";
${mutation}
const e = new EventEmitter();
e.on("ready");`),
    ).toEqual([]);
  },
);

it.each([
  "configure(EventEmitter.init.prototype.constructor);",
  "configure(init.prototype.constructor);",
  "configure(EventEmitter.init.prototype.constructor.prototype.constructor);",
  "const initialize = init.prototype.constructor; configure(initialize);",
  "init.prototype.constructor.call = wrapper;",
  "init.prototype.constructor.prototype.constructor.call = wrapper;",
])("orders initializer back-reference effects: %s", (mutation) => {
  const source = (
    before: boolean,
  ) => `import { EventEmitter, init } from "node:events";
import { configure, wrapper } from "./patch.js";
${before ? mutation : ""}
const e = new EventEmitter();
${before ? "" : mutation}
e.on("ready");`;
  expect(eventsForSource(source(true))).toContainEqual({
    kind: "register",
    method: "on",
    eventName: "ready",
  });
  expect(eventsForSource(source(false))).toEqual([]);
});

it.each([
  "configure(EventEmitter.init.prototype.constructor.call);",
  "configure(init.prototype.constructor.call);",
  "init.prototype.constructor.tag = wrapper;",
  "init.prototype.constructor = wrapper;",
  "init.prototype.constructor.prototype.constructor = wrapper;",
  "delete init.prototype.constructor;",
  "delete init.prototype.constructor.prototype.constructor;",
])("preserves unrelated initializer back-reference values: %s", (mutation) => {
  expect(
    eventsForSource(`import { EventEmitter, init } from "node:events";
import { configure, wrapper } from "./patch.js";
${mutation}
const e = new EventEmitter();
e.on("ready");`),
  ).toEqual([]);
});

it.each([
  ["namespace", 'import * as ns from "events";', "ns.init"],
  ["default", 'import ns from "events";', "ns.init"],
  ["builtin getter", "", 'process.getBuiltinModule("events").init'],
  ["awaited namespace", "", '(await import("events")).init'],
  ["awaited default", "", '(await import("events")).default.init'],
])(
  "orders existing %s initializer back-reference facts",
  (_name, header, initializer) => {
    const effect = `configure(${initializer}.prototype.constructor);`;
    const source = (
      before: boolean,
    ) => `import { EventEmitter } from "node:events";
import { configure } from "./configure.js";
${header}
${before ? effect : ""}
const e = new EventEmitter();
${before ? "" : effect}
e.on("ready");`;
    expect(eventsForSource(source(true))).toContainEqual({
      kind: "register",
      method: "on",
      eventName: "ready",
    });
    expect(eventsForSource(source(false))).toEqual([]);
  },
);

it.each([
  "process.getBuiltinModule.call(null, 'events')",
  "process.getBuiltinModule.apply(null, ['events'])",
  "Reflect.apply(process.getBuiltinModule, null, ['events'])",
  "process.getBuiltinModule.bind(null, 'events')()",
  "process.getBuiltinModule.bind(null)('events')",
])(
  "retains native-listener uncertainty after normalized getter effects: %s",
  (getter) => {
    expect(
      eventsForSource(`import {EventEmitter} from 'node:events';
    import {replacement} from './patch.js';
    ${getter}.EventEmitter.prototype.on = replacement;
    const e = new EventEmitter(); e.on('ready');`),
    ).toContainEqual({ kind: "register", method: "on", eventName: "ready" });
    expect(
      eventsForSource(`import {EventEmitter} from 'node:events';
    import {replacement} from './patch.js';
    const e = new EventEmitter(); e.on('ready');
    ${getter}.EventEmitter.prototype.on = replacement;`),
    ).toEqual([]);
  },
);
