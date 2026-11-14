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
  ["a fork module holding a NUL byte", 'fork("wor\\0ker.js")'],
] as const)("emits no spawn for %s", (_name, call) => {
  expect(spawnsFor(call)).toEqual([]);
});

it.each([
  ["a command name", 'spawn("node")', "spawn"],
  ["a blank command", 'spawn(" ")', "spawn"],
  ["a template command", "spawn(`node`)", "spawn"],
  ["a computed command", "spawn(command)", "spawn"],
  ["a spread command", "spawn(...args)", "spawn"],
  ["an empty fork module", 'fork("")', "fork"],
  ["an exec command line", 'exec("node --version", () => {})', "exec"],
  ["an execFile command", 'execFile("node", [], () => {})', "execFile"],
] as const)("keeps the spawn for %s", (_name, call, method) => {
  expect(spawnsFor(call)).toEqual([method]);
});
