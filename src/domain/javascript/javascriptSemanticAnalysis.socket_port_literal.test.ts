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
 *   net.connect(undefined) / {} / []  -> THREW ERR_MISSING_ARGS (undecided here)
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
  ["a boolean port", `net.connect(true)`],
  ["a null port", `net.connect(null)`],
  ["an empty path", `net.connect("")`],
  ["a tls port above the range", `tls.connect(65536)`],
  ["a tls negative port", `tls.connect(-1)`],
  ["a tls NaN port", `tls.connect(NaN)`],
  ["a createConnection port above the range", `net.createConnection(65536)`],
  ["a createConnection empty path", `net.createConnection("")`],
  // A unary operator is judged by its result. grpt: each of these reaches a
  // different branch, so a direct case is required for every one.
  ["a bitwise-not of zero", `net.connect(~0)`],
  ["a bitwise-not of one", `net.connect(~1)`],
  ["a logical-not port", `net.connect(!0)`],
  ["a void port", `net.connect(void 1.5)`],
  ["a unary-plus fractional port", `net.connect(+1.5)`],
  // `net.connect` keeps validating the first argument even when an options
  // object follows, which is what separates it from `tls.connect`.
  ["a net negative port beside options", `net.connect(-1, { port: 443 })`],
  [
    "a net port above the range beside options",
    `net.connect(65536, { port: 443 })`,
  ],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(socketAcquisitionsFor(call)).toEqual([]);
});

it.each([
  ["a zero port", `net.connect(0)`, "connect"],
  ["a low port", `net.connect(80)`, "connect"],
  ["the highest port", `net.connect(65535)`, "connect"],
  ["a Unix socket path", `net.connect("/tmp/x.sock")`, "connect"],
  ["an options object", `net.connect({ port: 80 })`, "connect"],
  ["an omitted argument", `net.connect()`, "connect"],
  ["an explicit undefined port", `net.connect(undefined)`, "connect"],
  ["a tls port", `tls.connect(80)`, "connect"],
  ["a createConnection port", `net.createConnection(80)`, "createConnection"],
  // A unary operator is judged by its result: `-0` is the number zero, which is
  // the valid lowest port, and `~-1` is also zero.
  ["a negative-zero port", `net.connect(-0)`, "connect"],
  ["a negative-zero expression port", `net.connect(-0.0)`, "connect"],
  ["a unary-plus zero port", `net.connect(+0)`, "connect"],
  ["a bitwise-not of negative one", `net.connect(~-1)`, "connect"],
  ["a tls negative-zero port", `tls.connect(-0)`, "connect"],
  [
    "a createConnection negative-zero port",
    `net.createConnection(-0)`,
    "createConnection",
  ],
  // `~4294967295` is `0`, which is the valid lowest port.
  ["a bitwise-not of the max uint32", `net.connect(~4294967295)`, "connect"],
  // `typeof` yields a non-empty type name, which Node reads as a Unix socket path.
  ["a typeof port", `net.connect(typeof 1.5)`, "connect"],
  // `tls.connect` merges a later options object over the first argument, so a
  // rejected-looking first argument is rescued. `net.connect` does not.
  ["a tls port beside options", `tls.connect(-1, { port: 443 })`, "connect"],
  [
    "a tls void port beside options",
    `tls.connect(void 0, { port: 443 })`,
    "connect",
  ],
  [
    "a tls boolean port beside options",
    `tls.connect(!0, { port: 443 })`,
    "connect",
  ],
] as const)("keeps the socket acquisition for %s", (_name, call, method) => {
  expect(socketAcquisitionsFor(call)).toEqual([{ kind: "acquire", method }]);
});

/**
 * `net.connect({ port })` validates the member the same way the positional form
 * validates the argument, so the same set of literal ports is decided. A
 * positional string stays a Unix socket path, but a `port` string is coerced
 * with `Number`, which is why `"0x50"` is a port while `"65536"` is not.
 */
it.each([
  ["a port above the range", `net.connect({ port: 65536 })`],
  ["a negative port", `net.connect({ port: -1 })`],
  ["a fractional port", `net.connect({ port: 1.5 })`],
  ["a NaN port", `net.connect({ port: NaN })`],
  ["an Infinity port", `net.connect({ port: Infinity })`],
  ["an overflowing numeric port", `net.connect({ port: 1e400 })`],
  ["a null port", `net.connect({ port: null })`],
  ["a boolean port", `net.connect({ port: true })`],
  ["a BigInt port", `net.connect({ port: 0n })`],
  ["an object port", `net.connect({ port: {} })`],
  ["an array port", `net.connect({ port: [] })`],
  ["an empty port string", `net.connect({ port: "" })`],
  ["a non-numeric port string", `net.connect({ port: "abc" })`],
  ["an out-of-range port string", `net.connect({ port: "65536" })`],
  ["a tls port above the range", `tls.connect({ port: 65536 })`],
] as const)(
  "emits no socket acquisition for an options object with %s",
  (_name, call) => {
    expect(socketAcquisitionsFor(call)).toEqual([]);
  },
);

it.each([
  ["an in-range port", `net.connect({ port: 80 })`, "connect"],
  ["the lowest port", `net.connect({ port: 0 })`, "connect"],
  ["the highest port", `net.connect({ port: 65535 })`, "connect"],
  ["a numeric port string", `net.connect({ port: "80" })`, "connect"],
  ["a hex port string", `net.connect({ port: "0x50" })`, "connect"],
  ["a padded port string", `net.connect({ port: " 80 " })`, "connect"],
  [
    "a Unix socket path member",
    `net.connect({ path: "/tmp/x.sock" })`,
    "connect",
  ],
  ["an object without a port", `net.connect({})`, "connect"],
  ["an undefined port", `net.connect({ port: undefined })`, "connect"],
  [
    "a port beside a host",
    `net.connect({ port: 80, host: "example.test" })`,
    "connect",
  ],
  ["a tls in-range port", `tls.connect({ port: 80 })`, "connect"],
] as const)(
  "keeps the socket acquisition for an options object with %s",
  (_name, call, method) => {
    expect(socketAcquisitionsFor(call)).toEqual([{ kind: "acquire", method }]);
  },
);

/**
 * Three review findings on the options-object form.
 *
 * `tls.connect` only lets a later options object replace the first argument when
 * it actually supplies a port or a Unix socket path:
 *
 *   tls.connect(-1, {})                            -> THREW ERR_SOCKET_BAD_PORT
 *   tls.connect(65536, { servername: "x" })        -> THREW ERR_SOCKET_BAD_PORT
 *   tls.connect(-1, { port: 443 })                 -> Socket created
 *   tls.connect(-1, { path: "/tmp/x.sock" })       -> Socket created
 *   tls.connect(-1, { port: -1 })                  -> THREW ERR_SOCKET_BAD_PORT
 *
 * A non-empty `path` member selects a Unix socket, so Node ignores `port`:
 *
 *   net.connect({ path: "/tmp/x.sock", port: -1 }) -> Socket created
 *   net.connect({ path: "", port: -1 })            -> THREW ERR_SOCKET_BAD_PORT
 *
 * JavaScript uses the last duplicate member:
 *
 *   net.connect({ port: -1, port: 443 })           -> Socket created
 *   net.connect({ port: 443, port: -1 })           -> THREW ERR_SOCKET_BAD_PORT
 */
it.each([
  ["an empty tls options object", `tls.connect(-1, {})`],
  ["tls options without a port", `tls.connect(65536, { servername: "x" })`],
  ["tls options with a rejected port", `tls.connect(-1, { port: -1 })`],
  ["tls options with an empty path", `tls.connect(-1, { path: "" })`],
  ["a void tls port with empty options", `tls.connect(void 0, {})`],
  [
    "a Unix socket path beside a bad port",
    `net.connect({ path: "", port: -1 })`,
  ],
  [
    "an options object whose last port is rejected",
    `net.connect({ port: 443, port: -1 })`,
  ],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(socketAcquisitionsFor(call)).toEqual([]);
});

it.each([
  [
    "tls options with their own port",
    `tls.connect(-1, { port: 443 })`,
    "connect",
  ],
  [
    "tls options with their own path",
    `tls.connect(-1, { path: "/tmp/x.sock" })`,
    "connect",
  ],
  [
    "tls options that win over the bad port",
    `tls.connect(65536, { port: 443 })`,
    "connect",
  ],
  [
    "a Unix socket path beside a bad port",
    `net.connect({ path: "/tmp/x.sock", port: -1 })`,
    "connect",
  ],
  [
    "a Unix socket path beside an out-of-range port",
    `net.connect({ path: "/tmp/x.sock", port: 65536 })`,
    "connect",
  ],
  [
    "a dynamic Unix socket path",
    `net.connect({ path: dynamic, port: -1 })`,
    "connect",
  ],
  [
    "an options object whose last port is usable",
    `net.connect({ port: -1, port: 443 })`,
    "connect",
  ],
] as const)("keeps the socket acquisition for %s", (_name, call, method) => {
  expect(socketAcquisitionsFor(call)).toEqual([{ kind: "acquire", method }]);
});

/**
 * A readable `path` member decides before `port` is validated, and only a
 * non-empty string selects a Unix socket:
 *
 *   net.connect({ path: false, port: -1 })  -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect({ path: null, port: -1 })   -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect({ path: 0, port: -1 })      -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect({ path: 1, port: 443 })     -> THREW ERR_INVALID_ARG_TYPE
 *   net.connect({ path: {}, port: 443 })    -> THREW ERR_INVALID_ARG_TYPE
 *   net.connect({ path: false, port: 443 }) -> Socket created
 */
it.each([
  [
    "a falsy boolean path beside a bad port",
    `net.connect({ path: false, port: -1 })`,
  ],
  ["a null path beside a bad port", `net.connect({ path: null, port: -1 })`],
  ["a zero path beside a bad port", `net.connect({ path: 0, port: -1 })`],
  ["a non-string path", `net.connect({ path: 1, port: 443 })`],
  ["a boolean true path", `net.connect({ path: true, port: 443 })`],
  ["an object path", `net.connect({ path: {}, port: 443 })`],
  ["an array path", `net.connect({ path: [], port: 443 })`],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(socketAcquisitionsFor(call)).toEqual([]);
});

it.each([
  [
    "a falsy boolean path beside a usable port",
    `net.connect({ path: false, port: 443 })`,
    "connect",
  ],
  [
    "a null path beside a usable port",
    `net.connect({ path: null, port: 443 })`,
    "connect",
  ],
  [
    "a zero path beside a usable port",
    `net.connect({ path: 0, port: 443 })`,
    "connect",
  ],
] as const)("keeps the socket acquisition for %s", (_name, call, method) => {
  expect(socketAcquisitionsFor(call)).toEqual([{ kind: "acquire", method }]);
});

/**
 * Two further review findings.
 *
 * Node trims a `port` string before coercing it, so a whitespace-only port is
 * rejected while a padded one is accepted:
 *
 *   net.connect({ port: " " })   -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect({ port: "0x20" }) -> Socket created   (hex 32)
 *   net.connect({ port: " 80 " }) -> Socket created
 *
 * `tls.connect` wraps an existing socket and never connects, so it also never
 * validates `port`, while `net.connect` still does:
 *
 *   tls.connect({ socket, port: -1 })  -> TLSSocket
 *   net.connect({ socket, port: -1 })  -> THREW ERR_SOCKET_BAD_PORT
 */
it.each([
  ["a space port", `net.connect({ port: " " })`],
  ["a two-space port", `net.connect({ port: "  " })`],
  ["a tab port", `net.connect({ port: "\\t" })`],
  ["a newline port", `net.connect({ port: "\\n" })`],
  [
    "a negative port in a net socket options object",
    `net.connect({ socket, port: -1 })`,
  ],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(socketAcquisitionsFor(call)).toEqual([]);
});

it.each([
  ["a hex port string", `net.connect({ port: "0x20" })`, "connect"],
  ["a padded port string", `net.connect({ port: " 80 " })`, "connect"],
  ["a whitespace Unix socket path", `net.connect(" ")`, "connect"],
  [
    "a tls socket wrap with a rejected port",
    `tls.connect({ socket, port: -1 })`,
    "connect",
  ],
  [
    "a tls socket wrap above the range",
    `tls.connect({ socket, port: 65536 })`,
    "connect",
  ],
  ["a tls socket wrap alone", `tls.connect({ socket })`, "connect"],
] as const)("keeps the socket acquisition for %s", (_name, call, method) => {
  expect(socketAcquisitionsFor(call)).toEqual([{ kind: "acquire", method }]);
});
