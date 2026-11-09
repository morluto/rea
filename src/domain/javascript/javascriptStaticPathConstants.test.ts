import { posix } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const COMMONJS_HEADER = [
  'const path = require("node:path");',
  'const { BrowserWindow, utilityProcess } = require("electron");',
].join("\n");
const MODULE_HEADER = [
  'import path from "node:path";',
  'import { fileURLToPath } from "node:url";',
  'import { BrowserWindow, utilityProcess } from "electron";',
].join("\n");

const analyze = (filename: string, source: string) => {
  const parsed = parseJavaScriptSource(source, filename);
  if (parsed === null) throw new Error(`${filename} could not be parsed`);
  return analyzeParsedJavaScriptStaticSource(source, parsed);
};

const consumers = (expression: string) =>
  [
    `new BrowserWindow({ webPreferences: { preload: ${expression} } });`,
    `utilityProcess.fork(${expression});`,
  ].join("\n");

/** Preload and utility-process paths, which share one path owner. */
const pathFacts = (analysis: ReturnType<typeof analyze>) => ({
  preloads: analysis.electron.browser_windows.map(
    ({ preload_path, preload_resolution_context }) => ({
      path: preload_path,
      context: preload_resolution_context,
    }),
  ),
  utilities: analysis.electron.utility_processes.map(
    ({ module_path, module_resolution_context }) => ({
      path: module_path,
      context: module_resolution_context,
    }),
  ),
});

const resolved = (path: string, context: string) => ({
  preloads: [{ path, context }],
  utilities: [{ path, context }],
});
const UNKNOWN = {
  preloads: [{ path: null, context: null }],
  utilities: [{ path: null, context: null }],
};

/** Inert Electron and path modules for checking initialization order. */
const runtime = () => ({
  __dirname: "/app",
  require: (specifier: string) =>
    specifier === "electron"
      ? { BrowserWindow: class {}, utilityProcess: { fork: () => undefined } }
      : posix,
});

describe("constant path bindings", () => {
  it.each([
    {
      name: "a joined source path",
      declarations: 'const PRELOAD = path.join(__dirname, "preload.js");',
      expression: "PRELOAD",
      path: "preload.js",
      context: "filesystem-expression",
    },
    {
      name: "a literal specifier",
      declarations: 'const PRELOAD = "./preload.js";',
      expression: "PRELOAD",
      path: "./preload.js",
      context: "module-specifier",
    },
    {
      name: "a constant alias",
      declarations:
        'const FIRST = path.resolve(__dirname, "preload.js"); const PRELOAD = FIRST;',
      expression: "PRELOAD",
      path: "preload.js",
      context: "filesystem-expression",
    },
    {
      name: "nested directory constants",
      declarations:
        'const ROOT = path.join(__dirname, ".."); const DIST = path.join(ROOT, "dist");',
      expression: 'path.join(DIST, "preload.js")',
      path: "../dist/preload.js",
      context: "filesystem-expression",
    },
    {
      name: "a constant file name",
      declarations: 'const NAME = "preload.js";',
      expression: "path.join(__dirname, NAME)",
      path: "preload.js",
      context: "filesystem-expression",
    },
    {
      name: "a source directory alias",
      declarations: "const DIRECTORY = __dirname;",
      expression: 'DIRECTORY + "/preload.js"',
      path: "preload.js",
      context: "filesystem-expression",
    },
    {
      name: "a source file alias",
      declarations: "const FILE = __filename;",
      expression: 'path.join(path.dirname(FILE), "preload.js")',
      path: "preload.js",
      context: "filesystem-expression",
    },
  ])(
    "resolves $name like the inline path",
    ({ declarations, expression, path, context }) => {
      const analysis = analyze(
        "main.cjs",
        `${COMMONJS_HEADER}\n${declarations}\n${consumers(expression)}`,
      );
      expect(pathFacts(analysis)).toEqual(resolved(path, context));
    },
  );

  it.each([
    "const __dirname = path.dirname(fileURLToPath(import.meta.url));",
    "const __filename = fileURLToPath(import.meta.url); const __dirname = path.dirname(__filename);",
  ])("anchors module paths at a constant module directory: %s", (body) => {
    const analysis = analyze(
      "main.mjs",
      `${MODULE_HEADER}\n${body}\n${consumers('path.join(__dirname, "preload.mjs")')}`,
    );
    expect(pathFacts(analysis)).toEqual(
      resolved("preload.mjs", "filesystem-expression"),
    );
  });

  it("resolves constant renderer files and utility-process service names", () => {
    const analysis = analyze(
      "main.cjs",
      [
        COMMONJS_HEADER,
        'const PAGE = path.join(__dirname, "index.html");',
        'const SERVICE = path.join(__dirname, "service.js");',
        'const NAME = "Example service";',
        "new BrowserWindow().loadFile(PAGE);",
        "utilityProcess.fork(SERVICE, [], { serviceName: NAME });",
      ].join("\n"),
    );
    expect(analysis.role_paths).toEqual([
      expect.objectContaining({
        role: "renderer",
        path: "index.html",
        path_base: "source-directory",
        resolution_context: "filesystem-expression",
      }),
    ]);
    expect(analysis.electron.utility_processes).toEqual([
      expect.objectContaining({
        module_path: "service.js",
        module_resolution_context: "filesystem-expression",
        service_name: "Example service",
      }),
    ]);
  });
});

describe("constant path ownership and initialization", () => {
  it.each([
    { declarations: 'let PRELOAD = path.join(__dirname, "preload.js");' },
    { declarations: 'var PRELOAD = path.join(__dirname, "preload.js");' },
    {
      declarations:
        'const PRELOAD = path.join(__dirname, "preload.js"); PRELOAD = "./other.js";',
    },
    {
      declarations:
        'const { PRELOAD } = { PRELOAD: path.join(__dirname, "preload.js") };',
    },
    {
      declarations:
        'const PRELOAD = runtimeFlag ? "./first.js" : "./second.js";',
    },
    {
      declarations:
        'const PRELOAD = path.join(__dirname, "preload.js"); { const PRELOAD = runtimePath;',
      after: "}",
    },
    {
      declarations:
        'const PRELOAD = path.join(__dirname, "preload.js"); function open(PRELOAD) {',
      after: "} open(runtimePath);",
    },
  ])(
    "keeps a binding that is not one definite constant unknown: $declarations",
    ({ declarations, after = "" }) => {
      const analysis = analyze(
        "main.cjs",
        `${COMMONJS_HEADER}\n${declarations}\n${consumers("PRELOAD")}\n${after}`,
      );
      expect(pathFacts(analysis)).toEqual(UNKNOWN);
    },
  );

  it.each([
    {
      label: "a read before the declaration",
      source: [
        COMMONJS_HEADER,
        consumers("PRELOAD"),
        'const PRELOAD = path.join(__dirname, "preload.js");',
      ],
    },
    {
      label: "a hoisted function called before initialization",
      source: [
        COMMONJS_HEADER,
        `function open() {\n${consumers("PRELOAD")}\n}`,
        "open();",
        'const PRELOAD = path.join(__dirname, "preload.js");',
      ],
    },
  ])("keeps $label unknown", ({ source }) => {
    const text = source.join("\n");
    expect(() => runInNewContext(text, runtime())).toThrow(
      /before initialization/,
    );
    expect(pathFacts(analyze("main.cjs", text))).toEqual(UNKNOWN);
  });

  it("resolves a module constant read by a function called after initialization", () => {
    const text = [
      COMMONJS_HEADER,
      `function open() {\n${consumers("PRELOAD")}\n}`,
      'const PRELOAD = path.join(__dirname, "preload.js");',
      "open();",
    ].join("\n");
    expect(() => runInNewContext(text, runtime())).not.toThrow();
    expect(pathFacts(analyze("main.cjs", text))).toEqual(
      resolved("preload.js", "filesystem-expression"),
    );
  });

  it.each([
    {
      label: "an exported function another module can call first",
      body: `export function open() {\n${consumers("PRELOAD")}\n}\nconst PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.mjs");`,
    },
    {
      label: "a URL object, which can change after construction",
      body: `const PRELOAD_URL = new URL("./preload.mjs", import.meta.url);\n${consumers("fileURLToPath(PRELOAD_URL)")}`,
    },
  ])("keeps $label unknown", ({ body }) => {
    expect(pathFacts(analyze("main.mjs", `${MODULE_HEADER}\n${body}`))).toEqual(
      UNKNOWN,
    );
  });
});

describe("constant substitution bound", () => {
  it.each([
    {
      declarations: 'const ONCE = "./once"; const TWICE = ONCE + ONCE;',
      expression: "TWICE",
    },
    {
      declarations: 'const PART = "part";',
      expression: "path.join(__dirname, PART, PART)",
    },
  ])(
    "reads each constant at most once per expression: $expression",
    ({ declarations, expression }) => {
      const analysis = analyze(
        "main.cjs",
        `${COMMONJS_HEADER}\n${declarations}\n${consumers(expression)}`,
      );
      expect(pathFacts(analysis)).toEqual(UNKNOWN);
    },
  );

  it("does not expand a doubling constant chain beyond the source", () => {
    const declarations = [
      'const level0 = "x";',
      ...Array.from(
        { length: 64 },
        (_, index) =>
          `const level${String(index + 1)} = level${String(index)} + level${String(index)};`,
      ),
    ];
    const analysis = analyze(
      "main.cjs",
      `${COMMONJS_HEADER}\n${declarations.join("\n")}\n${consumers("level64")}`,
    );
    expect(pathFacts(analysis)).toEqual(UNKNOWN);
  });
});
