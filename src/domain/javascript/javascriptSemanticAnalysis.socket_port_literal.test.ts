import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * `net` and `tls` validate a numeric port before creating a socket, so a literal
 * port outside `[0, 65535]`, a fractional or non-finite number, or a BigInt,
 * boolean or `null` first argument throws synchronously and no socket exists.
 * `tls.connect` is the exception: it merges the options object from argument 1
 * (an array counts), or from argument 2 when argument 1 is not an object, over
 * the port argument first, so a `port` in that one object still yields a socket.
 *
 * Measured on Node 24.22.1:
 *
 *   net.connect(0) / 80 / 65535       -> Socket created
 *   net.connect(65536) / -1 / 1.5     -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect(NaN) / Infinity       -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect(0n) / true / null     -> THREW ERR_INVALID_ARG_TYPE
 *   net.connect(-0n) / ~0n / -(1n)    -> THREW ERR_INVALID_ARG_TYPE
 *   net.connect(+0n)                  -> THREW TypeError (before the call)
 *   net.connect(-0n, { port: 443 })   -> THREW ERR_INVALID_ARG_TYPE (no merge)
 *   tls.connect(-0n) / ~0n            -> THREW ERR_INVALID_ARG_TYPE
 *   tls.connect(+0n, { port: 443 })   -> THREW TypeError (before the call)
 *   tls.connect(-0n, () => {}) / undefined / {} / "host" / "host", {} -> THREW
 *   tls.connect(-0n, { port: 443 })   -> Socket created (later options win)
 *   tls.connect(-0n, undefined, { port: 443 }) -> Socket created
 *   tls.connect(-0n, "host", { port: 443 }) / (-0n, () => {}, { port: 443 }) -> Socket created
 *   tls.connect(~0n, { port: 443 })   -> Socket created (later options win)
 *   tls.connect(0n / null / true / "" / 1.5 / NaN / 65536 / !0, { port: 443 }) -> Socket created
 *   tls.connect(-0n, {}, { port: 443 }) -> THREW (argument 1 is the merged object)
 *   tls.connect(-0n, undefined, undefined, { port: 443 }) -> THREW (argument 3 is ignored)
 *   tls.connect(-0n, []) / (-0n, [], { port: 443 }) -> THREW (an array is the merged object)
 *   net.connect(65536, { port: 443 }) -> THREW ERR_SOCKET_BAD_PORT (no merge)
 *   net.connect("")                   -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect("/tmp/x.sock")        -> Socket created (Unix socket path)
 *   net.connect({ port: 80 })         -> Socket created
 *   net.connect() / undefined / void 0 -> THREW ERR_MISSING_ARGS
 *   net.connect({}) / []              -> THREW ERR_MISSING_ARGS (undecided here)
 */
const socketAcquisitionsFor = (call: string) =>
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
  ["a negated BigInt port", `net.connect(-0n)`],
  ["a bitwise-not BigInt port", `net.connect(~0n)`],
  ["a parenthesized negated BigInt port", `net.connect(-(1n))`],
  ["a unary plus BigInt port", `tls.connect(+0n)`],
  [
    "a tls unary plus BigInt port with options",
    `tls.connect(+0n, { port: 443 })`,
  ],
  ["a tls negated BigInt port", `tls.connect(-0n)`],
  ["a tls negated BigInt port with a callback", `tls.connect(-0n, () => {})`],
  ["a tls negated BigInt port with undefined", `tls.connect(-0n, undefined)`],
  ["a tls negated BigInt port with empty options", `tls.connect(-0n, {})`],
  ["a tls negated BigInt port with a host", `tls.connect(-0n, "host", {})`],
  [
    "a tls negated BigInt port whose merged argument has no port",
    `tls.connect(-0n, {}, { port: 443 })`,
  ],
  [
    "a tls negated BigInt port with a port only in the fourth argument",
    `tls.connect(-0n, undefined, undefined, { port: 443 })`,
  ],
  ["a tls negated BigInt port with an array", `tls.connect(-0n, [])`],
  [
    "a tls negated BigInt port with an array and a later port",
    `tls.connect(-0n, [], { port: 443 })`,
  ],
  [
    "a tls port above the range with options that carry no port",
    `tls.connect(65536, { host: "h" })`,
  ],
  [
    "a net port above the range with options",
    `net.connect(65536, { port: 443 })`,
  ],
  ["a net negated BigInt port with options", `net.connect(-0n, { port: 443 })`],
  ["a boolean port", `net.connect(true)`],
  ["a null port", `net.connect(null)`],
  ["an empty path", `net.connect("")`],
  ["an omitted argument", `net.connect()`],
  ["an explicit undefined port", `net.connect(undefined)`],
  ["a void port", `net.connect(void 0)`],
  ["an omitted createConnection argument", `net.createConnection()`],
  ["a tls port above the range", `tls.connect(65536)`],
  ["a tls negative port", `tls.connect(-1)`],
  ["a tls NaN port", `tls.connect(NaN)`],
  ["a createConnection port above the range", `net.createConnection(65536)`],
  ["a createConnection empty path", `net.createConnection("")`],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(socketAcquisitionsFor(call)).toEqual([]);
});

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
  [
    "a tls negated BigInt port that later options replace",
    `tls.connect(-0n, { port: 443 })`,
    "connect",
  ],
  [
    "a tls bitwise-not BigInt port that later options replace",
    `tls.connect(~0n, { port: 443 })`,
    "connect",
  ],
  [
    "a tls negated BigInt port that a third argument replaces",
    `tls.connect(-0n, undefined, { port: 443 })`,
    "connect",
  ],
  [
    "a tls negated BigInt port with a computed later argument",
    `tls.connect(-0n, p)`,
    "connect",
  ],
  [
    "a tls BigInt port that later options replace",
    `tls.connect(0n, { port: 443 })`,
    "connect",
  ],
  [
    "a tls port above the range that later options replace",
    `tls.connect(65536, { port: 443 })`,
    "connect",
  ],
  [
    "a tls negative port that later options replace",
    `tls.connect(-1, { port: 443 })`,
    "connect",
  ],
  [
    "a tls fractional port that later options replace",
    `tls.connect(1.5, { port: 443 })`,
    "connect",
  ],
  [
    "a tls NaN port that later options replace",
    `tls.connect(NaN, { port: 443 })`,
    "connect",
  ],
  [
    "a tls null port that later options replace",
    `tls.connect(null, { port: 443 })`,
    "connect",
  ],
  [
    "a tls boolean port that later options replace",
    `tls.connect(true, { port: 443 })`,
    "connect",
  ],
  [
    "a tls negated boolean port that later options replace",
    `tls.connect(!0, { port: 443 })`,
    "connect",
  ],
  [
    "a tls empty path that later options replace",
    `tls.connect("", { port: 443 })`,
    "connect",
  ],
  [
    "a tls negated BigInt port with a host and a port in the third argument",
    `tls.connect(-0n, "host", { port: 443 })`,
    "connect",
  ],
  [
    "a tls negated BigInt port with a callback and a port in the third argument",
    `tls.connect(-0n, () => {}, { port: 443 })`,
    "connect",
  ],
  [
    "a tls bad port with a spread that may carry the options",
    `tls.connect(NaN, ...p)`,
    "connect",
  ],
  ["a tls port", `tls.connect(80)`, "connect"],
  ["a createConnection port", `net.createConnection(80)`, "createConnection"],
] as const)("keeps the socket acquisition for %s", (_name, call, method) => {
  expect(socketAcquisitionsFor(call)).toEqual([{ kind: "acquire", method }]);
});
