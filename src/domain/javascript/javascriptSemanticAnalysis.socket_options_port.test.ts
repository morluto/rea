import { expect, it } from "vitest";

import { analyzeCommonJsSemanticFixture } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * `net.connect` / `net.createConnection` / `tls.connect` validate `options.port`
 * synchronously unless `options.path` (or TLS `options.socket`) takes precedence.
 */
const acquisitionsFor = (body: string) =>
  analyzeJavaScriptSemantics(
    `import net from "node:net";\nimport tls from "node:tls";\nfunction g(p) { ${body}; }`,
  )
    .resourceOperations.filter(({ kind }) => kind === "acquire")
    .map(({ kind, method }) => ({ kind, method }));

it.each([
  ["a negative port", `net.connect({ port: -1 })`],
  ["a port above 65535", `net.connect({ port: 65536 })`],
  ["a fractional port", `net.connect({ port: 1.5 })`],
  ["a NaN port", `net.connect({ port: NaN })`],
  ["an Infinity port", `net.connect({ port: Infinity })`],
  ["a negative Infinity port", `net.connect({ port: -Infinity })`],
  ["an overflowing numeric port", `net.connect({ port: 1e400 })`],
  ["a null port", `net.connect({ port: null })`],
  ["an explicit undefined port", `net.connect({ port: undefined })`],
  ["a void port", `net.connect({ port: void 0 })`],
  ["a true boolean port", `net.connect({ port: true })`],
  ["a false boolean port", `net.connect({ port: false })`],
  ["a zero BigInt port", `net.connect({ port: 0n })`],
  ["a positive BigInt port", `net.connect({ port: 80n })`],
  ["a negative BigInt port", `net.connect({ port: -1n })`],
  ["a unary plus undefined port", `net.connect({ port: +undefined })`],
  ["an empty string port", `net.connect({ port: "" })`],
  ["a whitespace string port", `net.connect({ port: "   " })`],
  ["a negative string port", `net.connect({ port: "-1" })`],
  ["an out-of-range string port", `net.connect({ port: "65536" })`],
  ["a non-numeric string port", `net.connect({ port: "abc" })`],
  ["a trailing-unit string port", `net.connect({ port: "80px" })`],
  ["an empty template port", "net.connect({ port: `` })"],
  ["a non-numeric template port", "net.connect({ port: `abc` })"],
  ["a negated port", `net.connect({ port: !0 })`],
  ["a typeof port", `net.connect({ port: typeof p })`],
  ["an object port", `net.connect({ port: {} })`],
  ["an array port", `net.connect({ port: [80] })`],
  ["a regexp port", `net.connect({ port: /x/ })`],
  ["a function port", `net.connect({ port: () => {} })`],
  ["a class port", `net.connect({ port: class {} })`],
  ["a new Number port", `net.connect({ port: new Number(80) })`],
  ["a new String port", `net.connect({ port: new String("80") })`],
  ["createConnection negative port", `net.createConnection({ port: -1 })`],
  ["an empty path beside a bad port", `net.connect({ path: "", port: -1 })`],
  ["a falsy path beside a bad port", `net.connect({ path: false, port: -1 })`],
  [
    "net ignoring a socket option beside a bad port",
    `net.connect({ socket: p, port: -1 })`,
  ],
  ["net ignoring a later object", `net.connect({ port: -1 }, { port: 443 })`],
  ["a tls negative port", `tls.connect({ port: -1 })`],
  ["a tls bad string port", `tls.connect({ port: "65536" })`],
  [
    "a later tls override introducing a bad port",
    `tls.connect({ port: 443 }, { port: -1 })`,
  ],
  [
    "a later empty tls object preserving a bad port",
    `tls.connect({ port: -1 }, {})`,
  ],
  [
    "a positional port overridden by a bad options port",
    `tls.connect(443, { port: -1 })`,
  ],
  [
    "a positional port overridden by undefined options port",
    `tls.connect(443, { port: undefined })`,
  ],
  [
    "a tls numeric string slot 0 with bad options port",
    `tls.connect("80", { port: -1 })`,
  ],
  [
    "a tls pipe path cleared to undefined before a bad port",
    `tls.connect("/tmp/x.sock", { path: undefined, port: -1 })`,
  ],
  [
    "a tls falsy socket beside a bad port",
    `tls.connect({ socket: null, port: -1 })`,
  ],
  [
    "an empty string path beside null port",
    `net.connect({ path: "", port: null })`,
  ],
  [
    "a createConnection call with empty string path and null port",
    `net.createConnection({ path: "", port: null })`,
  ],
  [
    "a null path beside undefined port",
    `net.connect({ path: null, port: undefined })`,
  ],
  [
    "an undefined path beside undefined port",
    `net.connect({ path: undefined, port: undefined })`,
  ],
  [
    "a tls null path beside undefined port",
    `tls.connect({ path: null, port: undefined })`,
  ],
  [
    "a tls empty string path beside null port",
    `tls.connect({ path: "", port: null })`,
  ],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  ["port zero", `net.connect({ port: 0 })`, "connect"],
  ["negative zero port", `net.connect({ port: -0 })`, "connect"],
  ["port 65535", `net.connect({ port: 65535 })`, "connect"],
  ["integer string port", `net.connect({ port: "80" })`, "connect"],
  ["padded hex string port", `net.connect({ port: " 0x50 " })`, "connect"],
  ["valid template port", "net.connect({ port: `443` })", "connect"],
  ["bitwise unary port", `net.connect({ port: ~(-1.5) })`, "connect"],
  ["coerced unary plus string port", `net.connect({ port: +"80" })`, "connect"],
  ["dynamic port", `net.connect({ port: p })`, "connect"],
  ["interpolated template port", "net.connect({ port: `${p}` })", "connect"],
  [
    "net Unix path taking precedence over bad port",
    `net.connect({ path: "/tmp/x.sock", port: -1 })`,
    "connect",
  ],
  [
    "net dynamic path spread overriding nullish path",
    `net.connect({ path: undefined, ...p, port: -1 })`,
    "connect",
  ],
  [
    "inherited __proto__ path taking precedence over bad port",
    `net.connect({ __proto__: { path: "/tmp/x.sock" }, port: -1 })`,
    "connect",
  ],
  [
    "tls path in slot 0 taking precedence over bad port in slot 1",
    `tls.connect({ path: "/tmp/x.sock" }, { port: -1 })`,
    "connect",
  ],
  [
    "tls positional pipe path taking precedence over bad port",
    `tls.connect("/tmp/x.sock", { port: -1 })`,
    "connect",
  ],
  [
    "tls socket taking precedence over bad port",
    `tls.connect({ socket: p, port: -1 })`,
    "connect",
  ],
  [
    "later tls options overriding bad port",
    `tls.connect({ port: -1 }, { port: 443 })`,
    "connect",
  ],
  [
    "later tls options overriding bad positional port",
    `tls.connect(-1, { port: 443 })`,
    "connect",
  ],
  [
    "later tls host beside valid positional port",
    `tls.connect(443, { host: "example.com" })`,
    "connect",
  ],
  [
    "tls getter writing port or path",
    `tls.connect({ get x() { this.port = 443; return 0; }, port: -1 })`,
    "connect",
  ],
  [
    "later tls options with accessor kept conservative by socketOptionReader",
    `tls.connect({ port: 443 }, { set side(_) {}, port: -1 })`,
    "connect",
  ],
  [
    "valid createConnection port",
    `net.createConnection({ port: 80 })`,
    "createConnection",
  ],
  [
    "empty string path beside undefined port",
    `net.connect({ path: "", port: undefined })`,
    "connect",
  ],
  [
    "false path beside undefined port",
    `net.connect({ path: false, port: undefined })`,
    "connect",
  ],
  [
    "numeric zero path beside undefined port",
    `net.connect({ path: 0, port: undefined })`,
    "connect",
  ],
  [
    "NaN path beside undefined port",
    `net.connect({ path: NaN, port: undefined })`,
    "connect",
  ],
  [
    "empty string path beside void 0 port",
    `net.connect({ path: "", port: void 0 })`,
    "connect",
  ],
  [
    "createConnection with empty string path and undefined port",
    `net.createConnection({ path: "", port: undefined })`,
    "createConnection",
  ],
  [
    "tls empty string path in slot 0 beside undefined port",
    `tls.connect({ path: "" }, { port: undefined })`,
    "connect",
  ],
  [
    "tls empty string path and undefined port with positional port",
    `tls.connect(443, { path: "", port: undefined })`,
    "connect",
  ],
] as const)("keeps the socket acquisition for %s", (_name, call, method) => {
  expect(acquisitionsFor(call)).toEqual([{ kind: "acquire", method }]);
});

it.each(["() => {}", "function () {}", "class {}", "1 - 1", "1 === 1", "p++"])(
  "keeps TCP option validation for non-string TLS slot zero: %s",
  (first) => {
    expect(
      acquisitionsFor(`tls.connect(${first}, { port: 443, host: 42 })`),
    ).toEqual([]);
    expect(
      acquisitionsFor(`tls.connect(${first}, { port: -1, host: "localhost" })`),
    ).toEqual([]);
    expect(
      acquisitionsFor(
        `tls.connect(${first}, { port: 443, host: "localhost" })`,
      ),
    ).toEqual([{ kind: "acquire", method: "connect" }]);
  },
);

const inheritedPortSetter = `Object.defineProperty(Object.prototype, "port", {
  configurable: true, get() { return 443; }, set(_) {}
});`;

it.each([
  `tls.connect(443, { path: null, socket: null, port: -1 })`,
  `tls.connect({}, { path: null, socket: null, port: -1 })`,
])(
  "keeps TLS acquisitions when inherited setters absorb writes: %s",
  (call) => {
    expect(acquisitionsFor(`${inheritedPortSetter} ${call}`)).toEqual([
      { kind: "acquire", method: "connect" },
    ]);
  },
);

it.each([
  `tls.connect({ path: null, socket: null, port: 80 }, { port: -1 })`,
  `tls.connect({ __proto__: null }, { path: null, socket: null, port: -1 })`,
])("rejects invalid TLS ports when target writes are ordinary: %s", (call) => {
  expect(acquisitionsFor(`${inheritedPortSetter} ${call}`)).toEqual([]);
});

it("ignores a prototype setter installed after the TLS call", () => {
  // A reusable function could have installed the setter in an earlier call.
  expect(
    analyzeJavaScriptSemantics(`import tls from "node:tls";
      tls.connect(443, { path: null, socket: null, port: -1 });
      ${inheritedPortSetter}`).resourceOperations,
  ).toEqual([]);
});

it("shares inherited-setter uncertainty with TLS host validation", () => {
  expect(
    acquisitionsFor(`Object.defineProperty(Object.prototype, "host", {
      configurable: true, get() { return "localhost"; }, set(_) {}
    }); tls.connect(443, { path: null, socket: null, host: 42 });`),
  ).toEqual([{ kind: "acquire", method: "connect" }]);
});

it("keeps the socket acquisition when Object.prototype.path may precede", () => {
  const operations = analyzeCommonJsSemanticFixture(`
    const net = require("node:net");
    function seed() {}
    Object.prototype.path = "/tmp/a.sock";
    net.connect({ port: -1 });
  `)
    .resourceOperations.filter(({ kind }) => kind === "acquire")
    .map(({ kind, method }) => ({ kind, method }));
  expect(operations).toEqual([{ kind: "acquire", method: "connect" }]);
});

it.each([
  `const net = require("node:net"); const s = net.connect({ port: -1 }); s.destroy();`,
  `const { connect } = require("node:tls"); const s = connect({ port: 65536 }); s.end();`,
])(
  "applies Node options.port rejection only to an established builtin: %s",
  (source) => {
    expect(analyzeJavaScriptSemantics(source).resourceOperations).toMatchObject(
      [
        { kind: "acquire", builtinAuthority: "candidate" },
        { kind: "release", builtinAuthority: "candidate" },
      ],
    );
    expect(analyzeCommonJsSemanticFixture(source).resourceOperations).toEqual(
      [],
    );
  },
);
