import { expect, it } from "vitest";

import {
  analyzeJavaScriptSemantics,
  indexJavaScriptBindingsWithReceiversSteps,
} from "./javascriptSemanticAnalysis.js";
import { collectJavaScriptSemanticAsyncEffects } from "./javascriptSemanticAsyncEffects.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const indexed = (source: string) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("Expected event-effect fixture");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  return { program: parsed.program, state: index.bindings };
};

it("shares binding scans across missing-listener calls", () => {
  const work = (count: number): number => {
    // Imports are hoisted, but unrelated declarations may precede them in source.
    const source = `${Array.from({ length: count }, (_, i) => `const unrelated${String(i)} = ${String(i)};`).join("\n")}
import { EventEmitter } from "node:events";
const e = new EventEmitter();
${Array.from({ length: count }, (_, i) => `e.on("event${String(i)}");`).join("\n")}`;
    const { program, state } = indexed(source);
    const bindings = state.bindingsById.values.bind(state.bindingsById);
    let reads = 0;
    Object.defineProperty(state.bindingsById, "values", {
      value: function* () {
        for (const binding of bindings()) {
          reads += 1;
          yield binding;
        }
      },
    });
    const { eventOperations } = collectJavaScriptSemanticAsyncEffects(
      program,
      state,
      [],
    );
    // Preserve the earlier-invocation escape uncertainty for subsequent calls.
    expect(eventOperations.map(({ eventName }) => eventName)).toEqual(
      Array.from({ length: count - 1 }, (_, i) => `event${String(i + 1)}`),
    );
    return reads;
  };
  expect(work(64)).toBeLessThan(3 * work(32));
});

it("checks shared prototype timing separately at each call", () => {
  const result =
    analyzeJavaScriptSemantics(`import { EventEmitter } from "node:events";
const e = new EventEmitter();
e.on("before");
EventEmitter.prototype.on = replacement;
e.on("after");`);
  expect(result.eventOperations.map(({ eventName }) => eventName)).toEqual([
    "after",
  ]);
});

it("checks initialization effects against each receiver construction", () => {
  const result =
    analyzeJavaScriptSemantics(`import { EventEmitter } from "node:events";
const before = new EventEmitter();
EventEmitter.init = replacement;
const after = new EventEmitter();
before.on("native");
after.on("changed");`);
  expect(result.eventOperations.map(({ eventName }) => eventName)).toEqual([
    "changed",
  ]);
});

it("rebuilds shared effects for a later collection on the same state", () => {
  const { program, state } =
    indexed(`import { EventEmitter } from "node:events";
const e = new EventEmitter();
e.on("ready");`);
  expect(
    collectJavaScriptSemanticAsyncEffects(program, state, []).eventOperations,
  ).toEqual([]);
  const emitter = [...state.bindingsById.values()].find(
    ({ name }) => name === "EventEmitter",
  );
  if (emitter === undefined) throw new Error("Expected EventEmitter binding");
  emitter.memberWrites.push({ path: ["prototype", "on"], node: undefined });
  expect(
    collectJavaScriptSemanticAsyncEffects(program, state, []).eventOperations,
  ).toMatchObject([{ method: "on", eventName: "ready" }]);
});
