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

it.each([
  // `Object.assign` reads the source, so only its getters run; a source setter is never called.
  [`tls.connect({ port: 443 }, { set side(_) {}, port: -1 })`],
] as const)(
  "emits no acquisition when a source setter cannot absorb the port: %s",
  (call) => {
    expect(acquisitionsFor(call)).toEqual([]);
  },
);

it.each([
  // A source getter runs during the copy and can rewrite the port.
  [
    `tls.connect({ port: 443 }, { get side() { this.port = 8080; }, port: -1 })`,
  ],
  // An own `__proto__` installs a prototype on the target whose setters then fire.
  [
    `tls.connect({ port: 443 }, { ["__proto__"]: { set port(_) { this.path = "/tmp/x"; } }, port: -1 })`,
  ],
  // An unresolved source may be an options object: `const o = {port: 443}` connects.
  [`const o = { port: 443 }; tls.connect({ port: -1 }, o)`],
] as const)(
  "keeps the acquisition for a source that may rewrite the port: %s",
  (call) => {
    expect(acquisitionsFor(call)).toHaveLength(1);
  },
);

it.each([
  // Only `tls` merges a later object; `net` reads slot 1 as an optional listener.
  [`net.connect({ port: -1 }, {})`],
  [`net.connect({ port: -1 }, () => {})`],
  // A setter in the options never runs during an `Object.assign` over a plain source.
  [`net.connect({ set port(_) {}, port: -1 })`],
  // The later object writes its own port, which is then the effective one.
  [`tls.connect({ port: 443 }, { port: -1 })`],
] as const)(
  "emits no acquisition when the effective port is rejected: %s",
  (call) => {
    expect(acquisitionsFor(call)).toEqual([]);
  },
);

it("keeps the acquisition when the later object supplies a good port", () => {
  expect(
    acquisitionsFor(`tls.connect({ port: -1 }, { port: 443 })`),
  ).toHaveLength(1);
});

it.each([
  // A spread produces the same own `__proto__` key as the direct spelling, so the installed
  // prototype's setter fires for the remaining keys. Measured on Node 24.22.1.
  [
    `tls.connect({}, { ...{ ["__proto__"]: { set port(_) { this.path = "/tmp/x"; } } }, port: -1 })`,
  ],
  [
    `tls.connect({}, { ["__proto__"]: { set port(_) { this.path = "/tmp/x"; } }, port: -1 })`,
  ],
] as const)(
  "keeps the acquisition for a prototype installed by the source: %s",
  (call) => {
    expect(acquisitionsFor(call)).toHaveLength(1);
  },
);

it("emits no acquisition when the spread carries no prototype", () => {
  expect(acquisitionsFor(`tls.connect({}, { ...{}, port: -1 })`)).toEqual([]);
});

it.each([
  // An inherited getter runs when Node reads a member through the prototype, and it can write
  // the port. Measured on Node 24.22.1.
  [
    `net.connect({ __proto__: { get timeout() { this.port = 80; return 0; } }, path: null, port: -1 })`,
  ],
  // Only the computed spelling is an own key a spread copies.
  [
    `tls.connect({}, { ...{ ["__proto__"]: { set port(_) { this.path = "/tmp/x"; } } }, port: -1 })`,
  ],
  [`tls.connect({ port: 443 }, 0)`],
] as const)(
  "keeps the acquisition for an inherited or copied write: %s",
  (call) => {
    expect(acquisitionsFor(call)).toHaveLength(1);
  },
);

it.each([
  // `__proto__:` inside a spread source sets that source's prototype and copies no key.
  [
    `tls.connect({}, { ...{ __proto__: { set port(_) { this.path = "/tmp/x"; } } }, port: -1 })`,
  ],
  // `tls` merges only a non-null object; a known primitive leaves the first object deciding.
  [`tls.connect({ port: -1 }, 0)`],
  // A nullish member leaves Node without a port, which it reports instead of ignoring.
  [`tls.connect({ port: undefined })`],
  [`net.connect({ port: null })`],
] as const)("emits no acquisition when Node has no usable port: %s", (call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  // A unary operator over a BigInt or over `undefined` is still not a port. Measured on Node
  // 24.22.1.
  [`net.connect({ port: -1n })`],
  [`net.connect({ port: ~1n })`],
  [`net.connect({ port: +undefined })`],
] as const)(
  "emits no acquisition for a unary port operand Node refuses: %s",
  (call) => {
    expect(acquisitionsFor(call)).toEqual([]);
  },
);

it.each([
  // `-0` is port zero and connects; the sign alone does not decide.
  [`net.connect({ port: -0 })`],
  [`net.connect({ port: 8080 })`],
] as const)(
  "keeps the acquisition for a unary port Node accepts: %s",
  (call) => {
    expect(acquisitionsFor(call)).toHaveLength(1);
  },
);

it("keeps the acquisition for a shorthand prototype key a spread copies", () => {
  // A shorthand `{__proto__}` is an own key, so the prototype it carries installs on the target.
  expect(
    acquisitionsFor(
      `const __proto__ = { set port(_) { this.path = "/tmp/x"; } }; tls.connect({}, { ...{ __proto__ }, port: -1 })`,
    ),
  ).toHaveLength(1);
});

it("emits no acquisition when the empty override leaves a bad port", () => {
  expect(acquisitionsFor(`tls.connect({ port: -1 }, {})`)).toEqual([]);
});

it("emits no acquisition for a colon-form prototype key copied by a spread", () => {
  // `{__proto__: value}` sets that source's prototype and copies no own key.
  expect(
    acquisitionsFor(
      `tls.connect({}, { ...{ __proto__: { set port(_) { this.path = "/tmp/x"; } } }, port: -1 })`,
    ),
  ).toEqual([]);
});

it.each([
  // A getter or an own `__proto__` only rescues the port when it is copied first. Measured on
  // Node 24.22.1.
  [`tls.connect({}, { port: -1, get side() { this.port = 80; } })`],
  [
    `tls.connect({}, { port: -1, ["__proto__"]: { set port(_) { this.path = "/tmp/x"; } } })`,
  ],
  [
    `tls.connect({}, { port: -1, ...{ ["__proto__"]: { set port(_) { this.path = "/tmp/x"; } } } })`,
  ],
] as const)(
  "emits no acquisition when the bad port is copied first: %s",
  (call) => {
    expect(acquisitionsFor(call)).toEqual([]);
  },
);

it.each([
  [`tls.connect({}, { get side() { this.port = 80; }, port: -1 })`],
  [
    `tls.connect({}, { ["__proto__"]: { set port(_) { this.path = "/tmp/x"; } }, port: -1 })`,
  ],
  [
    `tls.connect({}, { ...{ ["__proto__"]: { set port(_) { this.path = "/tmp/x"; } } }, port: -1 })`,
  ],
] as const)(
  "keeps the acquisition when a writer precedes the port: %s",
  (call) => {
    expect(acquisitionsFor(call)).toHaveLength(1);
  },
);

it.each([
  // An array-index key enumerates before the string keys, so `get 0` runs before `port` and
  // rewrites it. Measured on Node 24.22.1.
  [`tls.connect({}, { port: -1, get 0() { this.port = 80; } })`],
] as const)("keeps the acquisition when the writer runs first: %s", (call) => {
  expect(acquisitionsFor(call)).toHaveLength(1);
});

it("emits no acquisition when a spread getter cannot rescue the port", () => {
  expect(
    acquisitionsFor(
      `tls.connect({}, { ...{ get side() { this.port = 80; } }, port: -1 })`,
    ),
  ).toEqual([]);
});
