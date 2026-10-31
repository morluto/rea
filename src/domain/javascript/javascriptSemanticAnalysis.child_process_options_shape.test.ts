import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * Node validates the child_process options object before creating anything, so a
 * literal primitive or a literal array in that slot throws
 * ERR_INVALID_ARG_TYPE synchronously and no child process exists. `spawn` also
 * rejects `null` (`undefined` is its only exemption); `fork` and `execFile` skip
 * any nullish options, and `exec` spreads its options and rejects none.
 */
const spawnsFor = (source: string) =>
  analyzeJavaScriptSemantics(
    `import { spawn, exec, execFile, fork } from "node:child_process"; ${source};`,
  ).childProcessSpawns;

it.each([
  ["a string args slot", `spawn("git", "status")`],
  ["a numeric args slot", `spawn("git", 1)`],
  ["a string options slot", `spawn("git", [], "pipe")`],
  ["a null options slot", `spawn("git", [], null)`],
  ["an array options slot", `spawn("git", [], [])`],
  ["a numeric options slot", `spawn("git", [], 5)`],
  ["a string execFile args slot", `execFile("git", "status")`],
  ["a string fork args slot", `fork("worker.js", "status")`],
  ["a string fork options slot", `fork("worker.js", [], "pipe")`],
  ["a BigInt options slot", `spawn("git", [], 0n)`],
  ["a negated-zero options slot", `spawn("git", [], -0)`],
  ["an overflowing numeric options slot", `spawn("git", [], 1e400)`],
  ["a negated numeric options slot", `spawn("git", [], -5)`],
  ["a BigInt args slot", `spawn("git", 0n)`],
] as const)("emits no child-process fact for %s", (_name, call) => {
  expect(spawnsFor(call)).toEqual([]);
});

it.each([
  ["an object options slot", `spawn("tool", [], { stdio: "pipe" })`],
  ["an omitted options slot", `spawn("tool", [], undefined)`],
  ["options in the second slot", `spawn("tool", { stdio: "pipe" })`],
  ["an unresolved options value", `spawn("tool", [], options)`],
  // `void <expr>` evaluates to undefined, the one value Node accepts here.
  ["a void options slot", `spawn("tool", [], void 0)`],
  ["a void expression with an operand", `spawn("tool", [], void 5)`],
] as const)("keeps the spawn for %s", (_name, call) => {
  expect(spawnsFor(call)).toHaveLength(1);
});

/** fork and execFile skip a nullish options object; exec validates nothing. */
it.each([
  ["fork with null options", `fork("worker.js", [], null)`],
  ["fork with a void options slot", `fork("worker.js", [], void 0)`],
  ["execFile with null options", `execFile("tool", [], null)`],
  ["execFile with a void options slot", `execFile("tool", [], void 0)`],
  ["exec with a string second argument", `exec("tool", "inherit")`],
] as const)("keeps %s", (_name, call) => {
  expect(spawnsFor(call)).toHaveLength(1);
});

/** `!` and `~` yield a primitive whatever their operand, so Node rejects them. */
it.each([
  ["a logical-not options slot", `spawn("tool", [], !0)`],
  ["a bitwise-not options slot", `spawn("tool", [], ~5)`],
  ["a unary-plus options slot", `spawn("tool", [], +5)`],
] as const)("emits no child-process fact for %s", (_name, call) => {
  expect(spawnsFor(call)).toEqual([]);
});
