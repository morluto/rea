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
] as const)("keeps the socket acquisition for %s", (_name, call, method) => {
  expect(socketAcquisitionsFor(call)).toEqual([{ kind: "acquire", method }]);
});
/**
 * The port can also sit inside an options object, and Node validates it there too.
 *
 * Measured on Node 24.22.1:
 *
 *   net.connect({port:-1})                 -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect({port:"-1"})               -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect({port:""}) / " " / "abc"   -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect({port:null}) / true        -> THREW ERR_INVALID_ARG_TYPE
 *   net.connect({port:NaN}) / Infinity     -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect({port:80}) / "80"          -> Socket created
 *   net.connect({port:" 80 "}) / "0x50"    -> Socket created (coerced)
 *   net.connect({port:"1e2"}) / "080"      -> Socket created
 *   net.connect({port:-1, path:"/tmp/x"})  -> Socket created (path wins)
 *   net.connect({port:-1, path:""})        -> THREW (empty path does not rescue)
 *   net.connect({port:-1, host:"h"})       -> THREW
 *   net.connect({port:-1, socket:{}})      -> THREW (net ignores socket)
 *   tls.connect({port:-1, path:"/tmp/x"})  -> Socket created
 *   net.connect(80, {port:-1})             -> Socket created (positional port wins)
 *   net.connect(-1, {port:80})             -> THREW (positional port validated)
 */
it.each([
  ["an options negative port", `net.connect({port: -1})`],
  ["an options port above the range", `net.connect({port: 70000})`],
  ["an options fractional port", `net.connect({port: 1.5})`],
  ["an options null port", `net.connect({port: null})`],
  ["an options boolean port", `net.connect({port: true})`],
  ["an options NaN port", `net.connect({port: NaN})`],
  ["an options Infinity port", `net.connect({port: Infinity})`],
  ["an options negative string port", `net.connect({port: "-1"})`],
  ["an options empty string port", `net.connect({port: ""})`],
  ["an options whitespace string port", `net.connect({port: " "})`],
  ["an options non-numeric string port", `net.connect({port: "abc"})`],
  ["an options fractional string port", `net.connect({port: "1.5"})`],
  ["an options out-of-range string port", `net.connect({port: "65536"})`],
  [
    "an options empty path that does not rescue",
    `net.connect({port: -1, path: ""})`,
  ],
  ["an options bad port beside a host", `net.connect({port: -1, host: "h"})`],
  [
    "an options bad port beside a net socket",
    `net.connect({port: -1, socket: {}})`,
  ],
  ["a tls options negative port", `tls.connect({port: -1})`],
  ["a tls options empty path", `tls.connect({port: -1, path: ""})`],
  [
    "a createConnection options negative port",
    `net.createConnection({port: -1})`,
  ],
  [
    "a positional negative port beside valid options",
    `net.connect(-1, {port: 80})`,
  ],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(socketAcquisitionsFor(call)).toEqual([]);
});

it.each([
  ["an options port", `net.connect({port: 80})`],
  ["an options string port", `net.connect({port: "80"})`],
  ["a padded options string port", `net.connect({port: " 80 "})`],
  ["a hex options string port", `net.connect({port: "0x50"})`],
  ["an exponential options string port", `net.connect({port: "1e2"})`],
  ["a padded-zero options string port", `net.connect({port: "080"})`],
  [
    "an options port rescued by a path",
    `net.connect({port: -1, path: "/tmp/x"})`,
  ],
  ["an options port beside a host", `net.connect({port: 80, host: "h"})`],
  [
    "a tls options port rescued by a path",
    `tls.connect({port: -1, path: "/tmp/x"})`,
  ],
  ["a positional port beside bad options", `net.connect(80, {port: -1})`],
] as const)("keeps the socket acquisition for %s", (_name, call) => {
  expect(socketAcquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "connect" },
  ]);
});
/**
 * A later options argument, a `void` port and an overflowing literal.
 *
 * Measured on Node 24.22.1:
 *
 *   tls.connect({port:-1}, {port:80})       -> Socket created (tls merges)
 *   tls.connect({port:80}, {port:-1})       -> THREW ERR_SOCKET_BAD_PORT
 *   tls.connect({port:-1}, () => {})        -> THREW (callback is not an override)
 *   tls.connect({port:-1}, undefined)        -> THREW
 *   tls.connect({port:-1}, 0) / "x" / [80]   -> THREW (only an object overrides)
 *   net.connect({port:-1}, {port:80})        -> THREW (net does not merge)
 *   net.connect({port:80}, {port:-1})        -> Socket created
 *   net.connect({port:void 0})               -> THREW ERR_MISSING_ARGS (undecided)
 *   net.connect({port:void 0, path:""})      -> Socket created (port reads as 0)
 *   net.connect({port:void Infinity,path:""}) -> Socket created
 *   net.connect({port:1e400}) / 1e309 / -1e400 -> THREW ERR_SOCKET_BAD_PORT
 *   net.connect({port:-Infinity}) / -NaN     -> THREW ERR_SOCKET_BAD_PORT
 */
it.each([
  [
    "a tls port overridden by a later bad object",
    `tls.connect({port: 80}, {port: -1})`,
  ],
  ["a tls port beside a callback", `tls.connect({port: -1}, () => {})`],
  ["a tls port beside undefined", `tls.connect({port: -1}, undefined)`],
  ["a tls port beside a number", `tls.connect({port: -1}, 0)`],
  ["a tls port beside a string", `tls.connect({port: -1}, "x")`],
  ["a tls port beside an array", `tls.connect({port: -1}, [80])`],
  [
    "a net port beside a valid later object",
    `net.connect({port: -1}, {port: 80})`,
  ],
  [
    "a net port beside a later socket path",
    `net.connect({port: -1}, {path: "/tmp/x"})`,
  ],
  ["an overflowing numeric port", `net.connect({port: 1e400})`],
  ["a just-overflowing numeric port", `net.connect({port: 1e309})`],
  ["a negative overflowing numeric port", `net.connect({port: -1e400})`],
  ["a tls overflowing numeric port", `tls.connect({port: 1e400})`],
  ["a negative Infinity member", `net.connect({port: -Infinity})`],
  ["a negated NaN member", `net.connect({port: -NaN})`],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(socketAcquisitionsFor(call)).toEqual([]);
});

it.each([
  [
    "a tls port overridden by a later valid object",
    `tls.connect({port: -1}, {port: 80})`,
    "connect",
  ],
  [
    "a tls port rescued by a later path",
    `tls.connect({port: -1}, {path: "/tmp/x"})`,
    "connect",
  ],
  [
    "a net port beside a later valid object",
    `net.connect({port: 80}, {port: -1})`,
    "connect",
  ],
  [
    "an undefined port with an empty path",
    `net.connect({port: void 0, path: ""})`,
    "connect",
  ],
  [
    "a void non-finite port with an empty path",
    `net.connect({port: void Infinity, path: ""})`,
    "connect",
  ],
  [
    "an undefined port with a socket path",
    `net.connect({port: void 0, path: "/tmp/x"})`,
    "connect",
  ],
  [
    "a tls undefined port with an empty path",
    `tls.connect({port: void 0, path: ""})`,
    "connect",
  ],
] as const)("keeps the socket acquisition for %s", (_name, call, method) => {
  expect(socketAcquisitionsFor(call)).toEqual([{ kind: "acquire", method }]);
});
/**
 * Which later argument `tls` merges, and signed spellings judged by value.
 *
 * Measured on Node 24.22.1:
 *
 *   tls.connect({port:80},{port:80},{port:-1})   -> socket (argument 1 decides)
 *   tls.connect({port:80},{port:-1},{port:80})   -> THREW
 *   tls.connect({port:80},null,{port:-1})        -> THREW  (argument 2 decides)
 *   tls.connect({port:80},0,{port:-1})           -> THREW  (argument 2 decides)
 *   tls.connect({port:80},'x',{port:-1})         -> THREW  (argument 2 decides)
 *   tls.connect({port:80},() => {},{port:-1})    -> THREW  (argument 2 decides)
 *   tls.connect({port:80},{port:80},{port:80},{port:-1}) -> socket (argument 3 ignored)
 *   net.connect({port:-0}) / {port:+0} / {port:+80} / {port:+65535} -> socket
 *   net.connect({port:+65536}) / {port:-65536} / {port:-80} / {port:+1.5} -> THREW
 */
it.each([
  [
    "a tls port overridden by argument 1",
    `tls.connect({port: 80}, {port: -1}, {port: 80})`,
  ],
  [
    "a tls port beside a null argument 1",
    `tls.connect({port: 80}, null, {port: -1})`,
  ],
  [
    "a tls port beside an undefined argument 1",
    `tls.connect({port: 80}, undefined, {port: -1})`,
  ],
  [
    "a tls port beside a number argument 1",
    `tls.connect({port: 80}, 0, {port: -1})`,
  ],
  [
    "a tls port beside a string argument 1",
    `tls.connect({port: 80}, "x", {port: -1})`,
  ],
  [
    "a tls port beside a callback argument 1",
    `tls.connect({port: 80}, () => {}, {port: -1})`,
  ],
  ["a positive out-of-range signed port", `net.connect({port: +65536})`],
  ["a negative out-of-range signed port", `net.connect({port: -65536})`],
  ["a negative signed port", `net.connect({port: -80})`],
  ["a positive fractional signed port", `net.connect({port: +1.5})`],
  ["a negative fractional signed port", `net.connect({port: -1.5})`],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(socketAcquisitionsFor(call)).toEqual([]);
});

it.each([
  [
    "a tls port decided by argument 1 over a bad argument 2",
    `tls.connect({port: 80}, {port: 80}, {port: -1})`,
  ],
  [
    "a tls port decided by argument 1 over a bad first port",
    `tls.connect({port: -1}, {port: 80}, {port: 80})`,
  ],
  [
    "a tls port when argument 3 is ignored",
    `tls.connect({port: 80}, {port: 80}, {port: 80}, {port: -1})`,
  ],
  ["a negative zero port", `net.connect({port: -0})`],
  ["a negative zero float port", `net.connect({port: -0.0})`],
  ["a positive zero port", `net.connect({port: +0})`],
  ["a positive signed port", `net.connect({port: +80})`],
  ["the highest positive signed port", `net.connect({port: +65535})`],
  ["a hex port", `net.connect({port: 0x10})`],
] as const)("keeps the socket acquisition for %s", (_name, call) => {
  expect(socketAcquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "connect" },
  ]);
});
/**
 * A positional port combined with an options object, where `net` and `tls` differ.
 *
 * Measured on Node 24.22.1:
 *
 *   net.connect(-1, {port:80})          -> THREW  (the positional port wins)
 *   net.connect(80, {port:-1})          -> socket (options port never read)
 *   tls.connect(80, {port:-1})          -> THREW  (the options port wins)
 *   tls.connect(-1, {port:80})          -> socket
 *   tls.connect(65536, {port:80})       -> socket
 *   tls.connect(-1, {})                 -> THREW  (no options port, positional read)
 *   tls.connect(-1, () => {}, {port:80})-> socket
 *   tls.connect(80, () => {}, {port:-1})-> THREW
 */
it.each([
  [
    "a net positional port overridden by options",
    `net.connect(-1, {port: 80})`,
  ],
  [
    "a createConnection positional port overridden by options",
    `net.createConnection(-1, {port: 80})`,
  ],
  [
    "a tls positional port replaced by a bad options port",
    `tls.connect(80, {port: -1})`,
  ],
  [
    "a tls positional port beside an empty options object",
    `tls.connect(-1, {})`,
  ],
  [
    "a tls positional port beside a host-only object",
    `tls.connect(65536, {host: "h"})`,
  ],
  [
    "a tls positional port beside a fractional options port",
    `tls.connect(80, {port: 1.5})`,
  ],
  [
    "a tls positional port beside a null options port",
    `tls.connect(80, {port: null})`,
  ],
  [
    "a tls positional port beside an empty string options port",
    `tls.connect(80, {port: ""})`,
  ],
  [
    "a tls callback then a bad options port",
    `tls.connect(80, () => {}, {port: -1})`,
  ],
  [
    "a tls positional port beside a bad second argument",
    `tls.connect(-1, undefined, {})`,
  ],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(socketAcquisitionsFor(call)).toEqual([]);
});

it.each([
  [
    "a net positional port with ignored bad options",
    `net.connect(80, {port: -1})`,
  ],
  [
    "a createConnection positional port with ignored bad options",
    `net.createConnection(80, {port: -1})`,
    "createConnection",
  ],
  [
    "a tls positional port replaced by a good options port",
    `tls.connect(-1, {port: 80})`,
  ],
  [
    "a tls out-of-range positional port replaced by options",
    `tls.connect(65536, {port: 80})`,
  ],
  [
    "a tls positional port with a good options port",
    `tls.connect(80, {port: 80})`,
  ],
  [
    "a tls positional port with a portless options object",
    `tls.connect(80, {})`,
  ],
  [
    "a tls positional port rescued by an options path",
    `tls.connect(-1, {path: "/tmp/x"})`,
  ],
  [
    "a tls callback then a good options port",
    `tls.connect(-1, () => {}, {port: 80})`,
  ],
  [
    "a tls positional port with only callbacks",
    `tls.connect(80, () => {}, () => {})`,
  ],
  [
    "a tls positional port with a null second argument",
    `tls.connect(80, null)`,
  ],
] as const)(
  "keeps the socket acquisition for %s",
  (_name, call, method?: "connect" | "createConnection") => {
    expect(socketAcquisitionsFor(call)).toEqual([
      { kind: "acquire", method: method ?? "connect" },
    ]);
  },
);
/**
 * Which slot `tls` merges, and an unreadable `path` that may still rescue.
 *
 * Measured on Node 24.22.1:
 *
 *   tls.connect(-1, [], {port:80})         -> THREW (an array fills slot 1, so slot 2
 *                                            is ignored and the positional port wins)
 *   tls.connect(-1, /x/, {port:80})        -> THREW
 *   tls.connect(-1, () => {}, {port:80})   -> socket (a callback frees slot 1)
 *   tls.connect(-1, 0, {port:80})          -> socket
 *   tls.connect(80, [], {port:-1})         -> socket
 *   tls.connect(80, /x/, {port:-1})        -> socket
 *   tls.connect(80, {port:-1, path:p})     -> socket when `p` is a non-empty path
 *   net.connect(80, {port:-1, path:p})     -> socket
 */
it.each([
  [
    "a tls positional port with an array slot",
    `tls.connect(-1, [], {port: 80})`,
  ],
  [
    "a tls positional port with a regexp slot",
    `tls.connect(-1, /x/, {port: 80})`,
  ],
  [
    "a tls positional port with a two-element array slot",
    `tls.connect(-1, [1, 2], {port: 80})`,
  ],
  [
    "a tls positional port with an array slot and no port",
    `tls.connect(-1, [], {})`,
  ],
] as const)("emits no socket acquisition for %s", (_name, call) => {
  expect(socketAcquisitionsFor(call)).toEqual([]);
});

it.each([
  ["a tls port beside an array slot", `tls.connect(80, [], {port: -1})`],
  ["a tls port beside a regexp slot", `tls.connect(80, /x/, {port: -1})`],
  [
    "a tls options port beside an array slot",
    `tls.connect({port: 80}, [], {port: -1})`,
  ],
  [
    "a tls options port beside a regexp slot",
    `tls.connect({port: 80}, /x/, {port: -1})`,
  ],
  [
    "a tls port beside a callback slot",
    `tls.connect(-1, () => {}, {port: 80})`,
  ],
  ["a tls port beside a numeric slot", `tls.connect(-1, 0, {port: 80})`],
  [
    "a tls bad port beside an unreadable path",
    `tls.connect(80, {port: -1, path: p})`,
  ],
  [
    "a net bad port beside an unreadable path",
    `net.connect(80, {port: -1, path: p})`,
  ],
] as const)("keeps the socket acquisition for %s", (_name, call) => {
  expect(socketAcquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "connect" },
  ]);
});
/**
 * A `socket` member on `tls.connect` only rescues the port check when it is a real
 * stream. Every literal is decided: `false`, `0`, `""`, `0n` and `null` are present but
 * not streams, so Node still validates the port; `{}`, `[]` and `() => {}` pass the
 * port check and then throw from the stream check.
 *
 * Measured on Node 24.22.1 with an invalid port:
 *
 *   { socket: false | 0 | -0 | "" | 0n | null }  -> THREW ERR_SOCKET_BAD_PORT
 *   { socket: undefined | void 0 }               -> THREW ERR_SOCKET_BAD_PORT
 *   { socket: {} | [] | () => {} | 1 | "x" }     -> THREW TypeError
 *   { socket: new net.Socket() }                 -> Socket created
 *   net.connect({ socket: <any> })               -> THREW (net ignores `socket`)
 */
it.each([
  [`tls.connect({ socket: false, port: -1 })`],
  [`tls.connect({ socket: 0, port: -1 })`],
  [`tls.connect({ socket: -0, port: -1 })`],
  [`tls.connect({ socket: "", port: -1 })`],
  [`tls.connect({ socket: 0n, port: -1 })`],
  [`tls.connect({ socket: null, port: -1 })`],
  [`tls.connect({ socket: undefined, port: -1 })`],
  [`tls.connect({ socket: void 0, port: -1 })`],
  [`tls.connect({ socket: {}, port: -1 })`],
  [`tls.connect({ socket: [], port: -1 })`],
  [`tls.connect({ socket: () => {}, port: -1 })`],
  [`tls.connect({ socket: 1, port: -1 })`],
  [`tls.connect({ socket: "x", port: -1 })`],
  [`tls.connect({ socket: /x/, port: -1 })`],
] as const)("emits no acquisition for a literal socket member: %s", (call) => {
  expect(socketAcquisitionsFor(call)).toEqual([]);
});

it.each([
  ["a real socket binding", `tls.connect({ socket: s, port: -1 })`],
  ["a call result", `tls.connect({ socket: open(), port: -1 })`],
  [
    "a falsy socket with a valid port",
    `tls.connect({ socket: false, port: 65535 })`,
  ],
  [
    "an empty-string socket with a valid port",
    `tls.connect({ socket: "", port: 65535 })`,
  ],
  [
    "a zero socket with a valid port",
    `tls.connect({ socket: 0, port: 65535 })`,
  ],
] as const)("keeps the acquisition for %s", (_name, call) => {
  expect(socketAcquisitionsFor(call)).toHaveLength(1);
});

/**
 * A `socket` member named `undefined` is absent only while the global is unshadowed.
 * Measured on Node 24.22.1: `tls.connect({ socket: undefined, port: -1 })` throws, but
 * a parameter or local named `undefined` carries that binding's value instead.
 */
const socketAcquisitionsIn = (source: string) =>
  analyzeJavaScriptSemantics(
    `import tls from "node:tls";\n${source}`,
  ).resourceOperations.filter(({ kind }) => kind === "acquire").length;

it("reads the global undefined as an absent socket member", () => {
  expect(
    socketAcquisitionsIn(
      `function g() { tls.connect({ socket: undefined, port: -1 }); }`,
    ),
  ).toBe(0);
});

it("does not read a shadowed undefined as the global", () => {
  // A parameter named `undefined` may hold a real stream, so the port check cannot be
  // proven here and the acquisition stays.
  expect(
    socketAcquisitionsIn(
      `function g(undefined) { tls.connect({ socket: undefined, port: -1 }); }`,
    ),
  ).toBe(1);
});

it("does not read a shadowed undefined as absent in the merge slot", () => {
  // `tls` uses slot 1 as the override when it is an object. A shadowed `undefined` may
  // be an object, so slot 2 is not provably the deciding argument.
  expect(
    socketAcquisitionsIn(
      `function g(undefined) { tls.connect({ port: -1 }, undefined); }`,
    ),
  ).toBe(1);
});

it("still defers to slot 2 for the global undefined", () => {
  expect(
    socketAcquisitionsIn(
      `function g() { tls.connect({ port: 80 }, undefined, { port: -1 }); }`,
    ),
  ).toBe(0);
});
/**
 * An object literal can carry a socket's stream methods through a non-computed
 * `__proto__` setter, and `tls` then wraps it instead of connecting. Measured on
 * Node 24.22.1 with an invalid port:
 *
 *   {__proto__: stream}            -> TLSSocket (the port is never read)
 *   {__proto__: stream, extra: 1}  -> TLSSocket
 *   {}                             -> THREW TypeError
 *   {__proto__: null}              -> THREW TypeError
 *   {__proto__: {}}                -> THREW TypeError
 *   {__proto__: 5}                 -> THREW TypeError
 *   {["__proto__"]: stream}        -> THREW TypeError (a computed key is an own property)
 *
 * So an object literal leaves the answer open only when its prototype value is not
 * exactly readable.
 */
const socketIn = (call: string) =>
  analyzeJavaScriptSemantics(
    `import tls from "node:tls";\nfunction g(p, stream) { ${call}; }`,
  ).resourceOperations.filter(({ kind }) => kind === "acquire").length;

it.each([
  [`tls.connect({ port: -1, socket: { __proto__: stream } })`],
  [`tls.connect({ port: -1, socket: { __proto__: stream, extra: 1 } })`],
  [`tls.connect({ port: -1, socket: { __proto__: deep } })`],
] as const)(
  "keeps a socket literal that may inherit stream methods: %s",
  (call) => {
    expect(socketIn(call)).toBe(1);
  },
);

it.each([
  [`tls.connect("")`],
  [`tls.connect("", {})`],
  [`tls.connect("", { port: -1 })`],
  [`net.connect("", { port: 80 })`],
  [`tls.connect({ port: 80, socket: {} })`],
  [`tls.connect({ port: 80, socket: "x" })`],
  [`tls.connect({ port: 80, socket: 5 })`],
  [`tls.connect({ port: 80, socket: [] })`],
  [`tls.connect({ port: 80, socket: () => {} })`],
] as const)("emits no socket acquisition for %s", (call) => {
  // An empty first argument is rejected by both `net` and `tls` unless `tls` merges a
  // usable option over it, and a truthy literal `socket` makes `tls`'s stream wrap throw
  // whatever the port says. Measured on Node 24.22.1.
  expect(socketAcquisitionsFor(call)).toEqual([]);
});

it.each([
  [`tls.connect("", { port: 80 })`],
  [`tls.connect("", { path: "/tmp/x.sock" })`],
  [`tls.connect({ port: 80, socket: null })`],
  [`tls.connect({ port: 80, socket: false })`],
  [`tls.connect({ port: 80, socket: 0 })`],
  [`tls.connect({ port: 80, socket: "" })`],
] as const)("keeps the socket acquisition for %s", (call) => {
  expect(socketAcquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "connect" },
  ]);
});
it.each([
  [`tls.connect({ port: -1, socket: {} })`],
  [`tls.connect({ port: -1, socket: { __proto__: null } })`],
  [`tls.connect({ port: -1, socket: { __proto__: {} } })`],
  [`tls.connect({ port: -1, socket: { __proto__: 5 } })`],
  [`tls.connect({ port: -1, socket: { ["__proto__"]: stream } })`],
] as const)("emits no acquisition for a decided socket literal: %s", (call) => {
  expect(socketIn(call)).toBe(0);
});
