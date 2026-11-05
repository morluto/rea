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
