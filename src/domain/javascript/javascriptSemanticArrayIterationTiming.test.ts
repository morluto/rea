import * as t from "@babel/types";
import { expect, it } from "vitest";

import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { collectSemanticMemberMutationsSteps } from "./javascriptSemanticMemberMutations.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticKnownArrayIteration,
  semanticKnownArrayIterationAt,
  semanticReferenceIterationUnknown,
} from "./javascriptSemanticReferenceSources.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import type { JavaScriptSemanticValue } from "./javascriptSemanticValueTypes.js";

const indexFor = (source: string, collect = true) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("Expected iteration timing fixture");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  if (collect) completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const calls: t.CallExpression[] = [];
  const spreads: t.SpreadElement[] = [];
  const captures: t.Node[] = [];
  traverseJavaScriptAst(parsed.program, {
    enter(node) {
      if (t.isCallExpression(node)) calls.push(node);
      if (t.isSpreadElement(node)) spreads.push(node);
      if (t.isForOfStatement(node)) captures.push(node.right);
      if (
        t.isVariableDeclarator(node) &&
        t.isArrayPattern(node.id) &&
        node.init != null
      )
        captures.push(node.init);
    },
  });
  return { index, calls, spreads, captures };
};

const endpointValues = (source: string) =>
  analyzeJavaScriptStaticSource(source).endpoints.map(({ value }) => value);
const allocation = "const urls=['/api'];";
const capture = "const [url]=urls;";
const fetchCaptured = "fetch(url);";
const emptyArray: JavaScriptSemanticValue = {
  status: "array",
  items: [],
  unknownItems: false,
  omittedItems: 0,
};

it.each([
  "consume(new Array(3));",
  "consume(Array.prototype);",
  "consume(Object.prototype);",
  "consume([].__proto__);",
  "consume([].constructor.prototype);",
  "Array.prototype[Symbol.iterator]=patch;",
  "Object.prototype[0]=patch;",
  "Array.prototype.constructor.prototype[Symbol.iterator]=patch;",
])("orders prototype effects at the actual capture: %s", (effect) => {
  expect(endpointValues(allocation + capture + effect + fetchCaptured)).toEqual(
    ["/api"],
  );
  expect(
    endpointValues(allocation + effect + capture + fetchCaptured),
  ).not.toContain("/api");
  expect(
    endpointValues(effect + allocation + capture + fetchCaptured),
  ).not.toContain("/api");
});

it.each([
  "function mutate(){Array.prototype[Symbol.iterator]=patch;}",
  "function mutate(){consume(new Array(3));}",
  "if(flag){Array.prototype[Symbol.iterator]=patch;}",
  "with(scope){Array.prototype[Symbol.iterator]=patch;}",
  "const Array=local;with(scope){consume(Array.prototype);}",
])("retains preceding or unordered effects: %s", (effect) => {
  expect(
    endpointValues(allocation + effect + capture + fetchCaptured),
  ).not.toContain("/api");
});

it.each([
  "Array=other;",
  "globalThis.Array=other;",
  "consume(Array);",
  "Array.prototype.fill=patch;",
  "Array.prototype.constructor.prototype.fill=patch;",
  "consume(Array.prototype.fill);",
  "const {...copy}=Array;consume(copy);",
  "consume({...Array});",
  "const Array={prototype:{}};consume(Array.prototype);",
  "function mutate(Array){Array.prototype[Symbol.iterator]=patch;}",
  "[].__proto__=patch;",
  "const globalThis={Array:{prototype:{}}};consume(globalThis.Array.prototype);",
])("does not widen the original prototype-effect domain: %s", (effect) => {
  expect(endpointValues(effect + allocation + capture + fetchCaptured)).toEqual(
    ["/api"],
  );
});

it.each([
  "consume(Array[key]);",
  "Array.prototype[key]=patch;",
  "Array.prototype[0]=patch;",
  "Array.prototype.__proto__=patch;",
  "Array.prototype.constructor.prototype.constructor.prototype[0]=patch;",
  "consume({...Array.prototype});",
  "const {...copy}=Array.prototype;consume(copy);",
  "consume({...([].__proto__)});",
  "consume({...([].constructor.prototype)});",
])(
  "retains unknown, numeric, inherited, and copied prototype effects: %s",
  (effect) => {
    expect(
      endpointValues(effect + allocation + capture + fetchCaptured),
    ).not.toContain("/api");
  },
);

it("keeps own iterator writes ordered around destructuring capture", () => {
  const effect = "urls[Symbol.iterator]=patch;";
  expect(endpointValues(allocation + capture + effect + fetchCaptured)).toEqual(
    ["/api"],
  );
  expect(
    endpointValues(allocation + effect + capture + fetchCaptured),
  ).not.toContain("/api");
});

it.each([
  ["consume(...urls,(Array.prototype[Symbol.iterator]=patch,0));", true],
  ["consume((Array.prototype[Symbol.iterator]=patch,0),...urls);", false],
  ["consume(...urls);Array.prototype[Symbol.iterator]=patch;", true],
  ["Array.prototype[Symbol.iterator]=patch;consume(...urls);", false],
] as const)("uses the original spread operand: %s", (body, known) => {
  const { index, spreads } = indexFor(allocation + body);
  expect(spreads).toHaveLength(1);
  expect(
    semanticKnownArrayIterationAt(spreads[0]!.argument, index.bindings),
  ).toBe(known);
});

it("orders one prototype effect independently between two argument reads", () => {
  const { index, spreads } = indexFor(
    "const left=['/left'];const right=['/right'];consume(...left,(Array.prototype[Symbol.iterator]=patch,0),...right);",
  );
  expect(
    spreads.map(({ argument }) =>
      semanticKnownArrayIterationAt(argument, index.bindings),
    ),
  ).toEqual([true, false]);
});

it.each(["const [url]=urls;", "const [...rest]=urls;"])(
  "checks actual iteration after allocation for %s",
  (read) => {
    for (const before of [false, true]) {
      const effect = "consume(new Array(3));";
      const { index, captures } = indexFor(
        allocation + (before ? effect + read : read + effect),
      );
      expect(captures).toHaveLength(1);
      expect(
        semanticReferenceIterationUnknown(
          { iterationSources: [{ node: captures[0]!, projection: [] }] },
          index.bindings,
        ),
      ).toBe(before);
    }
  },
);

it("does not treat unknown array items as an iterator mutation, including empty arrays", () => {
  const { index } = indexFor("const value=[];");
  const read = index.bindings.program.body[0]!;
  const unknownItems: JavaScriptSemanticValue = {
    ...emptyArray,
    status: "array",
    items: [],
    unknownItems: true,
    omittedItems: null,
  };
  expect(semanticKnownArrayIteration(emptyArray, index.bindings, read)).toBe(
    true,
  );
  expect(semanticKnownArrayIteration(unknownItems, index.bindings, read)).toBe(
    true,
  );
  index.bindings.arrayIterationEffects.push(undefined);
  expect(semanticKnownArrayIteration(emptyArray, index.bindings, read)).toBe(
    false,
  );
  expect(semanticKnownArrayIteration(unknownItems, index.bindings, read)).toBe(
    false,
  );
});

it.each([
  "(flag?[]:[]).__proto__",
  "(flag&&[]).__proto__",
  "(0,[]).constructor.prototype",
  "{nested:(flag?[]:[]).__proto__}",
])(
  "replays cached literal prototype leaves with each original call site: %s",
  (result) => {
    const { index, calls } = indexFor(
      `function source(){return ${result};} consume(source());consume(source());`,
    );
    const mutations = calls.filter((call) =>
      t.isIdentifier(call.callee, { name: "source" }),
    );
    expect(mutations).toHaveLength(2);
    expect(index.bindings.arrayIterationEffects).toEqual(mutations);
    const original = [...index.bindings.arrayIterationEffects];
    completeSemanticSteps(
      collectSemanticMemberMutationsSteps(
        index.bindings.program,
        index.bindings,
        index.referenceMayHaveChangedAt,
      ),
    );
    expect(index.bindings.arrayIterationEffects).toEqual(original);
  },
);

it("invalidates returned-reference results when iteration effects are discovered", () => {
  const { index, calls } = indexFor(
    "consume(new Array(3));function first(){return a;}function second(){return b;}const values=[first,second];const selected=[...values][0];selected();",
    false,
  );
  const invocation = calls.find((call) =>
    t.isIdentifier(call.callee, { name: "selected" }),
  );
  if (invocation === undefined) throw new Error("Expected selected invocation");
  const returnedReferences = createSemanticReturnedReferences(index.bindings);
  const names = () =>
    [...returnedReferences(invocation.callee, invocation).callables].map(
      (node) => (t.isFunctionDeclaration(node) ? node.id?.name : undefined),
    );
  expect(names()).toEqual(["first"]);
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  expect(index.bindings.arrayIterationEffects.length).toBeGreaterThan(0);
  expect(names()).toEqual(["first", "second"]);
});

it("checks a copied callable at its spread capture rather than its array initializer", () => {
  const source =
    "function first(){return a;}function second(){return b;}const values=[first,second];";
  for (const before of [false, true]) {
    const effect = "consume(new Array(3));";
    const copy = "const selected=[...values][0];";
    const { index, calls } = indexFor(
      source + (before ? effect + copy : copy + effect) + "selected();",
    );
    const invocation = calls.find((call) =>
      t.isIdentifier(call.callee, { name: "selected" }),
    );
    if (invocation === undefined)
      throw new Error("Expected selected invocation");
    const result = createSemanticReturnedReferences(index.bindings)(
      invocation.callee,
      invocation,
    );
    expect(
      [...result.callables].map((node) =>
        t.isFunctionDeclaration(node) ? node.id?.name : undefined,
      ),
    ).toEqual(before ? ["first", "second"] : ["first"]);
  }
});

it.each([
  ["for(const url of urls){}", false],
  ["for(const url of urls){}consume(new Array(3));", false],
  ["consume(new Array(3));for(const url of urls){}", true],
] as const)(
  "orders effects around top-level for-of entry: %s",
  (body, unknown) => {
    const { index, captures } = indexFor(allocation + body);
    expect(
      semanticReferenceIterationUnknown(
        { iterationSources: [{ node: captures[0]!, projection: [] }] },
        index.bindings,
      ),
    ).toBe(unknown);
  },
);

it("orders shared iteration facts independently for two reads of the same operand", () => {
  const { index, spreads } = indexFor(
    allocation +
      "consume(...urls,(Array.prototype[Symbol.iterator]=patch,0),...urls);",
  );
  // Isolate the iteration owner: the general value owner conservatively loses
  // this binding's shape when the second spread also exposes its root.
  expect(
    spreads.map(({ argument }) =>
      semanticKnownArrayIteration(emptyArray, index.bindings, argument),
    ),
  ).toEqual([true, false]);
});

it("invalidates a warm returned-reference cache on the iteration revision alone", () => {
  const { index, calls } = indexFor(
    "function first(){return a;}function second(){return b;}const values=[first,second];const selected=[...values][0];selected();",
  );
  const invocation = calls.find((call) =>
    t.isIdentifier(call.callee, { name: "selected" }),
  );
  if (invocation === undefined) throw new Error("Expected selected invocation");
  const returnedReferences = createSemanticReturnedReferences(index.bindings);
  const names = () =>
    [...returnedReferences(invocation.callee, invocation).callables].map(
      (node) => (t.isFunctionDeclaration(node) ? node.id?.name : undefined),
    );
  const revisions = () => [
    index.bindings.ambientWriteEffects.length,
    index.bindings.ambientEscapeEffects.length,
    ...[...index.bindings.bindingsById.values()].flatMap((binding) => [
      binding.memberWrites.length,
      binding.escapedPaths.length,
    ]),
  ];
  expect(names()).toEqual(["first"]);
  const unchanged = revisions();
  index.bindings.arrayIterationEffects.push(undefined);
  expect(revisions()).toEqual(unchanged);
  expect(names()).toEqual(["first", "second"]);
});

it.each([
  ["['/api']", "source[0]"],
  ["[{url:'/api'}]", "source[0].url"],
])(
  "does not escape an earlier for-of source after a later prototype effect: %s",
  (value, selected) => {
    const create = `const source=${value};`;
    const loop = "for(const item of source){}";
    const effect = "consume(new Array(3));";
    expect(
      endpointValues(create + loop + `fetch(${selected});` + effect),
    ).toEqual(["/api"]);
    expect(
      endpointValues(create + effect + loop + `fetch(${selected});`),
    ).not.toContain("/api");
  },
);

it.each([
  "for(const item of (consume(new Array(3)),source)){}",
  "for(const item of (Array.prototype[Symbol.iterator]=patch,source)){}",
])("retains effects inside the for-of iterable expression: %s", (loop) => {
  const { index, captures } = indexFor("const source=['/api'];" + loop);
  expect(index.bindings.arrayIterationEffects.length).toBeGreaterThan(0);
  expect(
    index.bindings.arrayIterationEffects.every(
      (effect) =>
        semanticEffectTiming(captures[0]!, effect, index.bindings) !== "after",
    ),
  ).toBe(true);
  expect(
    semanticKnownArrayIteration(emptyArray, index.bindings, captures[0]!),
  ).toBe(false);
});

it.each([
  "for(const read of source){}",
  "for(const item of source){read;}",
  "while(flag){for(const item of read){}}",
  "for(;;){for(const item of read){}}",
  "function run(){for(const item of read){}}",
  "for(const key in read){}",
  "class Example{value=read;}",
])(
  "does not extend the for-of entry proof to repeated or delayed reads: %s",
  (body) => {
    const { index, calls } = indexFor(
      "const source=['/api'];" + body + "consume(new Array(3));",
    );
    let read: t.Identifier | undefined;
    traverseJavaScriptAst(index.bindings.program, {
      enter(node) {
        if (t.isIdentifier(node, { name: "read" })) read = node;
      },
    });
    const effect = calls.find((node) =>
      t.isIdentifier(node.callee, { name: "consume" }),
    );
    if (read === undefined || effect === undefined)
      throw new Error("Expected read and effect");
    expect(semanticEffectTiming(read, effect, index.bindings)).toBe("unknown");
  },
);

it("keeps missing source ownership and missing effects unordered", () => {
  const { index, calls } = indexFor("consume(new Array(3));");
  expect(
    semanticEffectTiming(t.identifier("unowned"), calls[0], index.bindings),
  ).toBe("unknown");
  expect(
    semanticEffectTiming(index.bindings.program, undefined, index.bindings),
  ).toBe("unknown");
});
