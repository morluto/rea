import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const operations = (source: string) =>
  analyzeJavaScriptSemantics(source).eventOperations.map(
    ({ kind, method, eventName }) => ({ kind, method, eventName }),
  );

const esm = 'import { EventEmitter } from "node:events";\n';

/**
 * Node's `EventEmitter` validates argument 1 with `checkListener` before it
 * registers or removes anything, so a call that passes no listener throws and
 * produces no event operation. Only that class is bound by the rule: an
 * EventEmitter-style API may define a one-argument form, such as Socket.IO's
 * `socket.off("x")`, which removes every listener for the event. A receiver that
 * is not proven to be Node's class therefore keeps its operation as an
 * unresolved candidate, as it did before the missing argument was considered.
 */
describe("missing listener argument", () => {
  it.each([
    ["a named import", 'import { EventEmitter } from "node:events";'],
    ["a default import", 'import EventEmitter from "node:events";'],
    ["the node: prefix", 'import { EventEmitter } from "events";'],
  ])(
    "drops the operation for a receiver built from %s",
    (_label, importLine) => {
      expect(
        operations(`${importLine}
const emitter = new EventEmitter();
emitter.on("ready");`),
      ).toEqual([]);
    },
  );

  it("drops the operation for a namespace member construction", () => {
    expect(
      operations(`import * as events from "node:events";
const emitter = new events.EventEmitter();
emitter.off("ready");`),
    ).toEqual([]);
  });

  it("drops the operation inside a later activation", () => {
    expect(
      operations(`${esm}const emitter = new EventEmitter();
function start() {
  emitter.once("ready");
}`),
    ).toEqual([]);
  });

  it("drops the operation for a child process Node creates", () => {
    expect(
      operations(`import { spawn } from "node:child_process";
const child = spawn("worker");
child.on("exit");`),
    ).toEqual([]);
  });

  it.each([
    [
      "an unknown receiver",
      'function forward(target) {\n  target.on("ready");\n}',
    ],
    [
      "an object that defines its own listener method",
      'const target = { on(event) {\n  return event;\n} };\ntarget.on("ready");',
    ],
    [
      "a Socket.IO style removal",
      'function clear(socket) {\n  socket.off("ready");\n}',
    ],
    [
      "a commonjs member require",
      'const { EventEmitter } = require("events");\nconst emitter = new EventEmitter();\nemitter.on("ready");',
    ],
  ])("keeps the operation for %s", (_label, source) => {
    expect(operations(source)).toHaveLength(1);
  });

  it.each([
    [
      "the receiver method is replaced",
      `${esm}const emitter = new EventEmitter();
emitter.on = function listen() {};
emitter.on("ready");`,
    ],
    [
      "the shared prototype method is replaced",
      `${esm}EventEmitter.prototype.on = function listen() {};
const emitter = new EventEmitter();
emitter.on("ready");`,
    ],
    [
      "the constructor init hook is replaced",
      `${esm}EventEmitter.init = replacement;
const emitter = new EventEmitter();
emitter.on("ready");`,
    ],
    [
      "the class is handed to another call",
      `${esm}configure(EventEmitter);
const emitter = new EventEmitter();
emitter.on("ready");`,
    ],
    [
      "the prototype is handed to another call",
      `${esm}configure(EventEmitter.prototype);
const emitter = new EventEmitter();
emitter.on("ready");`,
    ],
    [
      "the receiver is handed to an earlier call",
      `${esm}const emitter = new EventEmitter();
configure(emitter);
emitter.on("ready");`,
    ],
    [
      "spread arguments may still supply a listener",
      `${esm}const emitter = new EventEmitter();
const arguments_ = ["ready", listen];
emitter.on(...arguments_);`,
    ],
  ])("keeps the operation when %s", (_label, source) => {
    expect(operations(source)).toHaveLength(1);
  });

  it("drops the operation when only the method value is handed out", () => {
    expect(
      operations(`${esm}configure(EventEmitter.prototype.on);
const emitter = new EventEmitter();
emitter.on("ready");`),
    ).toEqual([]);
  });

  it("drops the operation when the receiver escapes after the call", () => {
    expect(
      operations(`${esm}const emitter = new EventEmitter();
emitter.on("ready");
configure(emitter);`),
    ).toEqual([]);
  });
});
