import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { analyzeCommonJsSemanticFixture } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";

const source = `const {spawn} = require('child_process');
const timers = require('timers');
const child = spawn('tool', []); child.kill();
const timer = timers.setTimeout(() => {}, 1); timers.clearTimeout(timer);`;

it("retains conditional child and timer observations without proving a loader", () => {
  const result = analyzeJavaScriptSemantics(source);
  expect(result.childProcessSpawns).toMatchObject([
    { command: "tool", builtinAuthority: "candidate" },
  ]);
  expect(result.childProcessInteractions).toMatchObject([
    { kind: "signal", builtinAuthority: "candidate", resolution: "partial" },
  ]);
  expect(result.timerOperations).toMatchObject([
    { kind: "schedule", builtinAuthority: "candidate" },
    { kind: "cancel", builtinAuthority: "candidate" },
  ]);
  const proven = analyzeCommonJsSemanticFixture(source);
  expect(proven.childProcessSpawns[0]).not.toHaveProperty("builtinAuthority");
  expect(proven.timerOperations[0]).not.toHaveProperty("builtinAuthority");
});

it("does not treat shadowed or overwritten bindings as candidate builtins", () => {
  const result = analyzeJavaScriptSemantics(`
    const cp = require('child_process'); cp.spawn = custom; cp.spawn('bad', []);
    function local(require) { require('timers').setTimeout(() => {}, 1); }
  `);
  expect(result.childProcessSpawns).toEqual([]);
  expect(result.timerOperations).toEqual([]);
});

it("does not promote a builtin binding read before initialization", () => {
  const result = analyzeJavaScriptSemantics(`
    spawn('early', []);
    var { spawn } = require('child_process');
    spawn('late', []);
  `);
  expect(result.childProcessSpawns).toMatchObject([
    { command: "late", builtinAuthority: "candidate" },
  ]);
  expect(result.childProcessSpawns).toHaveLength(1);
});

it("tracks conditional builtin slot writes without discarding unrelated or previously captured methods", () => {
  const result = analyzeJavaScriptSemantics(`
    const saved = require('child_process').spawn;
    require('child_process').exec = custom;
    require('child_process').spawn('unrelated', []);
    require('child_process').spawn = custom;
    require('child_process').spawn('replaced', []);
    saved('captured', []);
  `);
  expect(
    result.childProcessSpawns.map(({ command, builtinAuthority }) => ({
      command,
      builtinAuthority,
    })),
  ).toEqual([
    { command: "unrelated", builtinAuthority: "candidate" },
    { command: "captured", builtinAuthority: "candidate" },
  ]);
});

it("retains a global process read conditionally when a candidate module may have changed it", () => {
  const result = analyzeJavaScriptSemantics(`
    require('process').env.MODE = custom;
    const mode = process.env.MODE;
  `);
  expect(result.configurationOperations).toMatchObject([
    { key: "MODE", builtinAuthority: "candidate" },
  ]);
});

it("does not turn a proven same-slot replacement into a conditional global process read", () => {
  const result = analyzeJavaScriptSemantics(`
    process.env.MODE = custom;
    const mode = process.env.MODE;
  `);
  expect(result.configurationOperations).toEqual([]);
});

it("weakens default-import builtin effects after a conditional same-slot write", () => {
  const result = analyzeJavaScriptSemantics(`
    import fs from 'fs';
    require('fs').readFileSync = custom;
    fs.readFileSync('config.json');
  `);
  expect(result.configurationOperations).toMatchObject([
    { key: "config.json", builtinAuthority: "candidate" },
  ]);
});

it("keeps named builtin snapshots proven while weakening mutable default namespaces", () => {
  const result = analyzeJavaScriptSemantics(`
    import {readFileSync} from 'fs';
    import http from 'http'; import timers from 'timers'; import cp from 'child_process';
    require('fs').readFileSync = custom;
    require('http').get = custom;
    require('timers').setTimeout = custom;
    require('child_process').spawn = custom;
    readFileSync('named.json'); http.get('http://example.test');
    timers.setTimeout(() => {}, 1); cp.spawn('tool', []);
  `);
  expect(result.configurationOperations).toMatchObject([{ key: "named.json" }]);
  expect(result.configurationOperations[0]).not.toHaveProperty(
    "builtinAuthority",
  );
  expect(result.requestOperations).toMatchObject([
    { builtinAuthority: "candidate" },
  ]);
  expect(result.timerOperations).toMatchObject([
    { builtinAuthority: "candidate" },
  ]);
  expect(result.childProcessSpawns).toMatchObject([
    { builtinAuthority: "candidate" },
  ]);
});

it("keeps namespace snapshot methods proven while marking the mutable default object conditional", () => {
  const result = analyzeJavaScriptSemantics(`
    import * as fs from 'fs';
    require('fs').readFileSync = custom;
    fs.readFileSync('snapshot.json');
    fs.default.readFileSync('mutable.json');
  `);
  const snapshot = result.configurationOperations.find(
    ({ key }) => key === "snapshot.json",
  );
  const mutable = result.configurationOperations.find(
    ({ key }) => key === "mutable.json",
  );
  expect(snapshot).toBeDefined();
  expect(snapshot).not.toHaveProperty("builtinAuthority");
  expect(mutable).toMatchObject({ builtinAuthority: "candidate" });
});

it("preserves namespace process env snapshot across object replacement, but not nested mutation", () => {
  const replaced = analyzeJavaScriptSemantics(`
    import * as p from 'process'; require('process').env = custom; p.env.MODE;
  `).configurationOperations.find(({ key }) => key === "MODE");
  expect(replaced).toBeDefined();
  expect(replaced).not.toHaveProperty("builtinAuthority");
  const mutated = analyzeJavaScriptSemantics(`
    import * as p from 'process'; require('process').env.MODE = custom; p.env.MODE;
  `).configurationOperations.find(({ key }) => key === "MODE");
  expect(mutated).toMatchObject({ builtinAuthority: "candidate" });
});

it("distinguishes proven namespace object replacement from proven slot mutation", () => {
  const replaced = analyzeJavaScriptSemantics(`
    import * as p from 'process'; process.env = custom; p.env.MODE;
  `).configurationOperations.find(({ key }) => key === "MODE");
  expect(replaced).toBeDefined();
  expect(replaced).not.toHaveProperty("builtinAuthority");
  const mutated = analyzeJavaScriptSemantics(`
    import * as p from 'process'; process.env.MODE = custom; p.env.MODE;
  `).configurationOperations.find(({ key }) => key === "MODE");
  expect(mutated).toBeUndefined();
});

it("keeps function fingerprints partial when built-in effects depend on an unknown loader", () => {
  const source = `const { spawn } = require('child_process'); function execute() { spawn('tool', []); } function unrelated() { return 1; }`;
  const candidate = analyzeJavaScriptSemantics(source);
  const proven = analyzeCommonJsSemanticFixture(source);
  const fingerprint = (result: typeof candidate, name: string) => {
    const callable = result.callables.find((item) => item.name === name);
    return result.functionFingerprints.find(
      (item) => item.callableId === callable?.callableId,
    );
  };
  expect(fingerprint(candidate, "execute")).toMatchObject({
    status: "partial",
    components: { effects: ["child-process"] },
  });
  expect(fingerprint(candidate, "execute")?.limitations.length).toBeGreaterThan(
    1,
  );
  expect(fingerprint(candidate, "unrelated")?.status).toBe("complete");
  expect(fingerprint(proven, "execute")?.status).toBe("complete");
});

it("marks an ESM fingerprint partial only when a conditional write affects its builtin effect", () => {
  const sample = (write: string) =>
    analyzeJavaScriptSemantics(`
    import http from 'http';
    ${write}
    function request() { http.get('http://example.test'); }
  `).functionFingerprints[0];
  expect(sample("")?.status).toBe("complete");
  const conditional = sample("require('http').get = custom;");
  expect(conditional).toMatchObject({
    status: "partial",
    components: { effects: ["network"] },
  });
  expect(conditional?.limitations.length).toBeGreaterThan(1);
});
