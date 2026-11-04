import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves hoisted Electron initialization uncertainty through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-electron-initialization-");
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({ main: "early.cjs" }),
      "early.cjs": `
        const { BrowserWindow } = require("electron");
        createWindow();
        const webPreferences = { nodeIntegration: true };
        function createWindow() {
          return new BrowserWindow({ webPreferences });
        }
        require("./late.cjs");
        require("./early-loop.cjs");
        require("./late-loop.cjs");
        throw new Error("must not execute source");
      `,
      "late.cjs": `
        const { BrowserWindow } = require("electron");
        function createWindow() {
          return new BrowserWindow({ webPreferences });
        }
        const webPreferences = { nodeIntegration: true };
        createWindow();
        throw new Error("must not execute source");
      `,
      "early-loop.cjs": `
        const { BrowserWindow } = require("electron");
        createWindow();
        const webPreferences = { nodeIntegration: true };
        function createWindow() {
          for (const item of [0]) return new BrowserWindow({ webPreferences });
        }
        throw new Error("must not execute source");
      `,
      "late-loop.cjs": `
        const { BrowserWindow } = require("electron");
        const webPreferences = { nodeIntegration: true };
        function createWindow() {
          for (const item of [0]) return new BrowserWindow({ webPreferences });
        }
        createWindow();
        throw new Error("must not execute source");
      `,
    });
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(result.statistics.parse_failures).toBe(0);
    const windows = result.graph.nodes.filter(
      ({ kind }) => kind === "browser-window",
    );
    expect(windows).toHaveLength(4);
    const observations = windows.flatMap(({ observations }) => observations);
    const inSource = (source: string) =>
      observations.filter(
        ({ evidence }) =>
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === source,
      );
    for (const source of ["early.cjs", "early-loop.cjs"]) {
      expect(inSource(source)).toHaveLength(1);
      expect(inSource(source)[0]?.properties).toMatchObject({
        web_preferences_status: "dynamic",
        web_preferences: [],
      });
    }
    for (const source of ["late.cjs", "late-loop.cjs"]) {
      expect(inSource(source)).toHaveLength(1);
      expect(inSource(source)[0]?.properties).toMatchObject({
        web_preferences_status: "object-literal",
        web_preferences: [
          {
            name: "nodeIntegration",
            value: { status: "literal", value: true },
          },
        ],
      });
    }
  },
);

cliTest.for([
  ["CLI", false],
  ["stdio MCP", false],
  ["CLI", true],
  ["stdio MCP", true],
  ["CLI", "cached-eval"],
  ["stdio MCP", "cached-eval"],
  ["CLI", "constructed-function"],
  ["stdio MCP", "constructed-function"],
  ["CLI", "erased-type"],
  ["stdio MCP", "erased-type"],
  ["CLI", "module-eval"],
  ["stdio MCP", "module-eval"],
  ["CLI", "bound-constructor"],
  ["stdio MCP", "bound-constructor"],
  ["CLI", "reflect-constructor"],
  ["stdio MCP", "reflect-constructor"],
  ["CLI", "prototype-effect"],
  ["stdio MCP", "prototype-effect"],
  ["CLI", "assign-effect"],
  ["stdio MCP", "assign-effect"],
  ["CLI", "this-constructor"],
  ["stdio MCP", "this-constructor"],
  ["CLI", "alias-prototype"],
  ["stdio MCP", "alias-prototype"],
  ["CLI", "alias-assign"],
  ["stdio MCP", "alias-assign"],
  ["CLI", "assignment-pattern"],
  ["stdio MCP", "assignment-pattern"],
  ["CLI", "iteration-pattern"],
  ["stdio MCP", "iteration-pattern"],
  ["CLI", "reflect-read"],
  ["stdio MCP", "reflect-read"],
  ["CLI", "catch-read"],
  ["stdio MCP", "catch-read"],
  ["CLI", "heritage"],
  ["stdio MCP", "heritage"],
  ["CLI", "computed-key"],
  ["stdio MCP", "computed-key"],
  ["CLI", "tagged-function"],
  ["stdio MCP", "tagged-function"],
  ["CLI", "array-prototype"],
  ["stdio MCP", "array-prototype"],
] as const)(
  "preserves classic global initialization uncertainty through %s (%s)",
  async ([surface, alias], { cli }) => {
    const root = await createTestTempDirectory(
      "rea-electron-global-initialization-",
    );
    const activation =
      alias === "reflect-read"
        ? "Reflect.get(globalThis, 'createWindow')();"
        : alias === "catch-read"
          ? "try { throw globalThis; } catch ({createWindow:start}) { start(); }"
          : alias === "heritage"
            ? "class C extends (this.Function('createWindow()')(), Object) {}"
            : alias === "computed-key"
              ? "({ [this.eval('createWindow()')]() {} });"
              : alias === "tagged-function"
                ? "Function`createWindow()`();"
                : alias === "array-prototype"
                  ? "Object.setPrototypeOf(Array.prototype, globalThis); [].createWindow();"
                  : alias === "this-constructor"
                    ? "this['Function']('createWindow()')();"
                    : alias === "alias-prototype"
                      ? "const changed = {}; const indirect = changed; Object.setPrototypeOf(changed, globalThis); indirect.createWindow();"
                      : alias === "alias-assign"
                        ? "const changed = {}; const indirect = changed; Object.assign(changed, globalThis); indirect.createWindow();"
                        : alias === "bound-constructor"
                          ? "const F = Function.bind(null); new F('createWindow()')();"
                          : alias === "reflect-constructor"
                            ? "Reflect.construct(Function, ['createWindow()'])();"
                            : alias === "prototype-effect"
                              ? "const changed = {}; Object.setPrototypeOf(changed, globalThis); changed.createWindow();"
                              : alias === "assign-effect"
                                ? "const changed = {}; Object.assign(changed, globalThis); changed.createWindow();"
                                : alias === "assignment-pattern"
                                  ? "let start; ({createWindow:start}=globalThis); start();"
                                  : alias === "iteration-pattern"
                                    ? "for(const {createWindow:start} of [globalThis]) start();"
                                    : alias === "module-eval"
                                      ? "eval('createWindow()');"
                                      : alias === "erased-type"
                                        ? "globalThis.createWindow();"
                                        : alias === "constructed-function"
                                          ? "new Function('createWindow()')();"
                                          : alias === "cached-eval"
                                            ? "const noop = () => {}; function unused() { noop(); } (0, eval)('createWindow()');"
                                            : alias
                                              ? "root.createWindow();"
                                              : "globalThis.createWindow();";
    const source = (early: boolean) => `
      ${alias === "erased-type" ? "import type { T } from './types';" : alias === "module-eval" ? "export {};" : ""}
      ${alias === "module-eval" ? 'import { BrowserWindow } from "electron";' : 'const { BrowserWindow } = require("electron");'}
      ${alias ? "const root = globalThis;" : ""}
      ${alias === "reflect-read" || alias === "catch-read" ? "Object.extra = 1; function unusedArrayRead() { [].createWindow; }" : ""}
      const unrelated = { createWindow() {} };
      function unusedReceiverRead() { unrelated.createWindow; }
      for (const ignored of [1, 2]) { unrelated.createWindow; }
      ${early ? activation : ""}
      const webPreferences = { nodeIntegration: true };
      function createWindow() { return new BrowserWindow({ webPreferences }); }
      ${early || alias === "module-eval" ? "" : activation}
      createWindow();
      throw new Error("must not execute source");
    `;
    const extension =
      alias === "erased-type" ? "ts" : alias === "module-eval" ? "mjs" : "js";
    const earlyName = `early.${extension}`;
    const lateName = `late.${extension}`;
    await writeFixtureFiles(root, {
      [earlyName]: source(true),
      [lateName]: source(false),
      "index.html": `<script src="${earlyName}"></script><script src="${lateName}"></script>`,
    });
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(result.statistics.parse_failures).toBe(0);
    const windows = result.graph.nodes.filter(
      ({ kind }) => kind === "browser-window",
    );
    expect(windows).toHaveLength(2);
    const inSource = (name: string) =>
      windows
        .flatMap(({ observations }) => observations)
        .filter(
          ({ evidence }) =>
            evidence.location.available &&
            evidence.location.value.kind === "source-range" &&
            evidence.location.value.source === name,
        );
    expect(inSource(earlyName)).toHaveLength(1);
    expect(inSource(earlyName)[0]?.properties).toMatchObject({
      web_preferences_status: "dynamic",
      web_preferences: [],
    });
    expect(inSource(lateName)).toHaveLength(1);
    expect(inSource(lateName)[0]?.properties).toMatchObject({
      web_preferences_status: "object-literal",
      web_preferences: [
        { name: "nodeIntegration", value: { status: "literal", value: true } },
      ],
    });
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves aliased prototype, reflected and parameter activation through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory(
      "rea-electron-prototype-parameters-",
    );
    const activations = {
      reflectedApply:
        "const args = [globalThis, 'createWindow']; Reflect.get.apply(Reflect, args)();",
      catchPropagated:
        "function fail() { throw globalThis; } try { fail(); } catch ({ createWindow: start }) { start(); }",
      catchNested:
        "function fail() { throw globalThis; } try { if (true) fail(); } catch ({ createWindow: start }) { start(); }",
      objectPrototype:
        "Object.assign(Object.prototype, globalThis); ({}).createWindow();",
      stringPrototype:
        "Object.setPrototypeOf(String.prototype, globalThis); ''.createWindow();",
      lexicalThisPrototype:
        "Object.setPrototypeOf(this.Array.prototype, globalThis); [].createWindow();",
      reflectedTemplate:
        "globalThis[`Reflect`].get(globalThis, 'createWindow')();",
      reflectedOptional: "Reflect.get?.(globalThis, 'createWindow')();",
      reflectedNamespace:
        "const R = Reflect; R.get(globalThis, 'createWindow')();",
      reflectedMethod:
        "const read = Reflect.get; read(globalThis, 'createWindow')();",
      reflectedBound:
        "const read = Reflect.get.bind(Reflect); read(globalThis, 'createWindow')();",
      array:
        "const receiver = []; const alias = receiver; Object.setPrototypeOf(Array.prototype, globalThis); alias.createWindow();",
      function:
        "const receiver = function(){}; const alias = receiver; Object.setPrototypeOf(Function.prototype, globalThis); alias.createWindow();",
      parameter:
        "function boot({ createWindow: start } = {}) { start(); } boot(globalThis);",
    };
    const files: Record<string, string> = {};
    for (const [kind, activation] of Object.entries(activations)) {
      for (const early of [true, false]) {
        files[`${kind}-${early ? "early" : "late"}.js`] = `
          const { BrowserWindow } = require("electron");
          ${early ? activation : ""}
          const webPreferences = { nodeIntegration: true };
          function createWindow() { return new BrowserWindow({ webPreferences }); }
          ${early ? "" : activation}
          createWindow();
          throw new Error("must not execute source");
        `;
      }
    }
    files["index.html"] = Object.keys(files)
      .map((name) => `<script src="${name}"></script>`)
      .join("");
    await writeFixtureFiles(root, files);
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(result.statistics.parse_failures).toBe(0);
    const windows = result.graph.nodes.filter(
      ({ kind }) => kind === "browser-window",
    );
    expect(windows).toHaveLength(28);
    for (const source of Object.keys(files).filter((name) =>
      name.endsWith(".js"),
    )) {
      const observations = windows
        .flatMap(({ observations }) => observations)
        .filter(
          ({ evidence }) =>
            evidence.location.available &&
            evidence.location.value.kind === "source-range" &&
            evidence.location.value.source === source,
        );
      expect(observations).toHaveLength(1);
      const definite =
        source.endsWith("-late.js") && !source.startsWith("parameter-");
      expect(observations[0]?.properties).toMatchObject(
        definite
          ? {
              web_preferences_status: "object-literal",
              web_preferences: [
                {
                  name: "nodeIntegration",
                  value: { status: "literal", value: true },
                },
              ],
            }
          : { web_preferences_status: "dynamic", web_preferences: [] },
      );
    }
  },
);
