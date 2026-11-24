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
  [
    "a later accepted version over a rejected one",
    `tls.connect({ port: 443, minVersion: "nope" }, { minVersion: "TLSv1.2" })`,
  ],
  [
    "a supplied secure context beside a bad version",
    `tls.connect({ port: 80, secureContext: ctx, minVersion: "nope" })`,
  ],
  [
    "an accessor version with no explicit one",
    `tls.connect({ port: 80, get minVersion() { return "TLSv1.2"; } })`,
  ],
] as const)("keeps the socket acquisition for %s", (_name, call) => {
  // Several object arguments merge in order, so a later one wins; a supplied
  // `secureContext` bypasses version parsing entirely; and an accessor runs a body, so its
  // result is not settled by this literal. Measured on Node 24.22.1.
  expect(acquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "connect" },
  ]);
});

it.each([
  [
    "a rejected version over an accepted one",
    `tls.connect({ port: 443, minVersion: "TLSv1.2" }, { minVersion: "nope" })`,
  ],
  [
    "a later rejected version with no earlier one",
    `tls.connect({ port: 443 }, { minVersion: "nope" })`,
  ],
  [
    "a null secure context beside a bad version",
    `tls.connect({ port: 80, secureContext: null, minVersion: "nope" })`,
  ],
  [
    "an ordinary method beside a bad version",
    `tls.connect({ port: 80, checkServerIdentity() {}, minVersion: "nope" })`,
  ],
  ["an arrow version", `tls.connect({ port: 80, minVersion: () => {} })`],
  [
    "a function version",
    `tls.connect({ port: 80, minVersion: function () {} })`,
  ],
  ["a class version", `tls.connect({ port: 80, minVersion: class {} })`],
  ["a negative BigInt version", `tls.connect({ port: 80, minVersion: -1n })`],
  ["a version method member", `tls.connect({ port: 80, minVersion() {} })`],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  // An ordinary method cannot install a version, and an arrow, function, class or signed
  // BigInt version is a truthy non-string, so each of these throws at the call site.
  expect(acquisitionsFor(call)).toEqual([]);
});
it.each([
  [
    "a falsy boolean secure context",
    `tls.connect({ port: 443, secureContext: false, minVersion: "nope" })`,
  ],
  [
    "a zero secure context",
    `tls.connect({ port: 443, secureContext: 0, minVersion: "nope" })`,
  ],
  [
    "an empty-string secure context",
    `tls.connect({ port: 443, secureContext: "", minVersion: "nope" })`,
  ],
  [
    "a rejected version in the first of three objects",
    `tls.connect(443, { minVersion: "nope" }, { minVersion: "TLSv1.2" })`,
  ],
  [
    "a rejected version after port and host",
    `tls.connect(443, "127.0.0.1", { minVersion: "nope" })`,
  ],
  [
    "a rejected version written after a good one",
    `tls.connect({ port: 443, minVersion: "TLSv1.2" }, { minVersion: "nope" })`,
  ],
  [
    "an exact computed key",
    `tls.connect({ port: 80, ["minVersion"]: "nope" })`,
  ],
  ["an unmodified NaN version", `tls.connect({ port: 80, minVersion: NaN })`],
  [
    "an unmodified Infinity version",
    `tls.connect({ port: 80, minVersion: Infinity })`,
  ],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  // A falsy secure context does not bypass version parsing; Node copies at most one options
  // object so a third argument is ignored; an exact computed key names the same member; and
  // an unshadowed NaN or Infinity is a non-string version. Measured on Node 24.22.1.
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  [
    "a supplied secure context",
    `tls.connect({ port: 443, secureContext: {}, minVersion: "nope" })`,
  ],
  [
    "an unreadable secure context",
    `const f = {}; tls.connect({ port: 443, secureContext: f, minVersion: "nope" })`,
  ],
  [
    "a good version in the first of three objects",
    `tls.connect(443, { minVersion: "TLSv1.2" }, { minVersion: "nope" })`,
  ],
  [
    "a good version written after a rejected one",
    `tls.connect({ port: 443, minVersion: "nope" }, { minVersion: "TLSv1.2" })`,
  ],
  [
    "an accessor that writes the version",
    `tls.connect({ port: 80, get side() { this.minVersion = "TLSv1.2"; }, minVersion: "nope" })`,
  ],
  [
    "a setter that absorbs a later version",
    `tls.connect({ port: 80, set minVersion(_) {} }, { minVersion: "nope" })`,
  ],
  [
    "a shadowed NaN version",
    `const NaN = {}; tls.connect({ port: 80, minVersion: NaN })`,
  ],
  [
    "a spread beside a rejected version",
    `const o = {}; tls.connect({ port: 80, ...o, minVersion: "nope" })`,
  ],
] as const)("keeps the socket acquisition for %s", (_name, call) => {
  // Only a truthy context bypasses parsing, the second object wins when slot 0 is an
  // object, and an accessor runs a body this reader does not replay.
  expect(acquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "connect" },
  ]);
});
it.each([
  [
    "an unreadable computed key that may re-write the version",
    `const k = "minVersion"; tls.connect({ port: 443, minVersion: "nope", [k]: "TLSv1.2" })`,
  ],
  [
    "a getter that shadows a version method",
    `tls.connect({ port: 443, get side() { this.minVersion = "TLSv1.2"; }, minVersion() {} })`,
  ],
  [
    "an unreadable second options object",
    `const o = { minVersion: "TLSv1.2" }; tls.connect({ port: 443, minVersion: "nope" }, o)`,
  ],
] as const)("keeps the socket acquisition for %s", (_name, call) => {
  // `semanticStaticPropertyKey` is the nullable owner: an unresolved key is `null`, not
  // `""`. An accessor can also replace a plain method before Node copies it, and a
  // non-literal second argument is a merged options object rather than an absent one.
  expect(acquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "connect" },
  ]);
});

it.each([
  [
    "a signed-zero secure context",
    `tls.connect({ port: 443, secureContext: -0, minVersion: "nope" })`,
  ],
  ["a logical-not version", `tls.connect({ port: 443, minVersion: !0 })`],
  ["a double-not version", `tls.connect({ port: 443, minVersion: !!0 })`],
  [
    "a double-bitwise-not version",
    `tls.connect({ port: 443, minVersion: ~~0 })`,
  ],
  ["a typeof version", `tls.connect({ port: 443, minVersion: typeof 1 })`],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  // `-0` is falsy, so the context does not bypass parsing; and a unary operator over a
  // settled operand is a settled non-string primitive, which Node refuses.
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  ["a void version", `tls.connect({ port: 443, minVersion: void 0 })`],
] as const)("keeps the socket acquisition for %s", (_name, call) => {
  // `void` is `undefined`, which Node reads as "not given", and a plain method is a value
  // Node never reads as a version name when no accessor can replace it.
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
    "a version supplied by an unresolvable computed key",
    `const k = "minVersion"; tls.connect({ port: 80, [k]: "nope" })`,
  ],
  ["net ignoring the member", `net.connect({ port: 80, minVersion: "nope" })`],
] as const)("keeps the socket acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "connect" },
  ]);
});

it.each([
  `tls.connect({port:443,minVersion:"nope"},()=>{})`,
  `tls.connect({port:443,minVersion:"nope",...{}})`,
  `tls.connect({port:443,...{minVersion:"nope"}})`,
  `tls.connect({port:443,...{...{minVersion:"nope"}}})`,
  `tls.connect({port:443,minVersion:"nope",...0})`,
  `tls.connect({port:443,minVersion:"nope",secureContext:undefined})`,
  `tls.connect({port:443,minVersion:"nope",secureContext:void 0})`,
  `tls.connect({port:443,minVersion:-value})`,
  `tls.connect({port:443,minVersion:delete options.version})`,
])("keeps TLS rejection and linked release consistent: %s", (call) => {
  const semantics = analyzeJavaScriptSemantics(
    `import tls from "node:tls";function g(){const socket=${call};socket.destroy();}`,
  );
  expect(semantics.resourceOperations).toEqual([]);
});

it.each([
  `tls.connect(443,null,{minVersion:"nope"})`,
  `tls.connect(443,()=>{}, {minVersion:"nope"})`,
])("reads TLS override after a known non-object argument: %s", (call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});
it.each([
  `tls.connect({port:443,minVersion:"nope"},()=>{}, {minVersion:"TLSv1.2"})`,
  `tls.connect({port:443,minVersion:"TLSv1.2"},[], {minVersion:"nope"})`,
  `tls.connect(options,{minVersion:"nope"})`,
])("preserves effective accepted or unresolved TLS options: %s", (call) => {
  expect(acquisitionsFor(call)).toHaveLength(1);
});

it("keeps a TLS version override unknown when the merge target may absorb it", () => {
  expect(
    acquisitionsFor(
      `tls.connect({port:443,secureContext:false,__proto__:{set minVersion(value){}}},{minVersion:"nope"})`,
    ),
  ).toHaveLength(1);
});
it.each(["null", "0"])(
  "rejects the override when prototype %s cannot absorb it",
  (prototype) => {
    expect(
      acquisitionsFor(
        `tls.connect({port:443,secureContext:false,__proto__:${prototype}},{minVersion:"nope"})`,
      ),
    ).toEqual([]);
  },
);

it.each([
  `class O {port=443;set minVersion(value){}};const socket=tls.connect(new O(),{secureContext:false,minVersion:"nope"});socket.destroy();`,
  `const socket=tls.connect({port:443,minVersion:"nope"},null,class {static minVersion="TLSv1.2"});socket.destroy();`,
  `const socket=tls.connect({port:443,secureContext:false},{["__proto__"]:{set minVersion(value){}},minVersion:"nope"});socket.destroy();`,
])(
  "preserves uncertain target assignments and enumerable sources: %s",
  (body) => {
    const ir = analyzeJavaScriptSemantics(
      `import tls from "node:tls";function g(){${body}}`,
    );
    expect(
      ir.resourceOperations.filter((value) => value.kind === "acquire"),
    ).toHaveLength(1);
    expect(
      ir.resourceOperations.filter((value) => value.kind === "release"),
    ).toHaveLength(1);
  },
);
it.each([
  `tls.connect({port:443,minVersion:"nope"},class {static minVersion="TLSv1.2"})`,
  `tls.connect({port:443,secureContext:false},{["__proto__"]:null,minVersion:"nope"})`,
  `tls.connect({port:443,secureContext:false},{["__proto__"]:0,minVersion:"nope"})`,
])("retains definite rejection for the actual selected source: %s", (call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  'tls.connect({port:443,minVersion:"nope"},null,null)',
  'tls.connect({port:443,minVersion:"nope"},null,5)',
  'tls.connect({port:443,minVersion:"nope"},null,"TLSv1.2")',
  'tls.connect({port:443,minVersion:"nope"},null,()=>{})',
  'tls.connect({port:443,minVersion:"nope"},{__proto__:{minVersion:"TLSv1.2"}})',
])("copies only enumerable own option properties: %s", (call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});
