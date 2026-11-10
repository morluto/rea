import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * `node:child_process` validates a literal `stdio` string before it creates anything, so a
 * rejected value throws from the call itself and no child exists.
 *
 * Measured on Node 24.22.1: `"pipe"`, `"overlapped"`, `"inherit"` and `"ignore"` start a
 * child, while `"ipc"`, `"PIPE"`, `"pipe "`, `"pipeline"`, `"stream"` and `"stdio"` throw
 * `ERR_INVALID_ARG_VALUE`. The set is exact and case-sensitive. `fork` appends `"ipc"` to a
 * string and splits it, so an empty string becomes the lone element `"ipc"`, which `fork`
 * refuses — `spawn(..., {stdio: ""})` still starts a child.
 */
const spawnsFor = (body: string) =>
  analyzeJavaScriptSemantics(
    `import cp from "node:child_process";\nfunction g() { ${body}; }`,
  ).childProcessSpawns;

it.each([
  [`cp.spawn("x", [], { stdio: "bad" })`],
  [`cp.spawn("x", [], { stdio: "PIPE" })`],
  [`cp.spawn("x", [], { stdio: "pipe " })`],
  [`cp.spawn("x", [], { stdio: "ipc" })`],
  [`cp.spawn("x", [], { stdio: "pipeline" })`],
  [`cp.spawn("x", [], { stdio: "stdio" })`],
  [`cp.fork("x", [], { stdio: "bad" })`],
  [`cp.fork("x", [], { stdio: "" })`],
  ['cp.spawn("x", [], { stdio: `ipc` })'],
] as const)("emits no spawn for a rejected stdio string: %s", (call) => {
  expect(spawnsFor(call)).toEqual([]);
});

it.each([
  [`cp.spawn("x", [], { stdio: "pipe" })`],
  [`cp.spawn("x", [], { stdio: "overlapped" })`],
  [`cp.spawn("x", [], { stdio: "inherit" })`],
  [`cp.spawn("x", [], { stdio: "ignore" })`],
  [`cp.spawn("x", [], { stdio: "" })`],
  [`cp.fork("x", [], { stdio: "pipe" })`],
  ['cp.spawn("x", [], { stdio: `pipe` })'],
  // `exec` spreads its options and validates none of them, and async `execFile` does not
  // forward `stdio` to its underlying spawn at all, so both return a real child.
  [`cp.exec("x", { stdio: "bad" })`],
  [`cp.execFile("x", [], { stdio: "bad" })`],
] as const)("keeps the spawn for an accepted stdio string: %s", (call) => {
  expect(spawnsFor(call)).toHaveLength(1);
});

it.each([
  // A binding is not a literal, so this file leaves the answer to the runtime.
  [`const s = "bad"; cp.spawn("x", [], { stdio: s })`],
  [`cp.spawn("x", [], { stdio: ["pipe"] })`],
] as const)("leaves an undecided stdio undecided: %s", (call) => {
  expect(spawnsFor(call)).toHaveLength(1);
});

// Invalid literal paths and argv0 values fail before child creation. Unknown
// constructor results are covered separately and must retain their candidates.
it.each([
  [`cp.spawn("x", [], { cwd: 5 })`],
  [`cp.spawn("x", [], { cwd: true })`],
  [`cp.spawn("x", [], { cwd: {} })`],
  [`cp.spawn("x", [], { cwd: [] })`],
  [`cp.spawn("x", [], { cwd: 0 })`],
  [`cp.spawn("x", [], { argv0: 5 })`],
  [`cp.fork("x", [], { cwd: 5 })`],
  [`cp.exec("x", { cwd: 5 })`],
  [`cp.execFile("x", [], { cwd: 5 })`],
  [`cp.spawn("x", [], { cwd: 1n })`],
  [`cp.spawn("x", [], { cwd: /x/ })`],
  [`cp.spawn("x", [], { cwd: () => {} })`],
  [`cp.spawn("x", [], { cwd: class {} })`],
  [`cp.spawn("x", [], { argv0: 1n })`],
] as const)("emits no spawn for a non-string cwd or argv0: %s", (call) => {
  expect(spawnsFor(call)).toEqual([]);
});

it.each([
  [`cp.spawn("x", [], { cwd: "/tmp" })`],
  [`cp.spawn("x", [], { cwd: null })`],
  [`cp.spawn("x", [], { cwd: "" })`],
  [`cp.spawn("x", [], { argv0: "x" })`],
  [`cp.spawn("x", [], { argv0: null })`],
  // Node accepts any `env` value, so a non-object one is not a call-site failure.
  [`cp.spawn("x", [], { env: 5 })`],
  // A binding is not a literal, so this file leaves the answer to the runtime.
  [`const c = "/tmp"; cp.spawn("x", [], { cwd: c })`],
  // A no-substitution template is the same string to Node.
  ['cp.spawn("x", [], { cwd: `/tmp` })'],
  ['cp.spawn("x", [], { argv0: `x` })'],
] as const)("keeps the spawn for an accepted cwd or argv0: %s", (call) => {
  expect(spawnsFor(call)).toHaveLength(1);
});

// Constructor names cannot establish the returned cwd value or its validity.
it.each([
  [`cp.spawn("x", [], { cwd: new Uint8Array([47, 116, 109, 112]) })`],
  [`cp.spawn("x", [], { cwd: new Buffer("/tmp") })`],
  [`cp.spawn("x", [], { cwd: new URL("file:///C:/tmp/") })`],
  [`cp.spawn("x", [], { cwd: new globalThis.URL("file:///tmp/") })`],
  [
    `class DirectoryURL { constructor() { return new URL("file:///tmp/"); } }; cp.spawn("x", [], { cwd: new DirectoryURL() })`,
  ],
  [`cp.spawn("x", [], { cwd: new Foo("/tmp") })`],
] as const)("keeps unresolved cwd constructor candidates: %s", (call) => {
  expect(spawnsFor(call)).toHaveLength(1);
});

it.each([
  [`cp.spawn("x", [], { argv0: new Uint8Array([120]) })`],
  [`cp.spawn("x", [], { argv0: new URL("file:///C:/t/") })`],
] as const)("emits no spawn for a constructor Node refuses: %s", (call) => {
  expect(spawnsFor(call)).toEqual([]);
});
