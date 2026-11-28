import { describe, expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

describe("child-process options detection", () => {
  it("detects options without an args array", () => {
    const ir = analyzeJavaScriptSemantics(`
      import { spawn, execFile, fork } from "node:child_process";

      spawn("tool", {
        env: { A: "1" },
        stdio: "pipe"
      });

      execFile("tool", {
        env: { A: "1" }
      });

      fork("worker.js", {
        env: { A: "1" },
        stdio: ["pipe", "pipe", "pipe", "ipc"]
      });
    `);

    expect(
      ir.childProcessSpawns.map(
        ({ method, environmentSupplied, stdioMode, resolution }) => ({
          method,
          environmentSupplied,
          stdioMode,
          resolution,
        }),
      ),
    ).toEqual([
      {
        method: "spawn",
        environmentSupplied: true,
        stdioMode: "pipe",
        resolution: "complete",
      },
      {
        method: "execFile",
        environmentSupplied: true,
        stdioMode: "default",
        resolution: "complete",
      },
      {
        method: "fork",
        environmentSupplied: true,
        stdioMode: "array",
        resolution: "complete",
      },
    ]);
  });

  it("reads fork's silent option when stdio is not a string or array", () => {
    const ir = analyzeJavaScriptSemantics(`
      import { fork, spawn } from "node:child_process";

      fork("piped.js", { silent: true });
      fork("inherited.js", [], { silent: false });
      fork("nullish-stdio.js", { silent: 1, stdio: null });
      fork("explicit-stdio.js", { silent: true, stdio: "inherit" });
      fork("dynamic.js", { silent: process.env.QUIET });
      spawn("tool", { silent: true });
      fork("boolean-stdio.js", { stdio: false, silent: true });
      fork("object-stdio.js", { stdio: {}, silent: false });
      fork("unresolved-stdio.js", { stdio: streams, silent: true });
      spawn("tool", { stdio: false });
    `);

    expect(ir.childProcessSpawns.map(({ stdioMode }) => stdioMode)).toEqual([
      "pipe",
      "default",
      "pipe",
      "inherit",
      "dynamic",
      "default",
      "pipe",
      "default",
      "dynamic",
      "dynamic",
    ]);
  });

  it("preserves behavior with explicit args arrays", () => {
    const ir = analyzeJavaScriptSemantics(`
      import { spawn, execFile, fork } from "node:child_process";

      spawn("tool", [], { env: { A: "1" }, stdio: "pipe" });
      execFile("tool", [], { env: { A: "1" } });
      fork("worker.js", [], {
        env: { A: "1" },
        stdio: ["pipe", "pipe", "pipe", "ipc"]
      });
    `);

    expect(
      ir.childProcessSpawns.map(({ environmentSupplied, stdioMode }) => ({
        environmentSupplied,
        stdioMode,
      })),
    ).toEqual([
      { environmentSupplied: true, stdioMode: "pipe" },
      { environmentSupplied: true, stdioMode: "default" },
      { environmentSupplied: true, stdioMode: "array" },
    ]);
  });

  it("does not invent options when omitted", () => {
    const ir = analyzeJavaScriptSemantics(`
      import { spawn, execFile, fork } from "node:child_process";

      spawn("tool");
      execFile("tool");
      fork("worker.js");
    `);

    expect(
      ir.childProcessSpawns.every(
        ({ environmentSupplied, stdioMode }) =>
          environmentSupplied === false && stdioMode === "default",
      ),
    ).toBe(true);

    expect(ir.childProcessSpawns).toHaveLength(3);
  });

  it("reads env as Node does, where a falsy value inherits the parent environment", () => {
    // Node's normalizeSpawnArguments does `const env = options.env || { ...process.env }`,
    // so a nullish or otherwise falsy env supplies nothing and the child inherits.
    const cases = [
      ["absent", `spawn("tool")`, false],
      ["null", `spawn("tool", [], { env: null })`, false],
      ["undefined", `spawn("tool", [], { env: undefined })`, false],
      ["void", `spawn("tool", [], { env: void 0 })`, false],
      ["zero", `spawn("tool", [], { env: 0 })`, false],
      ["negative-zero", `spawn("tool", [], { env: -0 })`, false],
      ["bigint-zero", `spawn("tool", [], { env: 0n })`, false],
      ["zero-float", `spawn("tool", [], { env: 0.0 })`, false],
      ["nan", `spawn("tool", [], { env: NaN })`, false],
      ["shadowed-nan", `((NaN) => spawn("tool", [], { env: NaN }))({})`, null],
      ["empty-string", `spawn("tool", [], { env: "" })`, false],
      ["false", `spawn("tool", [], { env: false })`, false],
      ["empty-object", `spawn("tool", [], { env: {} })`, true],
      ["with-key", `spawn("tool", [], { env: { A: "1" } })`, true],
      ["inline-spread", `spawn("tool", [], { ...{ env: { A: "1" } } })`, true],
      ["unresolved-value", `spawn("tool", [], { env: input })`, null],
      ["unresolved-options", `spawn("tool", [], input)`, null],
      ["getter", `spawn("tool", [], { get env() { return input } })`, null],
      ["later-spread", `spawn("tool", [], { env: {}, ...input })`, null],
      ["known-last", `spawn("tool", [], { ...input, env: {} })`, true],
      ["known-null-last", `spawn("tool", [], { ...input, env: null })`, false],
    ] as const;

    for (const [label, call, supplied] of cases) {
      const ir = analyzeJavaScriptSemantics(
        `import { spawn } from "node:child_process"; ${call};`,
      );
      expect(ir.childProcessSpawns[0]?.environmentSupplied, label).toBe(
        supplied,
      );
    }
  });
});

it.each([
  ["intrinsic", 'spawn("tool", [], { env: new Object() })', true],
  [
    "shadowed",
    'function f(Object) { spawn("tool", [], { env: new Object() }) }',
    null,
  ],
  [
    "overwritten",
    'globalThis.Object = replacement; spawn("tool", [], { env: new Object() })',
    null,
  ],
  [
    "opaque write",
    'eval("Object = replacement"); spawn("tool", [], { env: new Object() })',
    null,
  ],
  ["argument", 'spawn("tool", [], { env: new Object(input) })', null],
  ["custom", 'spawn("tool", [], { env: new Custom() })', null],
] as const)(
  "qualifies constructor environment: %s",
  (_label, code, expected) => {
    const ir = analyzeJavaScriptSemantics(
      `import { spawn } from "node:child_process"; ${code};`,
    );
    expect(ir.childProcessSpawns[0]?.environmentSupplied).toBe(expected);
  },
);

it.each([
  ["exec callback", 'const cb = () => {}; exec("tool", cb)', false],
  [
    "exec alias callback",
    'const original = () => {}; const cb = original; exec("tool", cb)',
    false,
  ],
  [
    "exec callback with property",
    'const cb = () => {}; cb.env = {}; exec("tool", cb)',
    false,
  ],
  [
    "exec later spread",
    'const cb = () => {}; exec("tool", cb, ...args)',
    false,
  ],
  ["execFile callback", 'function cb() {} execFile("tool", cb)', false],
  [
    "execFile callback with property",
    'function cb() {} cb.env = {}; execFile("tool", cb)',
    false,
  ],
  [
    "execFile later spread",
    'function cb() {} execFile("tool", cb, ...args)',
    false,
  ],
  [
    "execFile third-slot callback",
    'function cb() {} cb.env = {}; execFile("tool", [], cb)',
    null,
  ],
  [
    "reassigned callback",
    'let cb = () => {}; cb = input; exec("tool", cb)',
    null,
  ],
  [
    "opaque callback write",
    'function f() { let cb = () => {}; eval("cb = input"); exec("tool", cb) }',
    null,
  ],
  ["unknown callback", 'function f(cb) { exec("tool", cb) }', null],
  ["spread before callback", "function cb() {} exec(...args, cb)", null],
] as const)(
  "qualifies callback overload environment: %s",
  (_label, code, expected) => {
    const ir = analyzeJavaScriptSemantics(
      `import { exec, execFile } from "node:child_process"; ${code};`,
    );
    expect(ir.childProcessSpawns[0]?.environmentSupplied).toBe(expected);
  },
);
