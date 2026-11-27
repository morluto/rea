import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";

const returned = (source: string) =>
  onlyCallable(analyzeJavaScriptSemantics(source), "observe").returnSites[0]
    ?.value;

// Each form may run code that receives `state`; the equivalent explicit call
// already yields an unknown value.
it.each([
  [
    "a JSX attribute",
    `export function observe() { const state = { v: 1 }; const r = <Foo p={state} />; return state.v; }`,
  ],
  [
    "a JSX spread attribute",
    `export function observe() { const state = { v: 1 }; const r = <Foo {...state} />; return state.v; }`,
  ],
  [
    "a yielded value",
    `export function* observe() { const state = { v: 1 }; yield state; return state.v; }`,
  ],
  [
    "a dynamic import specifier",
    `export async function observe() { const state = { v: 1, toString() { this.v = 2; return "x"; } }; import(state); return state.v; }`,
  ],
  [
    "dynamic import options",
    `export async function observe() { const state = { v: 1, get with() { this.v = 2; return undefined; } }; import("x", state); return state.v; }`,
  ],
  [
    "a decorated class holding the value",
    `export function observe() { const state = { v: 1 }; const dec = (c) => c; @dec class C { static s = state; } return state.v; }`,
  ],
  [
    "a decorated instance method returning the value",
    `export function observe() { const state = { v: 1 }; const dec = (target, key, descriptor) => { descriptor.value().v = 2; }; class C { @dec m() { return state; } } return state.v; }`,
  ],
  [
    "a decorated instance field initialized with the value",
    `export function observe() { const state = { v: 1 }; const dec = (target, key) => {}; class C { @dec f = () => state; } return state.v; }`,
  ],
  [
    "a class decorator receiving a getter's receiver",
    `export function observe() { const consume = (o) => { o.v = 2; return (c) => c; }; const state = { v: 1, get trigger() { @consume(this) class C {} return 0; } }; const x = state.trigger; return state.v; }`,
  ],
  [
    "a member decorator receiving a getter's receiver",
    `export function observe() { const consume = (o) => { o.v = 2; return () => {}; }; const state = { v: 1, get trigger() { class C { @consume(this) m() {} } return 0; } }; const x = state.trigger; return state.v; }`,
  ],
  [
    "a with-statement scope object",
    `export function observe() { const state = { v: 1, get x() { this.v = 2; return 0; } }; with (state) { x; } return state.v; }`,
  ],
  [
    "array spread inside a getter",
    `export function observe() { const state = { v: 1, *[Symbol.iterator]() { this.v = 2; }, get trigger() { const a = [...this]; return 0; } }; const x = state.trigger; return state.v; }`,
  ],
  [
    "JSX inside a getter",
    `export function observe() { const state = { v: 1, get trigger() { return <Foo p={this} />; } }; const x = state.trigger; return state.v; }`,
  ],
  [
    "dynamic import inside a getter",
    `export function observe() { const state = { v: 1, toString() { this.v = 2; return "x"; }, get trigger() { import(this); return 0; } }; const x = state.trigger; return state.v; }`,
  ],
  [
    "a with-statement inside a getter",
    `export function observe() { const state = { v: 1, get x() { this.v = 2; return 0; }, get trigger() { with (this) { x; } return 0; } }; const y = state.trigger; return state.v; }`,
  ],
  [
    "for-in over a Proxy whose traps capture the value",
    `export function observe() { const state = { v: 1 }; const handler = { ownKeys() { state.v = 2; return []; } }; const proxy = new Proxy({}, handler); for (const key in proxy) {} return state.v; }`,
  ],
])("does not keep a literal across %s", (_, source) => {
  expect(returned(source)?.status).toBe("unknown");
});

it.each([
  [
    "JSX that receives another value",
    `export function observe() { const state = { v: 1 }; const other = { w: 2 }; const r = <Foo p={other} />; return state.v; }`,
  ],
  [
    "a yielded primitive",
    `export function* observe() { const state = { v: 1 }; yield 3; return state.v; }`,
  ],
  [
    "an undecorated class",
    `export function observe() { const state = { v: 1 }; class C { static s = state; } return state.v; }`,
  ],
  [
    "for-in over an ordinary object",
    `export function observe() { const state = { v: 1 }; for (const key in state) {} return state.v; }`,
  ],
])("keeps the literal across %s", (_, source) => {
  expect(returned(source)).toEqual({ status: "literal", value: 1 });
});

it.each([
  [
    "a leading getter inside a sequence call target",
    `export function observe() { const state = { v: 1, get trigger() { this.v = 2; return 0; } }; const fn = () => {}; (state.trigger, fn)(); return state.v; }`,
  ],
  [
    "a trailing member getter inside a pure sequence call target",
    `export function observe() { const state = { v: 1, get method() { this.v = 2; return () => {}; } }; (0, state.method)(); return state.v; }`,
  ],
  [
    "a leading call inside a sequence call target",
    `export function observe() { const state = { v: 1 }; const touch = (o) => { o.v = 2; }; const fn = () => {}; (touch(state), fn)(); return state.v; }`,
  ],
])("does not hide side effects across %s", (_, source) => {
  expect(returned(source)?.status).toBe("unknown");
});
