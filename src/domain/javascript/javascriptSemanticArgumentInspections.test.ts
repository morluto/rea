import { runInNewContext } from "node:vm";
import * as t from "@babel/types";
import { expect, it } from "vitest";

import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { createSemanticArgumentInspectionQuery } from "./javascriptSemanticArgumentInspections.js";
import { collectSemanticMemberMutationsSteps } from "./javascriptSemanticMemberMutations.js";
import type { JavaScriptSemanticPrecisionInput } from "./javascriptSemanticPrecision.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const METHODS = [
  "Array.isArray",
  "Object.keys",
  "Object.values",
  "Object.entries",
  "Object.getOwnPropertyNames",
  "Object.getOwnPropertySymbols",
  "Object.getOwnPropertyDescriptors",
  "Reflect.ownKeys",
];
const capture = "const urls=['/api'];const [url]=urls;fetch(url);";
const endpoints = (
  source: string,
  precision?: JavaScriptSemanticPrecisionInput,
) =>
  analyzeJavaScriptStaticSource(source, precision).endpoints.map(
    ({ value }) => value,
  );

const fixture = (
  source: string,
  mutations = true,
  precision?: JavaScriptSemanticPrecisionInput,
) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("Expected native-inspection fixture");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(
      parsed.program,
      undefined,
      precision,
    ),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  const calls: (t.CallExpression | t.OptionalCallExpression)[] = [];
  traverseJavaScriptAst(parsed.program, {
    enter(node) {
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
        calls.push(node);
    },
  });
  if (mutations) completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const query = createSemanticArgumentInspectionQuery(index.bindings);
  return { index, calls, query };
};

const proof = (source: string) => {
  const { index, calls, query } = fixture(source);
  const call = calls.at(-1)!;
  return query.argument(call, call.arguments[0]!, index);
};

it.each(METHODS)("preserves unrelated iteration after native %s", (method) => {
  for (const allocation of [
    "new Object()",
    "new Array(3)",
    "new Array('a', 'b')",
  ]) {
    for (const source of [
      `${method}(${allocation});`,
      `const value=${allocation};const alias=value;void ${method}(alias);`,
    ]) {
      expect(proof(source)).toBe(true);
      expect(endpoints(source + capture)).toEqual(["/api"]);
    }
  }
});

it.each([
  "Array.isArray([]);",
  "Object.keys({});",
  "new Array(3);",
  "const value=new Array(3);globalThis.Array.isArray(value);",
  "const value=new Object();Object?.['keys']?.(value);",
  "const a=new Array(3);Array.isArray(a);Array.isArray(a);",
  "const o=new Object();Object.keys(o);Object.values(o);Object.entries(o);",
  "const a=new Array(3);const o=new Object();Array.isArray(a);Object.keys(o);Reflect.ownKeys(a);Object.getOwnPropertyDescriptors(o);",
  "const o=new Object();Object.keys(o, 0);",
  "const a=new Array(3);const result=Array.isArray(a);consume(result);",
  "const o=new Object();Object.keys(o);o.x=1;",
  "Array.isArray(new Array(3));Array.isArray=patch;",
  "Object.keys(new Object());consume(Object);",
  "Object.keys(new Object());Object=Replacement;",
])("retains ordinary controls and read-site ordering: %s", (source) => {
  expect(endpoints(source + capture)).toEqual(["/api"]);
});

it.each([
  "Array.isArray=patch;Array.isArray(new Array(3));",
  "Object.keys=patch;Object.keys(new Object());",
  "globalThis.Array.isArray=patch;Array.isArray(new Array(3));",
  "consume(Array);Array.isArray(new Array(3));",
  "consume(Object);Object.keys(new Object());",
  "consume(globalThis);Array.isArray(new Array(3));",
  "eval(code);Array.isArray(new Array(3));",
  "const a=new Array(3);const alias=a;alias.x=1;Array.isArray(a);",
  "const a=new Array(3);consume(a);Array.isArray(a);",
  "const o=new Object();Object.setPrototypeOf(o, custom);Object.keys(o);",
  "Object.prototype[0]=patch;Object.keys(new Object());",
  "Array.prototype[0]=patch;Object.values(new Array(3));",
  "const a=new Array(3);Array.isArray(a);consume(a);Array.isArray(a);",
  "const o=new Object();Object.keys(o);Object.keys(o,(Object.prototype[0]=patch));",
  "const o=new Object();Object.keys(o,(consume(o),0));",
  "Object.keys(new Object(),eval(code));",
  "Object.keys(new Object(),...args);",
  "Array.isArray(...[new Array(3)]);",
  "function inspect(){Array.isArray(new Array(3));}function change(){consume(Array);}",
  "function inspect(){Object.keys(new Object());}function change(){Object.keys=patch;}",
  "function inspect(){Object.keys(new Object());}function change(){consume(new Object());}",
])("keeps prior, unordered and argument-evaluation effects: %s", (source) => {
  expect(endpoints(source + capture)).not.toContain("/api");
});

it.each([
  "function inspect(Array){Array.isArray(new Array(3));}",
  "Array=Replacement;Array.isArray(new Array(3));",
  "Object=Replacement;Object.keys(new Object());",
  "Object.keys(new Object(proxy));",
  "Object.keys(new Object(null));",
  "Object.keys(new Proxy(new Object(), handler));",
  "Object.keys(new Array({}));",
  "const o={get x(){return value}};Object.values(o);",
  "const o={get x(){return value}};Object.keys(o);",
  "Object.keys(unknown);",
  "Object.keys({});",
  "const o=Object();Object.keys(o);",
  "let o;if(flag)o=new Object();Object.keys(o);",
  "Object.keys(o);const o=new Object();",
  "const {o}={o:new Object()};Object.keys(o);",
  "const a=b;const b=a;Object.keys(a);",
  "Array.isArray.call(null,new Array(3));",
  "const check=Array.isArray;check(new Array(3));",
  "const check=Array.isArray.bind(null);check(new Array(3));",
  "Reflect.apply(Array.isArray,null,[new Array(3)]);",
  "Object.getPrototypeOf(new Object());",
  "Object.is(new Object());",
  "Number.isFinite(new Array(3));",
  "const result=Object.keys(new Object());",
  "const result=Object.getOwnPropertyDescriptors(new Object());",
])("does not add shape, conversion or invocation authority: %s", (source) => {
  expect(proof(source)).toBe(false);
});

it("defers both producers and retains source sites through repeated collection", () => {
  const source = "const a=new Array(3);Array.isArray(a);Array.isArray(a);";
  const { index, calls, query } = fixture(source, false);
  for (const call of calls) {
    expect(query.receiver(call)).toBeUndefined();
    expect(query.argument(call, call.arguments[0]!)).toBeUndefined();
  }
  expect(index.bindings.ambientEscapeEffects).toEqual([]);
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  for (const call of calls)
    expect(query.argument(call, call.arguments[0]!, index)).toBe(true);
  const effects = [...index.bindings.ambientEscapeEffects];
  completeSemanticSteps(
    collectSemanticMemberMutationsSteps(
      index.bindings.program,
      index.bindings,
      index.referenceMayHaveChangedAt,
    ),
  );
  expect(index.bindings.ambientEscapeEffects).toEqual(effects);
  expect(index.bindings.arrayIterationEffects).toEqual([]);
});

it("rechecks earlier ambient candidates after a later failed native receiver", () => {
  const source =
    "function read(){Object.values(new Object());}function inspect(){Object.keys(new Object());}Object.keys=patch;";
  const { index, calls, query } = fixture(source, false);
  for (const call of calls) {
    expect(query.receiver(call, true)).toBe(false);
    expect(
      index.bindings.ambientEscapeEffects.some(({ node }) => node === call),
    ).toBe(true);
  }
});

it("rechecks earlier member candidates after a later failed argument", () => {
  const source =
    "function first(){Array.isArray(new Array(3));}function second(){Object.keys(new Object(proxy));}";
  const { index, calls, query } = fixture(source);
  const first = calls[0]!;
  expect(query.argument(first, first.arguments[0]!, index)).toBe(false);
  expect(index.bindings.arrayIterationEffects).toContain(first);
});

it.each(METHODS.filter((method) => method !== "Array.isArray"))(
  "retains returned-container escapes from %s",
  (method) => {
    for (const source of [
      `consume(${method}(new Object()));`,
      `const result=${method}(new Object());consume(result);`,
      `void (holder.result=${method}(new Object()));`,
      `${method}(new Object()).length;`,
      `${method}(new Object())&&0;`,
      `const result=(0,${method}(new Object()));`,
    ])
      expect(endpoints(source + capture)).not.toContain("/api");
  },
);

it.each(METHODS.filter((method) => method !== "Array.isArray"))(
  "retains return and await argument escapes from %s at their call sites",
  (method) => {
    for (const source of [
      `function read(){const value=new Object();return ${method}(value);}`,
      `async function read(){const value=new Object();return ${method}(value);}`,
      `async function read(){const value=new Object();await ${method}(value);}`,
      `async function read(){const value=new Object();return await ${method}(value);}`,
      `async function read(){const value=new Object();void(await ${method}(value));}`,
    ]) {
      const { index, calls, query } = fixture(source);
      const call = calls[0]!;
      const argument = call.arguments[0]!;
      // The native callable still keeps its receiver, but retaining/awaiting
      // its returned container cannot grant an argument escape exemption.
      expect(query.receiver(call, true)).toBe(true);
      expect(query.argument(call, argument, index)).toBe(false);
      expect(index.bindingForReferenceAt(argument)?.escapedPaths).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ node: call, path: [] }),
        ]),
      );
      expect(index.bindings.arrayIterationEffects).toContain(call);
    }
  },
);

it.each([
  "function read(){const value=new Array(3);return Array.isArray(value);}",
  "async function read(){const value=new Array(3);return Array.isArray(value);}",
  "async function read(){const value=new Array(3);await Array.isArray(value);}",
  "async function read(){const value=new Array(3);return await Array.isArray(value);}",
])(
  "permits the primitive inspection result in retained contexts: %s",
  (source) => {
    const { index, calls, query } = fixture(source);
    const call = calls[0]!;
    const argument = call.arguments[0]!;
    expect(query.argument(call, argument, index)).toBe(true);
    expect(index.bindingForReferenceAt(argument)?.escapedPaths).toEqual([]);
    expect(index.bindings.arrayIterationEffects).toEqual([]);
  },
);

it.each(METHODS.filter((method) => method !== "Array.isArray"))(
  "uses the shared discarded-result owner for %s",
  (method) => {
    for (const source of [
      `void ${method}(new Object());`,
      `(${method}(new Object()),0);`,
      `const value=(${method}(new Object()),0);`,
      `flag?${method}(new Object()):0;`,
      `flag?0:${method}(new Object());`,
      `flag&&${method}(new Object());`,
      `flag||${method}(new Object());`,
    ]) {
      expect(proof(source)).toBe(true);
      expect(endpoints(source + capture)).toEqual(["/api"]);
    }
  },
);

it("does not mistake primitive result slots for an unreachable prototype", () => {
  const source = "consume(Object.keys(new Object()));" + capture;
  const fetched: string[] = [];
  runInNewContext(
    "function consume(value){value.__proto__[Symbol.iterator]=function*(){yield '/changed'}};" +
      source,
    { fetch: (value: string) => fetched.push(value) },
    { timeout: 1000 },
  );
  expect(fetched).toEqual(["/changed"]);
  expect(endpoints(source)).not.toContain("/api");
});

it("keeps native getter, Proxy and conversion boundaries distinct", () => {
  const events: Record<string, string[]> = runInNewContext(
    `(() => {
    let hits=[];
    const value={get x(){hits.push('getter');return 1},[Symbol.toPrimitive](){hits.push('conversion');return 1}};
    const proxy=new Proxy(value,{
      ownKeys(target){hits.push('ownKeys');return Reflect.ownKeys(target)},
      getOwnPropertyDescriptor(target,key){hits.push('descriptor');return Reflect.getOwnPropertyDescriptor(target,key)}
    });
    const result={};
    for(const [name,operation,target] of [['array',Array.isArray,proxy],['keys',Object.keys,value],['proxy',Object.keys,proxy],['values',Object.values,value],['number',Number,value]]){
      hits=[];operation(target);result[name]=hits.slice();
    }
    return result;
  })()`,
    {},
    { timeout: 1000 },
  );
  expect(events).toEqual({
    array: [],
    keys: [],
    proxy: ["ownKeys", "descriptor"],
    values: ["getter"],
    number: ["conversion"],
  });
  for (const operation of [
    "const value={get x(){Array.prototype[Symbol.iterator]=patch}};Object.values(value);",
    "const value=new Proxy({}, {ownKeys(){Array.prototype[Symbol.iterator]=patch;return []}});Object.keys(value);",
    "Number({valueOf(){Array.prototype[Symbol.iterator]=patch;return 1}});",
  ])
    expect(endpoints(operation + capture)).not.toContain("/api");
});

it("keeps an exhausted primitive proof unknown", () => {
  const source =
    "const size=flag?1:2;const a=new Array(size);Array.isArray(a);";
  expect(endpoints(source + capture)).toEqual(["/api"]);
  const { index, calls, query } = fixture(source, true, {
    primitive_candidates: 1,
  });
  const call = calls.at(-1)!;
  expect(query.argument(call, call.arguments[0]!, index)).toBe(false);
  expect(
    endpoints(source + capture, { primitive_candidates: 1 }),
  ).not.toContain("/api");
});

it.each(["Array.isArray", "Reflect.ownKeys"])(
  "preserves native Map lookup after %s of a proven empty Map",
  (method) => {
    expect(runInNewContext(`${method}(new Map())`)).toEqual(
      method === "Array.isArray" ? false : [],
    );
    for (const bound of [false, true]) {
      for (const used of method === "Array.isArray" ? [false, true] : [false]) {
        const source = `${bound ? "const map = new Map();" : ""}
          ${used ? "const result = " : ""}${method}(${bound ? "map" : "new Map()"});`;
        const tail = "const records = new Map(); records.get('/cache');";
        expect(proof(source), source).toBe(true);
        expect(() => runInNewContext(source + tail)).not.toThrow();
        expect(endpoints(source + tail), source).toEqual([]);
      }
    }
  },
);

it.each(["Array.isArray", "Reflect.ownKeys"])(
  "keeps empty Map inspection authority bounded for %s",
  (method) => {
    const namespace = method.split(".")[0];
    for (const source of [
      `function run(Map) { ${method}(new Map()); }`,
      `Map = Replacement; ${method}(new Map());`,
      `globalThis.Map = Replacement; ${method}(new globalThis.Map());`,
      `${namespace} = replacement; ${method}(new Map());`,
      `${method} = replacement; ${method}(new Map());`,
      `const map = new Map(); map.x = 1; ${method}(map);`,
      `const map = new Map(); const alias = map; alias.x = 1; ${method}(map);`,
      `const map = new Map(); consume(map); ${method}(map);`,
      `const map = new Map(); Object.setPrototypeOf(map, custom); ${method}(map);`,
      `Map.prototype.x = 1; ${method}(new Map());`,
      `Object.prototype.x = 1; ${method}(new Map());`,
      `delete Map.prototype.get; ${method}(new Map());`,
      `Object.defineProperty(Map.prototype, Symbol.toStringTag, {get() { patch(); }}); ${method}(new Map());`,
      `function later() { Map.prototype.x = 1; } ${method}(new Map());`,
      `eval(code); ${method}(new Map());`,
      `${method}(new Map([]));`,
      `${method}(new Map(undefined));`,
      `${method}(new Map(...args));`,
      `${method}(...[new Map()]);`,
      `${method}(new Set());`,
      `${method}(new Date());`,
      `const inspect = ${method}; inspect(new Map());`,
      `${method}.call(null, new Map());`,
      `${method}.apply(null, [new Map()]);`,
      `const inspect = ${method}.bind(null); inspect(new Map());`,
    ])
      expect(proof(source), source).toBe(false);
    for (const effect of [
      "Map.prototype.x = 1",
      "Object.prototype.x = 1",
      "eval(code)",
      "consume(map)",
      "map.x = 1",
    ]) {
      const source = `const map = new Map(); ${method}(map, (${effect}, 0));`;
      expect(proof(source), source).toBe(false);
    }
    const source = `${method}(new Map());`;
    const { calls, query } = fixture(source, false);
    expect(query.argument(calls[0]!, calls[0]!.arguments[0]!)).toBeUndefined();
  },
);

it.each([
  "const result = Reflect.ownKeys(new Map());",
  "consume(Reflect.ownKeys(new Map()));",
  "Reflect.ownKeys(new Map()) && 0;",
  "const result = flag ? Reflect.ownKeys(new Map()) : 0;",
])("retains container-result uncertainty for empty Map: %s", (source) => {
  const { index, calls, query } = fixture(source);
  const call = calls.find(
    (call) =>
      t.isMemberExpression(call.callee) &&
      t.isIdentifier(call.callee.object, { name: "Reflect" }),
  )!;
  expect(query.argument(call, call.arguments[0]!, index)).toBe(false);
});

it.each(METHODS.filter((method) => method.startsWith("Object.")))(
  "preserves the existing empty Map argument boundary for %s",
  (method) => {
    for (const used of [false, true]) {
      const source = `${used ? "const result = " : ""}${method}(new Map());`;
      expect(proof(source)).toBe(false);
      expect(
        endpoints(source + "const records = new Map(); records.get('/cache');"),
      ).toEqual(["/cache"]);
    }
  },
);

it.each(["Array.isArray", "Reflect.ownKeys"])(
  "retains the selected %s callee before later arguments",
  (method) => {
    const source = `const map = new Map(); ${method}(map, (${method} = replacement, 0));`;
    expect(proof(source)).toBe(true);
    expect(() =>
      runInNewContext(source, {
        replacement() {
          throw new Error("Wrong callee");
        },
      }),
    ).not.toThrow();
  },
);
