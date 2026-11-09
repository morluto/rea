import * as t from "@babel/types";
import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { isIntrinsicNonEscapingArrayCall } from "./javascriptSemanticArrayOperations.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

const proofFor = (source: string, method = "fill") => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("Expected array-call fixture");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const results: (boolean | undefined)[] = [];
  traverseJavaScriptAst(parsed.program, {
    enter(node) {
      if (
        t.isCallExpression(node) &&
        t.isMemberExpression(node.callee) &&
        t.isIdentifier(node.callee.property, { name: method })
      )
        results.push(
          isIntrinsicNonEscapingArrayCall(node, index.bindings, index),
        );
    },
  });
  return results;
};

it.each([
  "fill(0)",
  "copyWithin(0, 1)",
  "reverse()",
  "push(0)",
  "pop()",
  "shift()",
  "unshift(0)",
  "includes(0)",
  "indexOf(0)",
  "lastIndexOf(0)",
  "at(0)",
  "join(',')",
  "toString()",
  "keys()",
  "values()",
  "entries()",
])("preserves unrelated array iteration after discarded native %s", (call) => {
  const source = `const a = new Array(3); a.${call}; const urls = ['/api']; const [url] = urls; fetch(url);`;
  expect(proofFor(source, call.slice(0, call.indexOf("(")))).toEqual([true]);
  expect(analyzeJavaScriptStaticSource(source).endpoints).toMatchObject([
    { value: "/api" },
  ]);
});

it.each([
  "new Array(3).fill(0);",
  "const a = new globalThis.Array(3); const b = a; b.fill(0);",
  "const a = new Array('/old', '/other'); a.fill('/new');",
  "const a = new Array(3); a.fill(0); a.fill = patch;",
  "const a = new Array(3); a.fill(0); Array.prototype[0] = replacement;",
  "Map.prototype[0] = replacement; const a = new Array(3); a.fill(0);",
])("proves only prior effects relevant to a pristine array: %s", (source) => {
  expect(proofFor(source)).toEqual([true]);
});

it.each([
  "Array.prototype.fill = patch; const a = new Array(3); a.fill(0);",
  "Array.prototype[0] = replacement; const a = new Array(3); a.fill(0);",
  "Object.prototype[0] = replacement; const a = new Array(3); a.fill(0);",
  "Array.prototype[key] = replacement; const a = new Array(3); a.fill(0);",
  "Object.defineProperty(Array.prototype, '0', {set(value) { patch(this); }}); const a = new Array(3); a.fill(0);",
  "Object.defineProperty(Object.prototype, '0', {set(value) { patch(this); }}); const a = new Array(3); a.fill(0);",
  "consume(Array.prototype); const a = new Array(3); a.fill(0);",
  "consume(Object.prototype); const a = new Array(3); a.fill(0);",
  "Object.setPrototypeOf(Array.prototype, custom); const a = new Array(3); a.fill(0);",
  "const a = new Array(3); Object.setPrototypeOf(a, custom); a.fill(0);",
  "const a = new Array(3); Object.defineProperty(a, '0', {set(value) { patch(this); }}); a.fill(0);",
  "const a = new Array(3); const b = a; b[0] = value; a.fill(0);",
  "const a = new Array(3); consume(a); a.fill(0);",
  "const a = new Array(3); a.fill = patch; a.fill(0);",
  "const a = new Array(3); a.fill({}, 0);",
  "const a = new Array(3); a.fill(0, {valueOf() { patch(a); return 0; }});",
  "const a = new Array(3); a.fill(...args);",
  "const a = new Array(3); a.fill(value);",
  "const a = new Array(value); a.fill(0);",
  "const a = new Array(...args); a.fill(0);",
  "const a = new Array(3); consume(a.fill(0));",
  "const a = []; a.fill(0);",
  "const a = new Array(3); a.fill(0, (Array.prototype[0] = replacement, 0));",
  "const a = new Array(3); a.fill(0, (Object.prototype[0] = replacement, 0));",
  "const a = new Array(3); a.fill(0, (eval(code), 0));",
  "const a = new Array(3); a.fill(0, (Object.setPrototypeOf(a, custom) ? 0 : 0));",
  "const a = new Array(3); a.fill(0, ((Array.prototype[0] = replacement) ? 0 : 0));",
  "const a = new Array(3); a.fill(0, ((Object.prototype[0] = replacement) ? 0 : 0));",
  "const a = new Array(3); a.fill(0, (eval(code) ? 0 : 0));",
  "function patch() { Array.prototype[0] = replacement; } const a = new Array(3); a.fill(0);",
  "function run(Array) { const a = new Array(3); a.fill(0); }",
  "function run(a) { a.fill(0); }",
])("retains receiver uncertainty outside the pristine proof: %s", (source) => {
  expect(proofFor(source)).toEqual([false]);
});

it.each(["sort()", "splice(0)", "slice(0)", "concat(0)", "forEach(callback)"])(
  "does not admit additional callback or species contracts: %s",
  (call) => {
    expect(
      proofFor(
        `const a = new Array(3); a.${call};`,
        call.slice(0, call.indexOf("(")),
      ),
    ).toEqual([false]);
  },
);

it("does not restore stale literal-array slots after a native mutation", () => {
  expect(
    analyzeJavaScriptStaticSource(
      "const a = ['/old']; a.fill('/new'); fetch(a[0]);",
    ).endpoints.map(({ value }) => value),
  ).not.toContain("/old");
});

it("reconsiders earlier pristine proofs after a deferred receiver escapes", () => {
  expect(
    proofFor(`function run() {
    const a = new Array(3); a.fill(0);
    const b = new Array(3); b[0] = 1; b.fill(0);
  }`),
  ).toEqual([false, false]);
});

it.each([
  "includes(0)",
  "indexOf(0)",
  "lastIndexOf(0)",
  "at(0)",
  "join(',')",
  "toString()",
  "keys()",
  "values()",
  "entries()",
])(
  "keeps read-result consumption outside the pristine receiver contract: %s",
  (call) => {
    expect(
      proofFor(
        `const a = new Array(3); consume(a.${call});`,
        call.slice(0, call.indexOf("(")),
      ),
    ).toEqual([false]);
  },
);

it.each([
  "new Array(3).includes(0);",
  "const a = new globalThis.Array('a', 'b'); const b = a; b.includes('a');",
  "const a = new Array(3); a.includes(0); Array.prototype[0] = replacement;",
])(
  "retains pristine Array read certainty without new shape facts: %s",
  (source) => {
    expect(proofFor(source, "includes")).toEqual([true]);
  },
);

it.each([
  [
    "includes",
    "Object.defineProperty(Array.prototype, '0', {get() { patch(); return 0; }}); const a = new Array(3); a.includes(0);",
  ],
  [
    "includes",
    "Object.defineProperty(Object.prototype, '0', {get() { patch(); return 0; }}); const a = new Array(3); a.includes(0);",
  ],
  ["includes", "const a = new Array(3); a[0] = object; a.includes(0);"],
  [
    "includes",
    "const a = new Array(3); a.includes(0, {valueOf() {patch(a); return 0;}});",
  ],
  ["includes", "const a = new Array(3); a.includes(0, (eval(code) ? 0 : 0));"],
  [
    "includes",
    "const a = new Array(3); a.includes(0, ((Array.prototype[0] = replacement) ? 0 : 0));",
  ],
  ["join", "const a = new Array(object, 0); a.join(',');"],
  [
    "join",
    "const a = new Array(3); a.join({toString() {patch(a); return ',';}});",
  ],
  [
    "toString",
    "Array.prototype.join = replacement; const a = new Array(3); a.toString();",
  ],
  ["toString", "const a = new Array(3); a.join = replacement; a.toString();"],
  ["includes", "const a = [0]; a.includes(0);"],
  ["values", "const a = new Array(3); consume(a); a.values();"],
])("does not exempt a read with observable hooks: %s", (method, source) => {
  expect(proofFor(source, method)).toEqual([false]);
});

it.each([
  "toLocaleString()",
  "slice()",
  "concat()",
  "flat()",
  "map(callback)",
  "filter(callback)",
  "find(callback)",
  "some(callback)",
  "every(callback)",
  "reduce(callback)",
  "sort()",
  "toSorted()",
  "toReversed()",
  "toSpliced(0)",
  "with(0, 1)",
])(
  "does not add callback, element-prototype or copying contracts: %s",
  (call) => {
    expect(
      proofFor(
        `const a = new Array(1, 2); a.${call};`,
        call.slice(0, call.indexOf("(")),
      ),
    ).toEqual([false]);
  },
);

it.each([
  "new Array(3).includes(0);",
  "const a = new Array(3); a.includes(0);",
])(
  "defers even direct pristine reads until propagated effects converge: %s",
  (source) => {
    const parsed = parseJavaScriptSource(source);
    if (parsed === null) throw new Error("Expected read fixture");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    completeSemanticSteps(index.indexAmbientWritesSteps());
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    const results: (boolean | undefined)[] = [];
    traverseJavaScriptAst(parsed.program, {
      enter(node) {
        if (t.isCallExpression(node))
          results.push(isIntrinsicNonEscapingArrayCall(node, index.bindings));
      },
    });
    expect(results).toEqual([undefined]);
  },
);

it("does not exempt locale conversion through mutable element prototypes", () => {
  expect(
    proofFor(
      "Number.prototype.toLocaleString = patch; const a = new Array(1, 2); a.toLocaleString();",
      "toLocaleString",
    ),
  ).toEqual([false]);
});
