import { expect } from "vitest";

import {
  verifyJavaScriptReturnShapes,
  type JavaScriptReturnFields,
} from "../../fixtures/javascriptReturnShapes.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const writes = {
  direct: "const get = () => shared; get().x = 2;",
  captured: "const get = () => shared; const t = get(); t.x = 2;",
  declaration:
    "function get() { return shared; } const o = {}; o.a = get(); o.a.x = 2;",
  immediate: "const o = {}; o.a = (() => shared)(); o.a.x = 2;",
  method:
    "const box = {get() { return shared; }}; const o = {}; o.a = box.get(); o.a.x = 2;",
  methodDirect: "const box = {get() { return shared; }}; box.get().x = 2;",
  quotedMethod:
    "const box = {['get/ref']() { return shared; }}; box['get/ref']().x = 2;",
  alias: "const get = () => shared; const another = get; another().x = 2;",
  alternative: "const get = true ? () => shared : () => ({x: 0}); get().x = 2;",
  nestedReturn: "const get = () => ({child: shared}); get().child.x = 2;",
  arrayReturn: "const get = () => [shared]; get()[0].x = 2;",
  returnedProperty:
    "const holder = {inner: shared}; const get = () => holder.inner; get().x = 2;",
  transitive:
    "const first = () => shared; const second = () => first(); second().x = 2;",
  updated: "const get = () => shared; get().x++;",
  asyncAwait: "const get = async () => shared; const t = await get(); t.x = 2;",
  generator:
    "function* get() { yield shared; } for (const t of get()) t.x = 2;",
  returnedYield:
    "function* get() { return yield shared; } for (const t of get()) t.x = 2;",
  delegatedYield:
    "function* get() { yield* [shared]; } for (const t of get()) t.x = 2;",
  recursiveWrapper:
    "let count = 0; const get = () => count++ === 0 ? {child: get()} : shared; get().child.x = 2;",
  destructuredMethod:
    "const box = {get() { return shared; }}; const {get} = box; get().x = 2;",
  arrayCallable: "const methods = [() => shared]; methods[0]().x = 2;",
  spreadArrayCallable:
    "const methods = [...[], () => shared]; methods[0]().x = 2;",
  classMethod:
    "class Box { get() { return shared; } } const box = new Box(); box.get().x = 2;",
  staticMethod:
    "class Box { static get() { return shared; } } Box.get().x = 2;",
  constructor:
    "function Box() { return shared; } const t = new Box(); t.x = 2;",
  callback: "const get = () => shared; [0].forEach(() => { get().x = 2; });",
};
const source = [
  ...Object.entries(writes).map(
    ([name, body]) =>
      `export ${name === "asyncAwait" ? "async " : ""}function ${name}(){ const shared = {x: 1}; ${body} return shared.x; }`,
  ),
  "export function directSibling(){ const shared = {x: 1}; const parent = {shared, keep: 7}; const get = () => parent.shared; get().x = 2; return {x: shared.x, keep: parent.keep}; }",
  "export function primitive(){ const n = 1; const get = () => n; const t = get(); return n; }",
  "export function copy(){ const shared = {x: 1}; const get = () => ({...shared}); get().x = 2; return shared.x; }",
  "export function methodCopy(){ const shared = {x: 1}; const box = {get(){ return {...shared}; }}; box.get().x = 2; return shared.x; }",
  "export function arrayCopy(){ const shared = {x: 1}; const get = () => [shared.x]; get()[0] = 2; return shared.x; }",
  "export function unused(){ const shared = {x: 1}; const get = () => shared; get(); return shared.x; }",
  "export function nestedCallable(){ const shared = {x: 1}; const get = () => { const inner = () => shared; return {x: 0}; }; get().x = 2; return shared.x; }",
  "export function unrelated(){ const shared = {x: 1}; const other = {x: 9}; const get = () => shared; get().x = 2; return other.x; }",
].join("\n");

const assertReturns = (fields: JavaScriptReturnFields): void => {
  for (const name of Object.keys(writes)) {
    const field = fields(name).find(({ path }) => path === "");
    expect(field?.state, name).toMatch(/^(unknown|literal)$/);
    if (field?.state === "literal") expect(field.value, name).toBe(2);
  }
  const changed = fields("directSibling").find(({ path }) => path === "/x");
  expect(changed?.state).toMatch(/^(unknown|literal)$/);
  if (changed?.state === "literal") expect(changed.value).toBe(2);
  expect(fields("directSibling")).toContainEqual(
    expect.objectContaining({ path: "/keep", state: "literal", value: 7 }),
  );
  for (const name of [
    "primitive",
    "copy",
    "methodCopy",
    "arrayCopy",
    "nestedCallable",
  ])
    expect(fields(name), name).toContainEqual(
      expect.objectContaining({ path: "", state: "literal", value: 1 }),
    );
  const unused = fields("unused").find(({ path }) => path === "");
  expect(unused?.state).toMatch(/^(unknown|literal)$/);
  if (unused?.state === "literal") expect(unused.value).toBe(1);
  expect(fields("unrelated")).toContainEqual(
    expect.objectContaining({ path: "", state: "literal", value: 9 }),
  );
};

cliTest(
  "preserves mutation uncertainty for objects returned by local calls",
  ({ cli }) => verifyJavaScriptReturnShapes(cli, source, assertReturns),
  120_000,
);
