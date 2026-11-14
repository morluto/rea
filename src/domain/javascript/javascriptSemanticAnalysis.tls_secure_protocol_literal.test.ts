import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * `tls.connect` builds its secure context before it opens a socket, so a
 * `secureProtocol` Node refuses throws from the call itself and no socket exists.
 *
 * Measured on Node 24.22.1:
 *
 *   secureProtocol "TLS_method", "TLSv1_2_client_method", "SSLv23_method" -> socket
 *   secureProtocol "bogus" / "" / "SSLv3_method" / "TLSv1_3_method" /
 *   "tls_method" / "TLS_METHOD"            -> THREW ERR_TLS_INVALID_PROTOCOL_METHOD
 *   secureProtocol 5 / true / {} / null    -> socket (only a string is checked)
 *   { secureProtocol: "TLS_method", minVersion: "TLSv1.2" }
 *   { secureProtocol: 5, maxVersion: "TLSv1.3" }
 *                                          -> THREW ERR_TLS_PROTOCOL_VERSION_CONFLICT
 *   { secureProtocol: "TLS_method", minVersion: null }  -> socket
 *   { secureProtocol: 0, minVersion: "TLSv1.2" }        -> socket
 *   a truthy secureContext beside any of these           -> socket
 *
 * `net` ignores the member entirely.
 */
const acquisitionsFor = (body: string) =>
  analyzeJavaScriptSemantics(
    `import tls from "node:tls";\nimport net from "node:net";\nfunction g(p, ctx) { ${body}; }`,
  )
    .resourceOperations.filter(({ kind }) => kind === "acquire")
    .map(({ kind, method }) => ({ kind, method }));

it.each([
  [
    "an unknown method name",
    `tls.connect({ port: 80, secureProtocol: "bogus" })`,
  ],
  ["an empty method name", `tls.connect({ port: 80, secureProtocol: "" })`],
  [
    "the SSLv3 method",
    `tls.connect({ port: 80, secureProtocol: "SSLv3_method" })`,
  ],
  [
    "a TLS 1.3 method name",
    `tls.connect({ port: 80, secureProtocol: "TLSv1_3_method" })`,
  ],
  [
    "a lowercase method name",
    `tls.connect({ port: 80, secureProtocol: "tls_method" })`,
  ],
  [
    "a template method name",
    "tls.connect({ port: 80, secureProtocol: `bogus` })",
  ],
  [
    "an options object in the port slot",
    `tls.connect(443, { secureProtocol: "bogus" })`,
  ],
  [
    "an options object after port and host",
    `tls.connect(443, "127.0.0.1", { secureProtocol: "bogus" })`,
  ],
  [
    "a method name beside a minimum version",
    `tls.connect({ port: 80, secureProtocol: "TLS_method", minVersion: "TLSv1.2" })`,
  ],
  [
    "a method name beside a maximum version",
    `tls.connect({ port: 80, secureProtocol: "TLSv1_2_method", maxVersion: "TLSv1.3" })`,
  ],
  [
    "a template method name beside a version",
    'tls.connect({ port: 80, secureProtocol: `TLS_method`, minVersion: "TLSv1.2" })',
  ],
  [
    "a truthy non-string method beside a version",
    `tls.connect({ port: 80, secureProtocol: 5, minVersion: "TLSv1.2" })`,
  ],
  [
    "a null secure context beside an unknown method",
    `tls.connect({ port: 80, secureContext: null, secureProtocol: "bogus" })`,
  ],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  [
    "the generic method",
    `tls.connect({ port: 80, secureProtocol: "TLS_method" })`,
  ],
  [
    "a client method",
    `tls.connect({ port: 80, secureProtocol: "TLSv1_2_client_method" })`,
  ],
  [
    "the SSLv23 method",
    `tls.connect({ port: 80, secureProtocol: "SSLv23_method" })`,
  ],
  ["a numeric method", `tls.connect({ port: 80, secureProtocol: 5 })`],
  ["an object method", `tls.connect({ port: 80, secureProtocol: {} })`],
  ["a null method", `tls.connect({ port: 80, secureProtocol: null })`],
  ["a computed method", `tls.connect({ port: 80, secureProtocol: p })`],
  [
    "a method name beside a null version",
    `tls.connect({ port: 80, secureProtocol: "TLS_method", minVersion: null })`,
  ],
  [
    "a method name beside an undefined version",
    `tls.connect({ port: 80, secureProtocol: "TLS_method", maxVersion: undefined })`,
  ],
  [
    "a method name beside a computed version",
    `tls.connect({ port: 80, secureProtocol: "TLS_method", minVersion: p })`,
  ],
  [
    "a falsy method beside a version",
    `tls.connect({ port: 80, secureProtocol: 0, minVersion: "TLSv1.2" })`,
  ],
  [
    "a supplied secure context beside an unknown method",
    `tls.connect({ port: 80, secureContext: ctx, secureProtocol: "bogus" })`,
  ],
  [
    "a later accepted method over an unknown one",
    `tls.connect({ port: 443, secureProtocol: "bogus" }, { secureProtocol: "TLS_method" })`,
  ],
] as const)("keeps the socket acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "connect" },
  ]);
});

it("keeps a net socket whatever its secureProtocol", () => {
  expect(
    acquisitionsFor(`net.connect({ port: 80, secureProtocol: "bogus" })`),
  ).toEqual([{ kind: "acquire", method: "connect" }]);
});
