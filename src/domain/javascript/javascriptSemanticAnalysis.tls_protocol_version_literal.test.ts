import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * `tls.connect` resolves `minVersion`/`maxVersion` before it opens a socket, so a bad
 * literal throws from the call itself and no socket exists.
 *
 * Measured on Node 24.22.1, accepted: `"TLSv1"`, `"TLSv1.1"`, `"TLSv1.2"`, `"TLSv1.3"`,
 * `null`, `undefined`, and the member being absent. Threw
 * `ERR_TLS_INVALID_PROTOCOL_VERSION`: `"TLSv1.0"`, `"tlsv1"`, `"tlsv1.2"`, `"TLSv1.4"`,
 * `"nope"`, `""`, `5`, `true`, `{}`, `[]`; a BigInt throws `TypeError`.
 *
 * The set is exact and case-sensitive, so it is a closed list rather than a pattern.
 * `net` ignores these members entirely.
 */
const acquisitionsFor = (body: string) =>
  analyzeJavaScriptSemantics(
    `import tls from "node:tls";\nimport net from "node:net";\nfunction g() { ${body}; }`,
  )
    .resourceOperations.filter(({ kind }) => kind === "acquire")
    .map(({ kind, method }) => ({ kind, method }));

it.each([
  [
    "a rejected maximum beside an accepted minimum",
    `tls.connect({ port: 80, minVersion: "TLSv1.2", maxVersion: "nope" })`,
  ],
  [
    "a rejected minimum beside an accepted maximum",
    `tls.connect({ port: 80, minVersion: "nope", maxVersion: "TLSv1.3" })`,
  ],
  [
    "an options object in the port slot",
    `tls.connect(443, { minVersion: "nope" })`,
  ],
  [
    "an options object after port and host",
    `tls.connect(443, "127.0.0.1", { minVersion: "nope" })`,
  ],
  [
    "an options object after a Unix path",
    `tls.connect("/tmp/x.sock", { minVersion: "nope" })`,
  ],
  ["a negative version", `tls.connect({ port: 80, minVersion: -1 })`],
  ["a unary-plus version", `tls.connect({ port: 80, minVersion: +1 })`],
  ["a negative-zero version", `tls.connect({ port: 80, minVersion: -0 })`],
  ["a negative maximum", `tls.connect({ port: 80, maxVersion: -1 })`],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  // Both members are resolved before the socket opens, so an accepted minimum does not
  // make a rejected maximum irrelevant. `tls` also reads the options object from every
  // positional overload. Measured on Node 24.22.1.
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  [
    "both versions accepted",
    `tls.connect({ port: 80, minVersion: "TLSv1.2", maxVersion: "TLSv1.3" })`,
  ],
  ["a port-slot options object", `tls.connect(443, { minVersion: "TLSv1.2" })`],
  [
    "a path-slot options object",
    `tls.connect("/tmp/x.sock", { minVersion: "TLSv1.3" })`,
  ],
  [
    "a spread argument",
    `const o = { minVersion: "nope" }; tls.connect(443, ...[o])`,
  ],
] as const)("keeps the socket acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "connect" },
  ]);
});
it.each([
  ["an unknown version name", `tls.connect({ port: 80, minVersion: "nope" })`],
  ["the TLSv1.0 spelling", `tls.connect({ port: 80, minVersion: "TLSv1.0" })`],
  ["a lower-case name", `tls.connect({ port: 80, minVersion: "tlsv1.2" })`],
  ["an empty version", `tls.connect({ port: 80, minVersion: "" })`],
  ["a numeric version", `tls.connect({ port: 80, minVersion: 5 })`],
  ["a boolean version", `tls.connect({ port: 80, minVersion: true })`],
  ["an object version", `tls.connect({ port: 80, minVersion: {} })`],
  ["an array version", `tls.connect({ port: 80, minVersion: [] })`],
  ["a BigInt version", `tls.connect({ port: 80, minVersion: 1n })`],
  [
    "an unknown maximum version",
    `tls.connect({ port: 80, maxVersion: "TLSv1.4" })`,
  ],
  [
    "a bad version written last",
    `tls.connect({ port: 80, minVersion: "TLSv1.2", minVersion: "nope" })`,
  ],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  ["TLSv1", `tls.connect({ port: 80, minVersion: "TLSv1" })`],
  ["TLSv1.1", `tls.connect({ port: 80, minVersion: "TLSv1.1" })`],
  ["TLSv1.2", `tls.connect({ port: 80, minVersion: "TLSv1.2" })`],
  ["TLSv1.3 as a maximum", `tls.connect({ port: 80, maxVersion: "TLSv1.3" })`],
  ["a null version", `tls.connect({ port: 80, minVersion: null })`],
  ["an undefined version", `tls.connect({ port: 80, minVersion: undefined })`],
  ["no version member", `tls.connect({ port: 80 })`],
  [
    "a good version written last",
    `tls.connect({ port: 80, minVersion: "nope", minVersion: "TLSv1.2" })`,
  ],
  [
    "a version supplied by a spread",
    `const o = { minVersion: "nope" }; tls.connect({ port: 80, ...o })`,
  ],
  [
    "a version supplied by a computed key",
    `tls.connect({ port: 80, ["minVersion"]: "nope" })`,
  ],
  ["net ignoring the member", `net.connect({ port: 80, minVersion: "nope" })`],
] as const)("keeps the socket acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "connect" },
  ]);
});
