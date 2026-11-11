import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * `net.connect` and `tls.connect` judge the same port value whether it arrives positionally or
 * as a member of an options object, and both spellings now share one value reader.
 *
 * Measured on Node 24.22.1:
 *
 * | call | outcome |
 * | --- | --- |
 * | `net.connect({port: -1})`, `{port: 70000}`, `{port: "x"}`, `{port: null}` | THREW `ERR_SOCKET_BAD_PORT` |
 * | `net.connect({port: 8080})`, `{port: "8080"}`, `{port: 0}` | socket created |
 * | `tls.connect({port: -1})` | THREW `ERR_SOCKET_BAD_PORT` |
 * | `net.connect({path: "/tmp/x.sock", port: -1})` | socket created — the path becomes the Unix socket |
 */
const acquisitionsFor = (body: string) =>
  analyzeJavaScriptSemantics(
    `import net from "node:net";\nimport tls from "node:tls";\nfunction f() { ${body}; }`,
  ).resourceOperations.filter(({ kind }) => kind === "acquire");

it.each([
  [`net.connect({ port: -1 })`],
  [`net.connect({ port: 70000 })`],
  [`net.connect({ port: "x" })`],
  [`net.connect({ port: null })`],
  [`net.connect({ port: {} })`],
  [`net.connect({ port: [] })`],
  [`tls.connect({ port: -1 })`],
] as const)(
  "emits no acquisition for an options port Node rejects: %s",
  (call) => {
    expect(acquisitionsFor(call)).toEqual([]);
  },
);

it.each([
  [`net.connect({ port: 8080 })`],
  // A numeric string is coerced with `Number`, so it is a usable port.
  [`net.connect({ port: "8080" })`],
  [`net.connect({ port: 0 })`],
  [`tls.connect({ port: 443 })`],
  // Any present, not-provably-empty path selects the Unix socket.
  [`net.connect({ path: "/tmp/x.sock", port: -1 })`],
  [`const path = "/tmp/x.sock"; net.connect({ path, port: -1 })`],
  // The tls merge can replace the port from the later object, so the answer stays open.
  [`tls.connect({ port: -1 }, { port: 443 })`],
  // A getter can write the port before Node copies it.
  [`net.connect({ get side() { this.port = 80; }, port: -1 })`],
] as const)(
  "keeps the acquisition for an options shape it cannot decide: %s",
  (call) => {
    expect(acquisitionsFor(call)).toHaveLength(1);
  },
);

it.each([
  // The positional rules are unchanged: a string there is a path, not a port.
  [`net.connect(-1)`],
  [`net.connect({ port: -1 })`],
] as const)("keeps rejecting a positional port Node refuses: %s", (call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([[`net.connect(8080)`], [`net.connect("/tmp/x.sock")`]] as const)(
  "keeps a positional value Node accepts: %s",
  (call) => {
    expect(acquisitionsFor(call)).toHaveLength(1);
  },
);
