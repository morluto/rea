import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const spawns = (source: string) =>
  analyzeJavaScriptSemantics(source).childProcessSpawns;

it.each(["spawn", "fork"])("rejects function-valued %s options", (method) => {
  expect(
    spawns(`
    import { ${method} } from "node:child_process";
    ${method}("worker.js", () => {});
    ${method}("worker.js", [], function options() {});
    ${method}("worker.js", [], class Options {});
  `),
  ).toEqual([]);
});

it("rejects a literal exec callback after explicit options", () => {
  expect(
    spawns(`
    import { exec } from "node:child_process";
    exec("node --version", {}, false);
    exec("node --version", null, {});
  `),
  ).toEqual([]);
});

it("selects execFile callbacks with and without an argv array", () => {
  expect(
    spawns(`
    import { execFile } from "node:child_process";
    execFile("node", {}, { cwd: "." });
    execFile("node", [], {}, false);
    execFile("node", null, {}, "callback");
  `),
  ).toEqual([]);
});

it("keeps callback overloads and nullish callbacks", () => {
  expect(
    spawns(`
    import { exec, execFile } from "node:child_process";
    exec("node --version", () => {}, false);
    exec("node --version", {}, null);
    execFile("node", () => {}, { cwd: false });
    execFile("node", [], () => {}, false);
    execFile("node", {}, null);
    execFile("node", [], {}, undefined);
  `),
  ).toHaveLength(6);
});

it("leaves uncertain callback slots and spread positions undecided", () => {
  expect(
    spawns(`
    import { exec, execFile, spawn } from "node:child_process";
    function run(options, callback, args) {
      exec("node --version", options, false);
      exec("node --version", {}, callback);
      execFile("node", options, false);
      execFile("node", [], options, false);
      execFile("node", ...args, {}, false);
      spawn("node", ...args, () => {});
    }
  `),
  ).toHaveLength(6);
});
