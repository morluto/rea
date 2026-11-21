import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * Node validates the command before anything else, so a command it refuses
 * throws synchronously and no child process exists.
 *
 * Measured on Node 24.22.1 for spawn, execFile, exec and fork:
 *
 *   spawn() / spawn(null) / spawn(undefined) -> THREW ERR_INVALID_ARG_TYPE
 *   spawn(5) / spawn(true) / spawn({})       -> THREW ERR_INVALID_ARG_TYPE
 *   spawn([])                                -> THREW ERR_INVALID_ARG_TYPE
 *   spawn("no\0de")                          -> THREW ERR_INVALID_ARG_VALUE
 *   spawn("") / execFile("") / exec("")      -> THREW ERR_INVALID_ARG_VALUE
 *   fork("")                                 -> child
 *   spawn(" ") / spawn("node")               -> child
 */
const spawnsFor = (call: string) =>
  analyzeJavaScriptSemantics(
    `import { spawn, execFile, exec, fork } from "node:child_process";\nfunction g(command, args) { ${call}; }`,
  ).childProcessSpawns.map(({ method }) => method);

it.each([
  ["a string uid", 'spawn("node", [], { uid: "100" })'],
  ["a fractional gid", 'execFile("node", [], { gid: 1.5 }, () => {})'],
  ["an overflowing uid", 'exec("node", { uid: 2147483648 }, () => {})'],
  ["an underflowing gid", 'fork("worker.js", [], { gid: -2147483649 })'],
  ["a BigInt uid", 'spawn("node", [], { uid: 1n })'],
  ["a NaN gid", 'spawn("node", [], { gid: NaN })'],
  ["a final invalid uid", 'spawn("node", [], { uid: 1, uid: "bad" })'],
  [
    "an invalid uid after a static spread",
    'spawn("node", [], { uid: 1, ...{ uid: "bad" } })',
  ],
  ["a missing command", "spawn()"],
  ["a null command", "spawn(null)"],
  ["an undefined command", "spawn(undefined)"],
  ["a void command", "spawn(void 0)"],
  ["a numeric command", "spawn(5)"],
  ["a negative numeric command", "spawn(-1)"],
  ["a BigInt command", "spawn(0n)"],
  ["a boolean command", "spawn(true)"],
  ["a negated command", "spawn(!command)"],
  ["an object command", 'spawn({ command: "node" })'],
  ["an array command", 'spawn(["node"])'],
  ["a function command", "spawn(() => {})"],
  ["a constructed command", 'spawn(new String("node"))'],
  ["a command holding a NUL byte", 'spawn("no\\0de")'],
  ["an empty spawn command", 'spawn("")'],
  ["an empty template command", "spawn(``)"],
  ["an empty execFile command", 'execFile("", [], () => {})'],
  ["an empty exec command", 'exec("", () => {})'],
  ["a numeric execFile command", "execFile(5, () => {})"],
  ["a numeric exec command", "exec(5, () => {})"],
  ["a numeric fork module", "fork(5)"],
  ["a null fork module", "fork(null)"],
  ["an array fork module", 'fork(["worker.js"])'],
  ["a function fork module", "fork(() => {})"],
  ["a fork module holding a NUL byte", 'fork("wor\\0ker.js")'],
] as const)("emits no spawn for %s", (_name, call) => {
  expect(spawnsFor(call)).toEqual([]);
});

it.each([
  ["a null uid", 'spawn("node", [], { uid: null })', "spawn"],
  ["an undefined gid", 'spawn("node", [], { gid: undefined })', "spawn"],
  ["a negative-zero uid", 'spawn("node", [], { uid: -0 })', "spawn"],
  ["the minimum int32 uid", 'spawn("node", [], { uid: -2147483648 })', "spawn"],
  ["the maximum int32 gid", 'spawn("node", [], { gid: 2147483647 })', "spawn"],
  [
    "a uid changed by an option getter",
    'spawn("node", [], { get x() { this.uid = 1; return 0; }, uid: "bad" })',
    "spawn",
  ],
  [
    "an overwritten invalid uid",
    'spawn("node", [], { uid: "bad", uid: 1 })',
    "spawn",
  ],
  ["an unknown uid", 'spawn("node", [], { uid: input })', "spawn"],
  [
    "an unknown spread after uid",
    'spawn("node", [], { uid: "bad", ...options })',
    "spawn",
  ],
  ["a command name", 'spawn("node")', "spawn"],
  ["a blank command", 'spawn(" ")', "spawn"],
  ["a template command", "spawn(`node`)", "spawn"],
  ["a computed command", "spawn(command)", "spawn"],
  ["a spread command", "spawn(...args)", "spawn"],
  ["an empty fork module", 'fork("")', "fork"],
  [
    "a URL fork module",
    'fork(new URL("./worker.js", import.meta.url))',
    "fork",
  ],
  [
    "a URL-like fork module",
    'fork({ href: "file:///worker.js", protocol: "file:" })',
    "fork",
  ],
  ["an exec command line", 'exec("node --version", () => {})', "exec"],
  ["an execFile command", 'execFile("node", [], () => {})', "execFile"],
] as const)("keeps the spawn for %s", (_name, call, method) => {
  expect(spawnsFor(call)).toEqual([method]);
});

/**
 * Options Node validates while normalizing the spawn, measured on Node 24.22.1.
 * Each member is checked only by the methods that forward it: execFile drops the
 * boolean flags and serialization, and exec replaces a non-string shell.
 */
it.each([
  ["a negative timeout", 'spawn("node", [], { timeout: -1 })'],
  ["a fractional timeout", 'execFile("node", [], { timeout: 1.5 }, () => {})'],
  ["a string timeout", 'exec("node", { timeout: "1" }, () => {})'],
  ["a boolean timeout", 'fork("worker.js", [], { timeout: true })'],
  ["a NaN timeout", 'spawn("node", [], { timeout: NaN })'],
  ["an Infinity timeout", 'spawn("node", [], { timeout: Infinity })'],
  ["an overflowing timeout", 'spawn("node", [], { timeout: 1e400 })'],
  ["a BigInt timeout", 'spawn("node", [], { timeout: 0n })'],
  ["a negative BigInt timeout", 'spawn("node", [], { timeout: -1n })'],
  [
    "a negative overflowing maxBuffer",
    'execFile("node", [], { maxBuffer: -1e400 }, () => {})',
  ],
  ["a timeout after argv is omitted", 'fork("worker.js", { timeout: -1 })'],
  ["a numeric detached flag", 'spawn("node", [], { detached: 1 })'],
  [
    "a string windowsHide flag",
    'fork("worker.js", [], { windowsHide: "true" })',
  ],
  [
    "a numeric windowsVerbatimArguments flag",
    'spawn("node", [], { windowsVerbatimArguments: 1 })',
  ],
  ["a null serialization", 'fork("worker.js", [], { serialization: null })'],
  ["an unknown serialization", 'spawn("node", [], { serialization: "JSON" })'],
  ["a numeric shell", 'spawn("node", [], { shell: 0 })'],
  ["an array shell", 'execFile("node", [], { shell: [] }, () => {})'],
  ["a negative maxBuffer", 'execFile("node", [], { maxBuffer: -1 }, () => {})'],
  ["a NaN maxBuffer", 'exec("node", { maxBuffer: NaN }, () => {})'],
  ["a string maxBuffer", 'exec("node", { maxBuffer: "1" }, () => {})'],
] as const)("emits no spawn for %s", (_name, call) => {
  expect(spawnsFor(call)).toEqual([]);
});

it.each([
  [
    "a detached flag changed by an option getter",
    'spawn("node", [], { get a() { this.detached = true; return 0; }, detached: 1 })',
    "spawn",
  ],
  [
    "stdio changed by an option getter",
    'spawn("node", [], { get a() { this.stdio = "ignore"; return 0; }, stdio: "ipc" })',
    "spawn",
  ],
  [
    "cwd changed by an option getter",
    'spawn("node", [], { get a() { this.cwd = "/"; return 0; }, cwd: 5 })',
    "spawn",
  ],
  ["a zero timeout", 'spawn("node", [], { timeout: 0 })', "spawn"],
  [
    "a large integer timeout",
    'spawn("node", [], { timeout: 2 ** 53 })',
    "spawn",
  ],
  ["a null timeout", 'spawn("node", [], { timeout: null })', "spawn"],
  ["a negative-zero timeout", 'spawn("node", [], { timeout: -0 })', "spawn"],
  ["a computed timeout", 'spawn("node", [], { timeout: args })', "spawn"],
  ["a boolean detached flag", 'spawn("node", [], { detached: true })', "spawn"],
  [
    "a null windowsHide flag",
    'fork("worker.js", [], { windowsHide: null })',
    "fork",
  ],
  [
    "an execFile numeric detached flag",
    'execFile("node", [], { detached: 1 }, () => {})',
    "execFile",
  ],
  [
    "an exec string windowsHide flag",
    'exec("node", { windowsHide: "true" }, () => {})',
    "exec",
  ],
  [
    "an advanced serialization",
    'fork("worker.js", [], { serialization: "advanced" })',
    "fork",
  ],
  [
    "an undefined serialization",
    'spawn("node", [], { serialization: undefined })',
    "spawn",
  ],
  [
    "an execFile null serialization",
    'execFile("node", [], { serialization: null }, () => {})',
    "execFile",
  ],
  ["a string shell", 'spawn("node", [], { shell: "cmd.exe" })', "spawn"],
  ["an empty shell", 'spawn("node", [], { shell: "" })', "spawn"],
  ["an exec numeric shell", 'exec("node", { shell: 0 }, () => {})', "exec"],
  ["a fork numeric shell", 'fork("worker.js", [], { shell: 0 })', "fork"],
  [
    "a fractional maxBuffer",
    'execFile("node", [], { maxBuffer: 1.5 }, () => {})',
    "execFile",
  ],
  [
    "an Infinity maxBuffer",
    'exec("node", { maxBuffer: Infinity }, () => {})',
    "exec",
  ],
  [
    "a spawn negative maxBuffer",
    'spawn("node", [], { maxBuffer: -1 })',
    "spawn",
  ],
] as const)("keeps the spawn for %s", (_name, call, method) => {
  expect(spawnsFor(call)).toEqual([method]);
});
