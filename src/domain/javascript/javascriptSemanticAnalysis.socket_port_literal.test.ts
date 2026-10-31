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
