import * as t from "@babel/types";
import { expect, it } from "vitest";

import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import {
  semanticClassPropertyReferences,
  semanticNativePrototypeChain,
  semanticObjectPropertyReferences,
} from "./javascriptSemanticObjectReferences.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { getterExpansionSource } from "../../../tests/fixtures/javascriptGetterExpansion.js";

const objectAndState = (source: string) => {
  const parsed = parseJavaScriptSource(source, "object.js");
  if (parsed === null) throw new Error("Expected a parsed fixture");
  const declaration = parsed.program.body[0];
  if (!t.isVariableDeclaration(declaration))
    throw new Error("Expected a declaration");
  const init = declaration.declarations[0]?.init;
  if (!t.isObjectExpression(init)) throw new Error("Expected an object");
  return {
    object: init,
    source,
    state: completeSemanticSteps(indexJavaScriptBindingsSteps(parsed.program)),
  };
};

const spelled = (
  fixture: ReturnType<typeof objectAndState>,
  key: string | number | null,
) =>
  semanticObjectPropertyReferences(fixture.object, [key], fixture.state).map(
    ({ node, path }) => [
      fixture.source.slice(node.start ?? 0, node.end ?? 0),
      JSON.stringify(path),
    ],
  );

it.each([
  ["{}", "then", ["Object"]],
  ["{then:null}", "then", []],
  ["{then}", "then", []],
  ["{...{then:null}}", "then", []],
  ["{...unknown}", "then", ["Object"]],
  ["{__proto__:null}", "then", []],
  ["{__proto__:{}}", "then", []],
  ["{__proto__:0}", "then", ["Object"]],
  ["{__proto__:unknown}", "then", ["Object"]],
  ['{["__proto__"]:null}', "then", ["Object"]],
  ["[]", "then", ["Array", "Object"]],
  ["[]", "length", []],
  ["[value]", "0", []],
  ["[,value]", "0", ["Array", "Object"]],
  ["[value,...unknown]", "0", []],
  ["[...unknown,value]", "0", ["Array", "Object"]],
] as const)(
  "retains possible native prototype lookup for %s[%s]",
  (value, key, expected) => {
    const parsed = parseJavaScriptSource(`const o=${value};`, "prototype.mjs");
    const declaration = parsed?.program.body[0];
    if (!t.isVariableDeclaration(declaration))
      throw new Error("Expected declaration");
    const node = declaration.declarations[0]?.init;
    if (!t.isObjectExpression(node) && !t.isArrayExpression(node))
      throw new Error("Expected literal");
    expect(semanticNativePrototypeChain(node, key)).toEqual(expected);
  },
);

it("resolves exact keys with source-order overrides, spreads and accessors", () => {
  const fixture = objectAndState(
    `const o = { a: 1, ...base, b: 2, a: 3, [dynamic]: 4, __proto__: proto, ...{ b: 5 }, get c() { return 6; }, c: 7 };`,
  );
  // Later definite own fields exclude earlier computed-key alternatives.
  expect(spelled(fixture, "a")).toEqual([
    ["{ b: 5 }", '["a"]'],
    ["4", "[]"],
    ["3", "[]"],
  ]);
  expect(spelled(fixture, "b")).toEqual([["{ b: 5 }", '["b"]']]);
  expect(spelled(fixture, "c")).toEqual([["7", "[]"]]);
  expect(spelled(fixture, "missing")).toEqual([
    ["{ b: 5 }", '["missing"]'],
    ["proto", '["missing"]'],
    ["4", "[]"],
    ["base", '["missing"]'],
  ]);
  // A wildcard keeps possible slots, excluding data replaced by a known spread.
  expect(spelled(fixture, null)).toEqual([
    ["7", "[]"],
    ["{ b: 5 }", '[{"excludedKeys":["c"]}]'],
    ["proto", "[null]"],
    ["4", "[]"],
    ["3", "[]"],
    ["base", '[{"excludedKeys":["a","b","c"]}]'],
  ]);
  // Numeric keys use the same exact spelling as string keys.
  expect(
    spelled(objectAndState(`const o = { 1: "one", 2: "two" };`), 1),
  ).toEqual([['"one"', "[]"]]);
});

it.each([1, "1"])(
  "preserves inherited numeric property selection %j and own shadowing",
  (key) => {
    expect(
      spelled(objectAndState("const o = { __proto__: prototype };"), key),
    ).toEqual([["prototype", JSON.stringify([String(key)])]]);
    expect(
      spelled(
        objectAndState('const o = { __proto__: prototype, 1: "own" };'),
        key,
      ),
    ).toEqual([['"own"', "[]"]]);
  },
);

it.each([
  [
    "static",
    "static method(){return 1;} method(){return 2;}",
    "static method(){return 1;}",
  ],
  [
    "instance",
    "static method(){return 1;} method(){return 2;}",
    "method(){return 2;}",
  ],
  [
    "prototype",
    "static method(){return 1;} method(){return 2;}",
    "method(){return 2;}",
  ],
  ["static", "static method(){return 1;} static set method(value){}", null],
  ["static", "static method=child; static method(){return 1;}", "child"],
  [
    "static",
    "static get method(){return child;} static method(){return 1;}",
    "static method(){return 1;}",
  ],
  [
    "static",
    "static method(){return 1;} static get method(){return child;}",
    "child",
  ],
  [
    "static",
    "static get method(){return child;} static method(){return 1;} static set method(value){}",
    null,
  ],
] as const)(
  "selects method-valued %s descriptors with runtime precedence: %s",
  (kind, body, expected) => {
    const source = `class Box { ${body} }`;
    const parsed = parseJavaScriptSource(source, "methods.mjs");
    if (parsed === null) throw new Error("Expected a parsed class");
    const owner = parsed.program.body[0];
    if (!t.isClassDeclaration(owner)) throw new Error("Expected a class");
    const state = completeSemanticSteps(
      indexJavaScriptBindingsSteps(parsed.program),
    );
    expect(
      semanticClassPropertyReferences({ owner, kind }, ["method"], state).map(
        ({ node }) => source.slice(node.start ?? 0, node.end ?? 0),
      ),
    ).toEqual(expected === null ? [] : [expected]);
  },
);

it.each(["method(){return 1;}", "...{method: child}"])(
  "keeps an intervening object data definition between accessor pairs: %s",
  (definition) => {
    expect(
      spelled(
        objectAndState(
          `const o = { get method(){return child;} , ${definition}, set method(value){} };`,
        ),
        "method",
      ),
    ).toEqual([]);
  },
);

it.each(["static", "instance"] as const)(
  "retains inherited %s field ownership for enumerable copies",
  (kind) => {
    const source = `class Base { ${kind === "static" ? "static" : ""} method=child; } class Box extends Base {}`;
    const parsed = parseJavaScriptSource(source, "fields.mjs");
    if (parsed === null) throw new Error("Expected a parsed class");
    const owner = parsed.program.body[1];
    if (!t.isClassDeclaration(owner)) throw new Error("Expected derived class");
    const state = completeSemanticSteps(
      indexJavaScriptBindingsSteps(parsed.program),
    );
    const references = semanticClassPropertyReferences(
      { owner, kind, fieldsOnly: true },
      ["method"],
      state,
    );
    expect(
      references.map(({ node }) =>
        source.slice(node.start ?? 0, node.end ?? 0),
      ),
    ).toEqual(["child"]);
    expect(references[0]?.inherited).toBe(kind === "static" ? true : undefined);
  },
);

it("preserves references through a small static getter permutation", () => {
  const getters = Array.from(
    { length: 5 },
    (_, index) =>
      `static get field${index}() { return this[key].field${index}; }`,
  ).join("\n");
  const source = `const key = getKey(); const shared = {}; class Request {
    ${getters}
    static get state() { return shared; }
  }`;
  const parsed = parseJavaScriptSource(source, "getters.js");
  if (parsed === null) throw new Error("Expected a parsed fixture");
  const klass = parsed.program.body.find((node): node is t.ClassDeclaration =>
    t.isClassDeclaration(node),
  );
  if (klass === undefined) throw new Error("Expected a class declaration");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const references = semanticClassPropertyReferences(
    { owner: klass, kind: "static" },
    ["field0"],
    state,
  );

  expect(
    references.some(
      ({ node }) => source.slice(node.start ?? 0, node.end ?? 0) === "shared",
    ),
  ).toBe(true);
  const distinctReferences = new Set(
    references.map(({ node, path, escapes }) =>
      JSON.stringify([node.start, node.end, path, escapes]),
    ),
  );
  expect(references).toHaveLength(distinctReferences.size);
});

it("widens a large static getter permutation to one escaped reference", () => {
  const source = getterExpansionSource(30).replaceAll("get ", "static get ");
  const parsed = parseJavaScriptSource(source, "getters.js");
  if (parsed === null) throw new Error("Expected a parsed fixture");
  const klass = parsed.program.body.find((node): node is t.ClassDeclaration =>
    t.isClassDeclaration(node),
  );
  if (klass === undefined) throw new Error("Expected a class declaration");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const references = semanticClassPropertyReferences(
    { owner: klass, kind: "static" },
    ["field0"],
    state,
  );

  expect(references).toHaveLength(1);
  expect(references[0]).toMatchObject({
    node: { type: "Identifier", name: "shared" },
    path: [],
    escapes: true,
  });
  expect([...state.getterResourceLimits]).toEqual(["getter-expansion"]);
});
