import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * `net`/`tls` read `options.host` and throw `ERR_INVALID_ARG_TYPE` from the call itself
 * when the member is truthy and not a string, so no socket exists afterwards. Every
 * falsy value falls through to the default and is accepted.
 *
 * Measured on Node 24.22.1 — accepted: `undefined`, `null`, `""`, `0`, `-0`, `false`,
 * `0n`, `NaN`, `void 0`, `!1`, `"localhost"`, `String("127.0.0.1")`, `Number(0)`,
 * `Number("x")`, `Boolean(0)`, `Boolean("")`, and every value when a non-empty `path`
 * selects the Unix overload. Threw: `1`, `1.5`, `true`, `1n`, `{}`, `[]`, `/x/`,
 * `new String("x")`, `new Number(1)`, `!0`, `-1`, `+1`, `!!1`, `Infinity`, `Symbol("x")`,
 * `Number(1)`, `Boolean(1)`.
 *
 * The positional second argument is a different slot Node does not validate —
 * `net.connect(0, 5)` connects — so only the member is decided. Only shapes with a
 * static truthiness are decided; the other rejected shapes above (`/x/`, boxed
 * values, `!0`, `Infinity`, intrinsic calls) keep the acquisition.
 */
const acquisitionsFor = (body: string) =>
  analyzeJavaScriptSemantics(
    `import net from "node:net";\nimport tls from "node:tls";\nfunction g() { ${body}; }`,
  ).resourceOperations.map(({ kind, method }) => ({ kind, method }));

it("keeps the socket acquisition when a later argument mutates the prototype", () => {
  // JavaScript evaluates the second argument before invoking, so the assignment lands
  // before Node reads the options. Measured on Node 24.22.1, this returns a Unix socket.
  const operations = analyzeJavaScriptSemantics(`
    const net = require("node:net");
    function seed() {}
    net.connect({ port: 0, host: 1 }, (Object.prototype.path = "/tmp/a.sock"));
  `)
    .resourceOperations.filter(({ kind }) => kind === "acquire")
    .map(({ kind, method }) => ({ kind, method }));
  expect(operations).toEqual([{ kind: "acquire", method: "connect" }]);
});
it.each([
  ["a numeric host", `net.connect({ port: 0, host: 1 })`],
  ["a fractional host", `net.connect({ port: 0, host: 1.5 })`],
  ["a boolean host", `net.connect({ port: 0, host: true })`],
  ["a BigInt host", `net.connect({ port: 0, host: 1n })`],
  ["an object host", `net.connect({ port: 0, host: {} })`],
  ["an array host", `net.connect({ port: 0, host: [] })`],
  ["a function host", `net.connect({ port: 0, host: () => {} })`],
  ["a negated number host", `net.connect({ port: 0, host: -1 })`],
  ["a tls numeric host", `tls.connect({ port: 0, host: 5 })`],
  ["a tls object host", `tls.connect({ port: 0, host: {} })`],
  ["a falsy tls socket", `tls.connect({ port: 0, socket: null, host: 1 })`],
  [
    "an undefined tls path",
    `tls.connect({ port: 0, path: undefined, host: 1 })`,
  ],
  [
    "an undefined net path",
    `net.connect({ port: 0, path: undefined, host: 1 })`,
  ],
  ["an empty net path", `net.connect({ port: 0, path: "", host: 1 })`],
  [
    "a duplicate path set to undefined",
    `net.connect({ port: 0, path: "/tmp/x.sock", path: undefined, host: 1 })`,
  ],
  [
    "a spread replacing the path with undefined",
    `net.connect({ port: 0, path: "/tmp/x.sock", ...{ path: undefined }, host: 1 })`,
  ],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  ["an omitted host", `net.connect({ port: 0 })`],
  ["an undefined host", `net.connect({ port: 0, host: undefined })`],
  ["a null host", `net.connect({ port: 0, host: null })`],
  ["an empty-string host", `net.connect({ port: 0, host: "" })`],
  ["a zero host", `net.connect({ port: 0, host: 0 })`],
  ["a negative-zero host", `net.connect({ port: 0, host: -0 })`],
  ["a false host", `net.connect({ port: 0, host: false })`],
  ["a zero BigInt host", `net.connect({ port: 0, host: 0n })`],
  ["a hexadecimal zero BigInt host", `net.connect({ port: 0, host: 0x0n })`],
  ["an octal zero BigInt host", `net.connect({ port: 0, host: 0o0n })`],
  ["a binary zero BigInt host", `net.connect({ port: 0, host: 0b0n })`],
  ["a NaN host", `net.connect({ port: 0, host: NaN })`],
  ["a void host", `net.connect({ port: 0, host: void 0 })`],
  ["a negated host", `net.connect({ port: 0, host: !1 })`],
  ["a loopback host", `net.connect({ port: 0, host: "localhost" })`],
  ["a template host", "net.connect({ port: 0, host: `x` })"],
  ["a String call host", `net.connect({ port: 0, host: String("127.0.0.1") })`],
  [
    "an unresolved call host",
    `const g = () => "localhost"; net.connect({ port: 0, host: g() })`,
  ],
  [
    "a later spread host",
    `net.connect({ port: 0, host: 1, ...{ host: "127.0.0.1" } })`,
  ],
  [
    "a later computed host",
    `net.connect({ port: 0, host: 1, ["host"]: "127.0.0.1" })`,
  ],
  [
    "a later duplicate host",
    `net.connect({ port: 0, host: 1, host: "localhost" })`,
  ],
  [
    "a getter in a spread writing the host",
    `net.connect({ port: 0, ...{ get x() { this.host = "localhost"; return 0; }, host: 1 } })`,
  ],
  [
    "an inherited __proto__ path",
    `net.connect({ __proto__: { path: "/tmp/a.sock" }, host: 1 })`,
  ],
  [
    "an inherited Object.prototype.path",
    `Object.prototype.path = "/tmp/a.sock"; function f() {} net.connect({ port: 0, host: 1 })`,
  ],
  [
    "an inherited Object.prototype.host",
    `Object.prototype.host = 1; function f() {} net.connect({ port: 0 })`,
  ],
  [
    "a Unix path overriding a bad host",
    `net.connect({ path: "/tmp/x.sock", host: 1 })`,
  ],
  ["a Number call returning 0", `net.connect({ port: 0, host: Number(0) })`],
  [
    "a Number call returning NaN",
    `net.connect({ port: 0, host: Number("x") })`,
  ],
  [
    "a Boolean call returning false",
    `net.connect({ port: 0, host: Boolean(0) })`,
  ],
  [
    "a Boolean call returning ''",
    `net.connect({ port: 0, host: Boolean("") })`,
  ],
  [
    "a non-literal path",
    `const p = "/tmp/a.sock"; net.connect({ port: 0, path: p, host: 1 })`,
  ],
  [
    "a shadowed undefined in a negation",
    `const undefined = "x"; net.connect({ port: 0, host: !undefined })`,
  ],
  [
    "a shadowed Infinity host",
    `const Infinity = "localhost"; net.connect({ port: 0, host: Infinity })`,
  ],
  ["a positional numeric host", `net.connect(0, 5)`],
  ["a tls stream socket", `tls.connect({ socket: base, host: 1 })`],
  ["a tls string host", `tls.connect({ port: 0, host: "localhost" })`],
] as const)("keeps the socket acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "connect" },
  ]);
});

it.each([
  // `tls` merges a later non-null object over this one, and that object can write `host`.
  // Measured on Node 24.22.1.
  [`tls.connect({ port: 0, host: 1 }, { host: "localhost" })`],
  // Global code the analysis cannot see may have patched the intrinsic the value folds through.
  [
    `globalThis.eval("Number = String"); net.connect({ port: 0, host: Number(1) })`,
  ],
] as const)("keeps the acquisition for a merged or opaque host: %s", (call) => {
  expect(acquisitionsFor(call)).toHaveLength(1);
});

it.each([
  [`tls.connect({ port: 0, host: "localhost" }, { host: 1 })`],
  [`tls.connect({ port: 0, host: 1 }, {})`],
] as const)("emits no acquisition for a decided numeric host: %s", (call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});
