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
 *
 * Unary spellings evaluate before validation (Node 24.22.1):
 *
 *   net.connect(-0) / -0e0 / -1e-324  -> Socket created (negative zero is port 0)
 *   net.connect(+65535) / +true / -null -> Socket created
 *   net.connect(~4294967295.5)        -> Socket created (ToInt32 wraps to 0)
 *   net.connect(typeof 1.5)           -> Socket created ("number" is a path)
 *   net.connect(+65536) / +1.5 / ~0   -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect(-true)                -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect(!0) / !1.5 / -0n      -> THREW ERR_INVALID_ARG_TYPE
 *   net.connect(void 0)               -> THREW ERR_MISSING_ARGS (undecided here)
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
  ["a unary plus port above the range", `net.connect(+65536)`],
  ["a unary plus fractional port", `net.connect(+1.5)`],
  ["a bitwise-not port", `net.connect(~0)`],
  ["a logical-not port", `net.connect(!0)`],
  ["a logical-not fractional port", `net.connect(!1.5)`],
  ["a negated boolean port", `net.connect(-true)`],
  ["a negated BigInt port", `net.connect(-0n)`],
  ["a doubly negated port above the range", `net.connect(- -65536)`],
  ["a parenthesized negated port", `net.connect(-(1))`],
  ["a tls unary plus port above the range", `tls.connect(+65536)`],
  ["a createConnection bitwise-not port", `net.createConnection(~0)`],
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
  ["a negative zero port", `net.connect(-0)`, "connect"],
  ["an exponent negative zero port", `net.connect(-0e0)`, "connect"],
  ["an underflowing negative port", `net.connect(-1e-324)`, "connect"],
  ["a unary plus port", `net.connect(+65535)`, "connect"],
  ["a unary plus boolean port", `net.connect(+true)`, "connect"],
  ["a negated null port", `net.connect(-null)`, "connect"],
  ["a doubly negated port", `net.connect(- -1)`, "connect"],
  [
    "a bitwise-not port wrapping to zero",
    `net.connect(~4294967295.5)`,
    "connect",
  ],
  ["a typeof path", `net.connect(typeof 1.5)`, "connect"],
  ["a void port", `net.connect(void 0)`, "connect"],
  ["a tls negative zero port", `tls.connect(-0)`, "connect"],
  [
    "a createConnection negative zero port",
    `net.createConnection(-0)`,
    "createConnection",
  ],
] as const)("keeps the socket acquisition for %s", (_name, call, method) => {
  expect(socketAcquisitionsFor(call)).toEqual([{ kind: "acquire", method }]);
});

it("keeps the release of a socket acquired with a negative zero port", () => {
  expect(
    analyzeJavaScriptSemantics(
      `import net from "node:net";\nfunction g() { const socket = net.connect(-0, "127.0.0.1"); socket.destroy(); }`,
    ).resourceOperations.map(({ kind, method }) => ({ kind, method })),
  ).toEqual([
    { kind: "acquire", method: "connect" },
    { kind: "release", method: "destroy" },
  ]);
});

it("emits neither acquisition nor release for a port that throws", () => {
  expect(
    analyzeJavaScriptSemantics(
      `import net from "node:net";\nfunction g() { const socket = net.connect(!0, "127.0.0.1"); socket.destroy(); }`,
    ).resourceOperations,
  ).toEqual([]);
});

it("records the expression-depth budget when a unary port spelling exceeds it", () => {
  const nested = (count: number) =>
    analyzeJavaScriptSemantics(
      `import net from "node:net";\nfunction g() { net.connect(${"~".repeat(count)}65536); }`,
    );
  const exact = nested(200);
  expect(exact.resourceOperations).toEqual([]);
  expect(exact.coverage).toEqual({ status: "complete", omittedCount: 0 });
  const bounded = nested(300);
  expect(
    bounded.resourceOperations.map(({ kind, method }) => ({ kind, method })),
  ).toEqual([{ kind: "acquire", method: "connect" }]);
  expect(bounded.coverage).toMatchObject({
    status: "partial",
    resourceLimits: ["expression-depth"],
  });
});
