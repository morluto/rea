import * as t from "@babel/types";
import { expect, it } from "vitest";

import {
  createXhrOpenRequestQuery,
  isIntrinsicNonEscapingXhrOpen,
} from "./javascriptNetworkRequests.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { isIntrinsicNonEscapingArrayCall } from "./javascriptSemanticArrayOperations.js";
import { semanticConstructedReceiver } from "./javascriptSemanticIntrinsicReceivers.js";
import {
  isIntrinsicMapLookup,
  isIntrinsicNonEscapingMapCall,
} from "./javascriptSemanticMapOperations.js";
import { isIntrinsicNonEscapingObjectCall } from "./javascriptSemanticObjectOperations.js";
import type {
  JavaScriptBindingIndex,
  JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { semanticStaticPropertyName } from "./javascriptAstValues.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

type ReceiverProof = (
  node: t.CallExpression | t.OptionalCallExpression,
  state: JavaScriptSemanticAnalysisState,
  index?: Pick<JavaScriptBindingIndex, "referenceMayHaveChangedAt">,
) => boolean | undefined;

const fixture = (source: string, method: string, mutations = true) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("Expected intrinsic-receiver fixture");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  if (mutations) completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const calls: (t.CallExpression | t.OptionalCallExpression)[] = [];
  traverseJavaScriptAst(parsed.program, {
    enter(node) {
      if (
        (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
        (t.isMemberExpression(node.callee) ||
          t.isOptionalMemberExpression(node.callee)) &&
        semanticStaticPropertyName(
          node.callee.property,
          node.callee.computed,
        ) === method
      )
        calls.push(node);
    },
  });
  return { index, calls };
};

const proofFor = (
  source: string,
  method = "hasOwnProperty",
  proof: ReceiverProof = isIntrinsicNonEscapingObjectCall,
) => {
  const { index, calls } = fixture(source, method);
  return calls.map((call) => proof(call, index.bindings, index));
};

it.each([
  "hasOwnProperty('x')",
  "propertyIsEnumerable('x')",
  "valueOf()",
  "isPrototypeOf(0)",
  "toString()",
  "toLocaleString()",
])(
  "preserves unrelated array iteration after pristine native Object.%s",
  (call) => {
    for (const receiver of ["new Object()", "o"]) {
      const source = `${receiver === "o" ? "const o = new Object();" : ""}
      ${receiver}.${call}; const urls = ['/api']; const [url] = urls; fetch(url);`;
      expect(proofFor(source, call.slice(0, call.indexOf("(")))).toEqual([
        true,
      ]);
      expect(analyzeJavaScriptStaticSource(source).endpoints).toMatchObject([
        { value: "/api" },
      ]);
    }
  },
);

it.each([
  "new globalThis.Object().hasOwnProperty('x');",
  "const o = new Object(); const a = o; const b = a; b.hasOwnProperty('x');",
  "const o = new Object(); o?.['hasOwnProperty']?.('x');",
  "const o = new Object(); const result = o.hasOwnProperty('x');",
  "const o = new Object(); o.hasOwnProperty(flag ? 'x' : 'y');",
  "const o = new Object(); o.hasOwnProperty();",
  "const o = new Object(); o.hasOwnProperty('x'); o.hasOwnProperty = patch;",
  "const o = new Object(); o.hasOwnProperty('x'); o[key] = replacement;",
  "const o = new Object(); o.hasOwnProperty('x'); Object.prototype[0] = replacement;",
  "const o = new Object(); o.hasOwnProperty('x'); Object.prototype[Symbol.toStringTag] = 'Changed';",
  "Map.prototype[0] = replacement; const o = new Object(); o.hasOwnProperty('x');",
])("proves only prior effects relevant to an empty Object: %s", (source) => {
  expect(proofFor(source)).toEqual([true]);
});

it.each([
  "function run(Object) { new Object().hasOwnProperty('x'); }",
  "Object = Replacement; new Object().hasOwnProperty('x');",
  "globalThis.Object = Replacement; new globalThis.Object().hasOwnProperty('x');",
  "new Object(proxy).hasOwnProperty('x');",
  "new Object('boxed').hasOwnProperty('x');",
  "new Object(null).hasOwnProperty('x');",
  "new Object(...args).hasOwnProperty('x');",
  "new Proxy(new Object(), handler).hasOwnProperty('x');",
  "const o = Object(); o.hasOwnProperty('x');",
  "const o = {}; o.hasOwnProperty('x');",
  "const o = make(); o.hasOwnProperty('x');",
  "const o = new Object(); o.x = 1; o.hasOwnProperty('x');",
  "const o = new Object(); o[key] = replacement; o.hasOwnProperty('x');",
  "const o = new Object(); const alias = o; alias.x = 1; o.hasOwnProperty('x');",
  "const o = new Object(); consume(o); o.hasOwnProperty('x');",
  "const o = new Object(); o.hasOwnProperty = patch; o.hasOwnProperty('x');",
  "const o = new Object(); Object.setPrototypeOf(o, custom); o.hasOwnProperty('x');",
  "const o = new Object(); Object.defineProperty(o, 'x', {get() { patch(this); }}); o.hasOwnProperty('x');",
  "Object.prototype.hasOwnProperty = patch; new Object().hasOwnProperty('x');",
  "Object.prototype[0] = replacement; new Object().hasOwnProperty('x');",
  "Object.prototype[key] = replacement; new Object().hasOwnProperty('x');",
  "consume(Object.prototype); new Object().hasOwnProperty('x');",
  "Object.setPrototypeOf(Object.prototype, custom); new Object().hasOwnProperty('x');",
  "function patch() { Object.prototype.x = replacement; } new Object().hasOwnProperty('x');",
  "new Object().hasOwnProperty({toString() { patch(Object.prototype); return 'x'; }});",
  "new Object().hasOwnProperty(proxy);",
  "new Object().hasOwnProperty(...args);",
  "new Object().hasOwnProperty(unknown);",
  "eval(code); new Object().hasOwnProperty('x');",
])("retains receiver uncertainty outside the pristine proof: %s", (source) => {
  expect(proofFor(source)).toEqual([false]);
});

it.each([
  "((o.x = 1) ? 'x' : 'y')",
  "(Object.setPrototypeOf(o, custom) ? 'x' : 'y')",
  "((Object.prototype.x = replacement) ? 'x' : 'y')",
  "(eval(code) ? 'x' : 'y')",
  "(consume(o) ? 'x' : 'y')",
])("includes effects while evaluating primitive arguments: %s", (argument) => {
  expect(
    proofFor(`const o = new Object(); o.hasOwnProperty(${argument});`),
  ).toEqual([false]);
});

it.each([
  [
    "Object.prototype[Symbol.toStringTag] = 'Changed'; new Object().toString();",
    "toString",
  ],
  [
    "const o = new Object(); o[Symbol.toStringTag] = 'Changed'; o.toString();",
    "toString",
  ],
  [
    "Object.defineProperty(Object.prototype, Symbol.toStringTag, {get() { patch(this); }}); new Object().toString();",
    "toString",
  ],
  [
    "const o = new Object(); o.toString = patch; o.toLocaleString();",
    "toLocaleString",
  ],
  [
    "Object.prototype.toString = patch; new Object().toLocaleString();",
    "toLocaleString",
  ],
  ["new Object().isPrototypeOf(new Proxy({}, handler));", "isPrototypeOf"],
  ["const o = new Object(); consume(o.valueOf());", "valueOf"],
  ["const result = new Object().valueOf();", "valueOf"],
] as const)(
  "excludes coercion, tag, locale and returned-receiver hooks: %s",
  (source, method) => {
    expect(proofFor(source, method)).toEqual([false]);
  },
);

it.each([
  "propertyIsEnumerable('x')",
  "isPrototypeOf()",
  "toString()",
  "toLocaleString()",
])("permits consumed primitive results: %s", (call) => {
  const method = call.slice(0, call.indexOf("("));
  expect(
    proofFor(`const o = new Object(); const result = o.${call};`, method),
  ).toEqual([true]);
});

it.each([
  "__defineGetter__('x', callback)",
  "__lookupGetter__('x')",
  "unknown()",
])("does not admit additional Object method contracts: %s", (call) => {
  expect(
    proofFor(`new Object().${call};`, call.slice(0, call.indexOf("("))),
  ).toEqual([false]);
});

it.each([
  [
    "new Object().hasOwnProperty('x');",
    "hasOwnProperty",
    isIntrinsicNonEscapingObjectCall,
    undefined,
  ],
  ["new Array(3).fill(0);", "fill", isIntrinsicNonEscapingArrayCall, undefined],
  ["new Map().get('x');", "get", isIntrinsicNonEscapingMapCall, true],
  [
    "new XMLHttpRequest().open('GET', '/api');",
    "open",
    isIntrinsicNonEscapingXhrOpen,
    true,
  ],
  [
    "const o = new Object(); o.hasOwnProperty('x');",
    "hasOwnProperty",
    isIntrinsicNonEscapingObjectCall,
    undefined,
  ],
  [
    "const o = new Array(3); o.fill(0);",
    "fill",
    isIntrinsicNonEscapingArrayCall,
    undefined,
  ],
  [
    "const o = new Map(); o.get('x');",
    "get",
    isIntrinsicNonEscapingMapCall,
    undefined,
  ],
  [
    "const o = new XMLHttpRequest(); o.open('GET', '/api');",
    "open",
    isIntrinsicNonEscapingXhrOpen,
    undefined,
  ],
] as const)(
  "preserves each consumer's deferred-proof contract: %s",
  (source, method, proof, initial) => {
    const { index, calls } = fixture(source, method, false);
    expect(calls).toHaveLength(1);
    expect(proof(calls[0]!, index.bindings)).toBe(initial);
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    expect(proof(calls[0]!, index.bindings, index)).toBe(true);
  },
);

it.each([
  "o.hasOwnProperty('x'); const o = new Object();",
  "const a = o; const o = new Object(); a.hasOwnProperty('x');",
  "let o; if (flag) o = new Object(); o.hasOwnProperty('x');",
  "let o = new Object(); o = other; o.hasOwnProperty('x');",
  "const {o} = {o: new Object()}; o.hasOwnProperty('x');",
  "const a = b; const b = a; a.hasOwnProperty('x');",
  "function run(o) { o.hasOwnProperty('x'); }",
])(
  "rejects unstable, projected, cyclic or uninitialized receiver chains: %s",
  (source) => {
    const { index, calls } = fixture(source, "hasOwnProperty");
    const call = calls[0]!;
    if (!t.isMemberExpression(call.callee))
      throw new Error("Expected member call");
    expect(
      semanticConstructedReceiver(call.callee.object, call, index.bindings, {
        paths: [[]],
        index,
      }),
    ).toBeUndefined();
    expect(isIntrinsicNonEscapingObjectCall(call, index.bindings, index)).toBe(
      false,
    );
  },
);

it("keeps Map member paths narrower than the whole receiver", () => {
  const source = "const o = new Map(); o.unrelated = 1; o.get('x');";
  expect(proofFor(source, "get", isIntrinsicNonEscapingMapCall)).toEqual([
    true,
  ]);
  expect(proofFor(source, "get", isIntrinsicMapLookup)).toEqual([true]);
});

it("keeps XHR request identity separate from the nonescaping receiver proof", () => {
  const { index, calls } = fixture(
    "const o = new XMLHttpRequest(); o.onreadystatechange = callback; o.open('GET', '/api');",
    "open",
  );
  expect(isIntrinsicNonEscapingXhrOpen(calls[0]!, index.bindings, index)).toBe(
    false,
  );
  expect(createXhrOpenRequestQuery(index)(calls[0]!)).toBe(true);
});

it.each([
  "new Object().hasOwnProperty('x');",
  "const a = new Object(); a.hasOwnProperty('x');",
])(
  "reconsiders pristine proofs after deferred effects reach Object.prototype: %s",
  (first) => {
    expect(
      proofFor(
        `function run() { ${first} const b = new Object(); b.x = 1; b.hasOwnProperty('x'); }`,
      ),
    ).toEqual([false, false]);
  },
);
