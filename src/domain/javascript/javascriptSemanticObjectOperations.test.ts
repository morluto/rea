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
  "void new Object().valueOf();",
  "const unused = (new Object().valueOf(), 1);",
  "(0, new Object().valueOf());",
  "void (0, new Object().valueOf());",
  "const unused = ((0, new Object().valueOf()), 1);",
  "(new Object().valueOf() as unknown)!;",
  "for (new Object().valueOf(); false;) {}",
  "for (; false; (0, new Object().valueOf())) {}",
  "flag ? new Object().valueOf() : 0;",
  "flag ? 0 : new Object().valueOf();",
  "flag && new Object().valueOf();",
  "flag || new Object().valueOf();",
  "flag ?? new Object().valueOf();",
  "void ((flag ? (0, new Object().valueOf()) : 0) as unknown)!;",
  "const unused = ((flag && new Object().valueOf()), 0);",
])(
  "preserves unrelated destructuring after a discarded Object result: %s",
  (source) => {
    expect(proofFor(source, "valueOf")).toEqual([true]);
    expect(
      analyzeJavaScriptStaticSource(
        `${source} const urls = ['/api']; const [url] = urls; fetch(url);`,
      ).endpoints.map(({ value }) => value),
    ).toEqual(["/api"]);
  },
);

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
  ["void consume(new Object().valueOf());", "valueOf"],
  ["void (holder.value = new Object().valueOf());", "valueOf"],
  ["const result = (0, new Object().valueOf());", "valueOf"],
  ["Object.prototype.valueOf = patch; void new Object().valueOf();", "valueOf"],
  [
    "void new Object().valueOf((Object.prototype.x = replacement, 0));",
    "valueOf",
  ],
  ["void new Object().valueOf(...args);", "valueOf"],
  ["function run(Object) { void new Object().valueOf(); }", "valueOf"],
  ["new Object().valueOf() ? 0 : 1;", "valueOf"],
  ["new Object().valueOf() && 0;", "valueOf"],
  ["const result = flag ? new Object().valueOf() : 0;", "valueOf"],
  ["void consume(flag && new Object().valueOf());", "valueOf"],
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

it.each(["Array", "Map"])(
  "uses Object method contracts on pristine %s receivers",
  (owner) => {
    const construction = owner === "Array" ? "new Array(3)" : "new Map()";
    const calls = [
      "hasOwnProperty('0')",
      "propertyIsEnumerable('0')",
      "isPrototypeOf(null)",
      ...(owner === "Map" ? ["toString()", "toLocaleString()"] : []),
      "valueOf()",
    ];
    for (const call of calls) {
      const method = call.slice(0, call.indexOf("("));
      for (const bound of [false, true]) {
        for (const used of method === "valueOf" ? [false] : [false, true]) {
          const source = `${bound ? `const receiver = ${construction};` : ""}
            ${used ? "const result = " : ""}${bound ? "receiver" : construction}.${call};`;
          expect(proofFor(source, method), source).toEqual([true]);
          const tail =
            owner === "Array"
              ? "const urls = ['/api']; const [url] = urls; fetch(url);"
              : "const records = new Map(); records.get('/cache');";
          expect(
            analyzeJavaScriptStaticSource(source + tail).endpoints.map(
              ({ value }) => value,
            ),
            source,
          ).toEqual(owner === "Array" ? ["/api"] : []);
        }
      }
    }
  },
);

it.each(["Array", "Map"])(
  "retains pristine %s receiver proof boundaries",
  (owner) => {
    const construction = owner === "Array" ? "new Array(3)" : "new Map()";
    const rejected = [
      `function run(${owner}) { new ${owner}().hasOwnProperty('x'); }`,
      `${owner} = Replacement; ${construction}.hasOwnProperty('x');`,
      `globalThis.${owner} = Replacement; new globalThis.${owner}().hasOwnProperty('x');`,
      `new ${owner}(unknown).hasOwnProperty('x');`,
      `new ${owner}(...args).hasOwnProperty('x');`,
      `new ${owner}({}).hasOwnProperty('x');`,
      `const o = ${construction}; o.x = 1; o.hasOwnProperty('x');`,
      `const o = ${construction}; o.hasOwnProperty = patch; o.hasOwnProperty('x');`,
      `const o = ${construction}; const alias = o; alias.x = 1; o.hasOwnProperty('x');`,
      `const o = ${construction}; consume(o); o.hasOwnProperty('x');`,
      `const o = ${construction}; Object.setPrototypeOf(o, custom); o.hasOwnProperty('x');`,
      `${owner}.prototype.hasOwnProperty = patch; ${construction}.hasOwnProperty('x');`,
      `Object.prototype.hasOwnProperty = patch; ${construction}.hasOwnProperty('x');`,
      `${owner}.prototype[0] = patch; ${construction}.hasOwnProperty('x');`,
      `${construction}.hasOwnProperty({toString() { patch(); return 'x'; }});`,
      `${construction}.hasOwnProperty(...args);`,
      `${construction}.hasOwnProperty(unknown);`,
      `eval(code); ${construction}.hasOwnProperty('x');`,
      `const o = ${construction}; o.hasOwnProperty((o.x = 1, 'x'));`,
      `${construction}.hasOwnProperty((${owner}.prototype.x = 1, 'x'));`,
      `${construction}.hasOwnProperty((Object.prototype.x = 1, 'x'));`,
      `${construction}.hasOwnProperty((eval(code), 'x'));`,
    ];
    for (const source of rejected)
      expect(proofFor(source), source).toEqual([false]);
    for (const context of [
      `const retained = ${construction}.valueOf();`,
      `consume(${construction}.valueOf());`,
      `${construction}.valueOf() && 0;`,
      `const retained = flag ? ${construction}.valueOf() : 0;`,
    ])
      expect(proofFor(context, "valueOf"), context).toEqual([false]);
    for (const context of [
      `void ${construction}.valueOf();`,
      `const unused = (${construction}.valueOf(), 0);`,
      `flag ? ${construction}.valueOf() : 0;`,
      `flag && ${construction}.valueOf();`,
    ])
      expect(proofFor(context, "valueOf"), context).toEqual([true]);
    const source = `${construction}.hasOwnProperty('x');`;
    const { index, calls } = fixture(source, "hasOwnProperty", false);
    expect(
      isIntrinsicNonEscapingObjectCall(calls[0]!, index.bindings),
    ).toBeUndefined();
  },
);

it.each([
  ["new Array(3).toString();", "toString"],
  ["new Array(3).toLocaleString();", "toLocaleString"],
  [
    "Number.prototype.toLocaleString = function() { patch(); }; new Array(1, 2).toLocaleString();",
    "toLocaleString",
  ],
  ["new Map([]).hasOwnProperty('x');", "hasOwnProperty"],
  ["new Set().hasOwnProperty('x');", "hasOwnProperty"],
  ["new Date().hasOwnProperty('x');", "hasOwnProperty"],
  ["new Map().hasOwnProperty.call(new Map(), 'x');", "call"],
  [
    "Map.prototype[Symbol.toStringTag] = 'Changed'; new Map().toString();",
    "toString",
  ],
  [
    "Object.defineProperty(Map.prototype, Symbol.toStringTag, {get() { patch(); }}); new Map().toString();",
    "toString",
  ],
  [
    "Map.prototype.toString = patch; new Map().toLocaleString();",
    "toLocaleString",
  ],
  [
    "const o = new Map(); o.toString = patch; o.toLocaleString();",
    "toLocaleString",
  ],
] as const)(
  "does not widen inherited Object dispatch: %s",
  (source, method) => {
    expect(proofFor(source, method)).toEqual([false]);
  },
);

it.each(["Array", "Map"])(
  "orders %s inherited method effects at invocation",
  (owner) => {
    const construction = owner === "Array" ? "new Array(3)" : "new Map()";
    for (const later of [
      "o.x = 1;",
      `${owner}.prototype.hasOwnProperty = patch;`,
      "Object.prototype.hasOwnProperty = patch;",
    ]) {
      expect(
        proofFor(`const o = ${construction}; o.hasOwnProperty('x'); ${later}`),
      ).toEqual([true]);
    }
    expect(
      proofFor(`const o = ${construction}; function patch() {
    ${owner}.prototype.hasOwnProperty = replacement;
  } o.hasOwnProperty('x');`),
    ).toEqual([false]);
  },
);

it.each([
  ["Map.prototype.hasOwnProperty = replacement;", "hasOwnProperty('x')"],
  ["delete Map.prototype.hasOwnProperty;", "hasOwnProperty('x')"],
  ["delete Object.prototype.hasOwnProperty;", "hasOwnProperty('x')"],
  ["Object.prototype.toString = replacement;", "toLocaleString()"],
  ["delete Object.prototype.toString;", "toString()"],
  ["delete Map.prototype[Symbol.toStringTag];", "toString()"],
  ["Object.prototype[Symbol.toStringTag] = 'Changed';", "toString()"],
  [
    "Object.defineProperty(Object.prototype, Symbol.toStringTag, {get() { patch(); }});",
    "toLocaleString()",
  ],
  ["Object.setPrototypeOf(Map.prototype, custom);", "toString()"],
  ["const o = new Map(); o[Symbol.toStringTag] = 'Changed';", "toString()"],
] as const)(
  "requires Map's own and inherited method surfaces: %s",
  (prefix, call) => {
    const receiver = prefix.startsWith("const o") ? "o" : "new Map()";
    expect(
      proofFor(
        `${prefix} ${receiver}.${call};`,
        call.slice(0, call.indexOf("(")),
      ),
    ).toEqual([false]);
  },
);
