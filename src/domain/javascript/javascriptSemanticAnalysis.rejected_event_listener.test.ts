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

const eventsForSource = (source: string) =>
  analyzeJavaScriptSemantics(source).eventOperations.map(
    ({ kind, method, eventName }) => ({ kind, method, eventName }),
  );

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
  "drops a missing listener on a receiver built from %s",
  (_name, header, constructor) => {
    expect(
      eventsForSource(`${header}
const e = new ${constructor}();
e.on("x");`),
    ).toEqual([]);
  },
);

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
    eventsForSource(`const events = require("node:events");
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
    eventsForSource(`const original = require("node:events").EventEmitter.prototype.addListener;
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
