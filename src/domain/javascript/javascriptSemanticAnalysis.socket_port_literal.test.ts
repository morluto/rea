import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * `net` and `tls` validate a numeric port before creating a socket, so a literal
 * port outside `[0, 65535]`, a fractional or non-finite number, or a BigInt,
 * boolean or `null` first argument throws synchronously and no socket exists.
 *
 * Measured on Node 24.22.1:
 *
 *   net.connect(0) / 80 / 65535       -> Socket created
 *   net.connect(65536) / -1 / 1.5     -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect(NaN) / Infinity       -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect(0n) / true / null     -> THREW ERR_INVALID_ARG_TYPE
 *   net.connect("")                   -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect("/tmp/x.sock")        -> Socket created (Unix socket path)
 *   net.connect({ port: 80 })         -> Socket created
 *   net.connect() / undefined / void 0 -> THREW ERR_MISSING_ARGS
 *   net.connect({}) / []              -> THREW ERR_MISSING_ARGS (undecided here)
 */
const socketOperationsFor = (call: string) =>
  analyzeJavaScriptSemantics(
    `import net from "node:net";\nimport tls from "node:tls";\nfunction g(p) { ${call}; }`,
  ).resourceOperations.map(({ kind, method }) => ({ kind, method }));

it.each([
  ["a port above the range", `net.connect(65536)`],
  ["a negative port", `net.connect(-1)`],
  ["a fractional port", `net.connect(1.5)`],
  ["a NaN port", `net.connect(NaN)`],
  ["an Infinity port", `net.connect(Infinity)`],
  ["an overflowing numeric port", `net.connect(1e400)`],
  ["a BigInt port", `net.connect(0n)`],
  ["a boolean port", `net.connect(true)`],
  ["a null port", `net.connect(null)`],
  ["an empty string port", `net.connect("")`],
  ["an omitted argument", `net.connect()`],
  ["an explicit undefined port", `net.connect(undefined)`],
  ["a void port", `net.connect(void 0)`],
  ["an omitted createConnection argument", `net.createConnection()`],
  ["a tls port above the range", `tls.connect(65536)`],
  ["a tls negative port", `tls.connect(-1)`],
  ["a tls NaN port", `tls.connect(NaN)`],
  ["a createConnection port above the range", `net.createConnection(65536)`],
  ["a createConnection empty string port", `net.createConnection("")`],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(socketOperationsFor(call)).toEqual([]);
});

it.each([
  [
    "a numeric string with a rejected TLS port override",
    `tls.connect("443", { port: -1 })`,
  ],
  [
    "a numeric string with an invalid TLS host",
    `tls.connect("443", { host: 1 })`,
  ],
  [
    "a numeric template with an invalid TLS host",
    "tls.connect(`443`, { host: 1 })",
  ],
  [
    "a numeric unary result with an invalid TLS host",
    `tls.connect(+443, { host: 1 })`,
  ],
  ["an out-of-range numeric net string", `net.connect("65536")`],
  ["a TLS port replaced by a method", `tls.connect(-1, { port() {} })`],
  ["a method-valued net port", `net.connect({ port() {} })`],
  ["a copied net port method", `net.createConnection({ ...{ port() {} } })`],
  ["a method-valued TLS socket", `tls.connect(443, { socket() {} })`],
  ["a method-valued TLS context", `tls.connect(443, { secureContext() {} })`],
  ["a numeric TLS path", `tls.connect(-1, { path: 1 })`],
  ["a true TLS socket", `tls.connect(-1, { socket: true })`],
  ["a numeric TLS socket", `tls.connect(443, { socket: +1 })`],
  ["a string TLS socket", `tls.connect({ port: 443, socket: "stream" })`],
  ["a BigInt TLS socket", `tls.connect(443, { socket: 1n })`],
  ["an Infinity TLS socket", `tls.connect(443, { socket: Infinity })`],
  [
    "a literal without the TLS stream method",
    `tls.connect(443, { socket: {} })`,
  ],
  [
    "a literal with a non-callable pause method",
    `tls.connect(443, { socket: { pause: false } })`,
  ],
  ["a false TLS socket and bad TCP port", `tls.connect(-1, { socket: false })`],
  ["a NaN TLS socket and bad TCP port", `tls.connect(-1, { socket: NaN })`],
  ["an object net path", `net.connect({ port: 443, path: {} })`],
  ["a boxed string TLS path", `tls.connect(443, { path: new String("x") })`],
  ["a method supplied as a net path", `net.connect({ port: 443, path() {} })`],
  ["a true createConnection path", `net.createConnection({ path: true })`],
  ["a unary numeric TLS path", `tls.connect(443, { path: +1 })`],
  ["a zero TLS path and bad TCP port", `tls.connect(-1, { path: 0 })`],
  [
    "a false net path and bad TCP port",
    `net.connect({ port: -1, path: false })`,
  ],
  ["a NaN TLS path and bad TCP port", `tls.connect(-1, { path: NaN })`],
  ["an empty template path and bad TCP port", "tls.connect(-1, { path: `` })"],
  [
    "a bad TLS path without a supplied socket",
    `tls.connect(443, { path: 1, socket: null })`,
  ],
  ["a bad net positional port before a spread", `net.connect(-1, ...[])`],
  [
    "a bad createConnection port before a spread",
    `net.createConnection(65536, ...[])`,
  ],
  [
    "a bad net options port before a spread",
    `net.connect({ port: -1 }, ...[{ port: 443 }])`,
  ],
  [
    "a bad TLS options port before a spread in an unused slot",
    `tls.connect(443, { port: -1 }, ...p)`,
  ],
  [
    "a bad TLS options port before a spread after the third argument",
    `tls.connect(443, undefined, { port: -1 }, ...p)`,
  ],
] as const)(
  "omits the acquisition and linked release for %s",
  (_name, call) => {
    expect(
      socketOperationsFor(`const handle = ${call}; handle.destroy()`),
    ).toEqual([]);
  },
);

it.each([
  [
    "a later override of a bad positional TLS port",
    `tls.connect(-1, { port: 443 })`,
  ],
  [
    "a negative numeric string that selects a path",
    `tls.connect("-1", { host: 1, port: -1 })`,
  ],
  ["an unreadable positional overload", `tls.connect(p, { port: -1 })`],
  ["an unreadable template overload", "tls.connect(`${p}`, { port: -1 })"],
  ["an unreadable TLS path", `tls.connect(-1, { path: p })`],
  ["an unreadable TLS socket member", `tls.connect(-1, { socket: p })`],
  [
    "a TLS port method replaced by a number",
    `tls.connect({ port() {} }, { port: 443 })`,
  ],
  ["a TLS port accessor", `tls.connect(-1, { get port() { return p; } })`],
  [
    "a pipe overriding a TLS port method",
    `tls.connect("/tmp/x.sock", { port() {} })`,
  ],
  [
    "a TLS socket class with unknown static members",
    `tls.connect(-1, { socket: class extends p {} })`,
  ],
  [
    "an unreadable literal stream method",
    `tls.connect(-1, { socket: { pause: p } })`,
  ],
  [
    "a stream-like value with a custom prototype",
    `tls.connect(-1, { socket: { __proto__: p } })`,
  ],
  ["an instantiated stream-like value", `tls.connect(-1, { socket: new p() })`],
  ["a supplied net.Socket", `tls.connect(-1, { socket: new net.Socket() })`],
  [
    "a false TLS socket and valid TCP port",
    `tls.connect(443, { socket: false })`,
  ],
  [
    "a net option with an unused socket member",
    `net.connect({ port: 443, socket: true })`,
  ],
  [
    "an unreadable TLS socket with a bad path",
    `tls.connect(-1, { path: 1, socket: p })`,
  ],
  [
    "a valid TLS pipe path replacing a bad port",
    "tls.connect(-1, { path: `/tmp/x.sock` })",
  ],
  ["a falsy TLS path and valid TCP port", `tls.connect(443, { path: false })`],
  ["a spread in the first net slot", `net.connect(...p, -1)`],
  ["a spread in the second TLS slot", `tls.connect(-1, ...p)`],
  ["a spread in the third TLS slot", `tls.connect(-1, undefined, ...p)`],
] as const)(
  "retains the acquisition and linked release for %s",
  (_name, call) => {
    expect(
      socketOperationsFor(`const handle = ${call}; handle.destroy()`),
    ).toEqual([
      { kind: "acquire", method: "connect" },
      { kind: "release", method: "destroy" },
    ]);
  },
);

it.each([
  ["Object", `{}`],
  ["String", `"stream"`],
] as const)(
  "preserves uncertainty when %s.prototype may supply pause",
  (owner, value) => {
    expect(
      socketOperationsFor(`
    ${owner}.prototype.pause = p;
    const handle = tls.connect(-1, { socket: ${value} });
    handle.destroy();
  `),
    ).toEqual([
      { kind: "acquire", method: "connect" },
      { kind: "release", method: "destroy" },
    ]);
  },
);

it.each([
  ["a zero port", `net.connect(0)`, "connect"],
  ["a low port", `net.connect(80)`, "connect"],
  ["the highest port", `net.connect(65535)`, "connect"],
  ["a Unix socket path", `net.connect("/tmp/x.sock")`, "connect"],
  ["an options object", `net.connect({ port: 80 })`, "connect"],
  ["a computed argument", `net.connect(p)`, "connect"],
  [
    "a TLS port supplied by later options",
    `tls.connect(void 0, { port: 443 })`,
    "connect",
  ],
  ["a tls port", `tls.connect(80)`, "connect"],
  ["a createConnection port", `net.createConnection(80)`, "createConnection"],
] as const)("keeps the socket acquisition for %s", (_name, call, method) => {
  expect(socketOperationsFor(call)).toEqual([{ kind: "acquire", method }]);
});

it.each(["socket", "secureContext"] as const)(
  "preserves a method-valued %s with possible prototype members",
  (member) => {
    expect(
      socketOperationsFor(`
      Function.prototype.${member === "socket" ? "pause" : "context"} = p;
      const handle = tls.connect(443, { ${member}() {} });
      handle.destroy();
    `),
    ).toEqual([
      { kind: "acquire", method: "connect" },
      { kind: "release", method: "destroy" },
    ]);
  },
);

it.each([
  [
    "a Unix path before a bad net port",
    `net.connect({ path: "/tmp/x.sock", port: -1 })`,
  ],
  [
    "an inherited Unix path",
    `Object.prototype.path = "/tmp/x.sock"; net.connect({ port: -1 })`,
  ],
  ["a later TLS port override", `tls.connect({ port: -1 }, { port: 443 })`],
  [
    "a third TLS options argument",
    `tls.connect({ port: -1 }, undefined, { port: 443 })`,
  ],
  [
    "a later TLS Unix path",
    `tls.connect({ port: -1 }, { path: "/tmp/x.sock" })`,
  ],
  ["a positional TLS Unix path", `tls.connect("/tmp/x.sock", { port: -1 })`],
  [
    "a constructed TLS options object",
    `tls.connect({ port: -1 }, new Object({ port: 443 }))`,
  ],
  ["a valid numeric string port", `net.connect({ port: "8080" })`],
  ["an unreadable unary port", `net.connect({ port: +p })`],
  ["a constant boolean unary port", `net.connect({ port: +!0 })`],
  [
    "an undefined port with an explicit empty path",
    `net.connect({ path: "", port: undefined })`,
  ],
] as const)(
  "keeps the socket acquisition when options make the port irrelevant or valid: %s",
  (_name, call) => {
    expect(socketOperationsFor(call)).toHaveLength(1);
  },
);

it.each([
  ["a bad net options port", `net.connect({ port: -1 })`],
  ["a bad TLS options port", `tls.connect({ port: -1 })`],
  ["a bad overridden TLS port", `tls.connect({ port: 443 }, { port: -1 })`],
  [
    "a bad third TLS options port",
    `tls.connect({ port: -1 }, undefined, { port: -1 })`,
  ],
  ["a nonnumeric options port", `net.connect({ port: "x" })`],
  ["a null options port", `net.connect({ port: null })`],
  ["a bad port with a null path", `net.connect({ path: null, port: -1 })`],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(socketOperationsFor(call)).toEqual([]);
});

it("retains candidate socket resources without applying Node-specific admission", () => {
  const result = analyzeJavaScriptSemantics(`
    const { connect } = require("node:net");
    const handle = connect({ port: -1 });
    handle.destroy();
  `);
  expect(result.resourceOperations).toEqual([
    expect.objectContaining({
      kind: "acquire",
      method: "connect",
      builtinAuthority: "candidate",
    }),
    expect.objectContaining({
      kind: "release",
      method: "destroy",
      builtinAuthority: "candidate",
    }),
  ]);
});
