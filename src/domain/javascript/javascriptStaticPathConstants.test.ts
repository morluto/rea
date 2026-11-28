import { posix } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";
import { JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS } from "./javascriptSemanticPrecision.js";
import { semanticPrecisionControl } from "./javascriptSemanticResourceLimits.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SEMANTIC_EXPRESSION_DEPTH_LIMIT =
  JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS.expression_depth;

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

  it("classifies a constant named like the source file by its value", () => {
    // An ES module has no `__filename`, so this is a plain string constant.
    const analysis = analyze(
      "main.mjs",
      `${MODULE_HEADER}\nconst __filename = "service";\n${consumers("__filename")}`,
    );
    expect(pathFacts(analysis)).toEqual(
      resolved("service", "module-specifier"),
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

describe("file URL path bases", () => {
  // `path.join("file:", __dirname, ...)` prefixes the source directory, so the
  // URL names a path under that directory and not `/preload.js`.
  it.each([
    [
      "inline",
      consumers('fileURLToPath(path.join("file:", __dirname, "preload.js"))'),
    ],
    [
      "through a constant",
      `const PRELOAD = fileURLToPath(path.join("file:", __dirname, "preload.js"));\n${consumers("PRELOAD")}`,
    ],
  ])(
    "keeps a file URL after a source-directory prefix unknown %s",
    (_label, body) => {
      const text = [
        COMMONJS_HEADER,
        'const { fileURLToPath } = require("node:url");',
        body,
      ].join("\n");
      expect(pathFacts(analyze("main.cjs", text))).toEqual(UNKNOWN);
    },
  );
});

describe("source-relative URL constants", () => {
  const inline = pathFacts(
    analyze(
      "main.mjs",
      `${MODULE_HEADER}\n${consumers('fileURLToPath(new URL("./preload.mjs", import.meta.url))')}`,
    ),
  );
  it("resolves the inline URL form", () => {
    expect(inline).toEqual(resolved("./preload.mjs", "filesystem-expression"));
  });
  it.each([
    [
      "a constant",
      'const REL = "./preload.mjs";',
      "fileURLToPath(new URL(REL, import.meta.url))",
    ],
    [
      "a constant alias",
      'const NAME = "./preload.mjs"; const REL = NAME;',
      "fileURLToPath(new URL(REL, import.meta.url))",
    ],
    [
      "a constant path",
      'const REL = "./preload.mjs"; const PRELOAD = fileURLToPath(new URL(REL, import.meta.url));',
      "PRELOAD",
    ],
  ])(
    "resolves %s inside the URL like the literal",
    (_label, declarations, expression) => {
      const text = `${MODULE_HEADER}\n${declarations}\n${consumers(expression)}`;
      expect(pathFacts(analyze("main.mjs", text))).toEqual(inline);
    },
  );
  it.each([
    ["a mutable binding", 'let REL = "./preload.mjs";'],
    ["a joined path", 'const REL = path.join(".", "preload.mjs");'],
    [
      "a source-directory path",
      'const REL = path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.mjs");',
    ],
  ])("keeps %s inside the URL unknown", (_label, declarations) => {
    const text = `${MODULE_HEADER}\n${declarations}\n${consumers("fileURLToPath(new URL(REL, import.meta.url))")}`;
    expect(pathFacts(analyze("main.mjs", text))).toEqual(UNKNOWN);
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
    {
      declarations: "const DIRECTORY = __dirname;",
      expression: 'path.join(DIRECTORY, DIRECTORY, "worker.js")',
    },
    {
      declarations: "const ROOT = __dirname; const DIRECTORY = ROOT;",
      expression: 'path.join(DIRECTORY, ROOT, "worker.js")',
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

describe("constant resolution budget", () => {
  const COMPLETE = {
    status: "complete",
    semantic_resource_limits: [],
    electron_call_paths_limited: false,
  };
  const LIMITED = {
    status: "limited",
    semantic_resource_limits: ["expression-depth"],
    electron_call_paths_limited: false,
    controls: [semanticPrecisionControl("expression_depth")],
  };
  const alias = (previous: string) => previous;
  /** `length` constants after `c0`, each defined only by the one before it. */
  const chain = (length: number, link: (previous: string) => string) => [
    'const c0 = "./preload.js";',
    ...Array.from(
      { length },
      (_, index) =>
        `const c${String(index + 1)} = ${link(`c${String(index)}`)};`,
    ),
  ];
  const analyzeChain = (length: number, link = alias) =>
    analyze(
      "main.cjs",
      [
        COMMONJS_HEADER,
        ...chain(length, link),
        consumers(`c${String(length)}`),
      ].join("\n"),
    );

  it("resolves the longest alias chain that fits the budget", () => {
    // `c0` to `c(limit - 1)` are as many constants as one expression may read.
    const analysis = analyzeChain(SEMANTIC_EXPRESSION_DEPTH_LIMIT - 1);
    expect(pathFacts(analysis)).toEqual(
      resolved("./preload.js", "module-specifier"),
    );
    expect(analysis.analysis_coverage?.examination).toEqual(COMPLETE);
  });

  it("keeps an alias chain past the budget unknown and the analysis partial", () => {
    const analysis = analyzeChain(SEMANTIC_EXPRESSION_DEPTH_LIMIT);
    expect(pathFacts(analysis)).toEqual(UNKNOWN);
    expect(analysis.parse_status).toBe("partial");
    expect(analysis.analysis_coverage?.examination).toEqual(LIMITED);
  });

  it.each([
    {
      aliases: SEMANTIC_EXPRESSION_DEPTH_LIMIT - 1,
      expected: resolved("preload.js", "filesystem-expression"),
    },
    { aliases: SEMANTIC_EXPRESSION_DEPTH_LIMIT, expected: UNKNOWN },
  ])(
    "follows at most the budget of aliases to prove a source file: $aliases",
    ({ aliases, expected }) => {
      const analysis = analyze(
        "main.cjs",
        [
          COMMONJS_HEADER,
          "const f0 = __filename;",
          ...Array.from(
            { length: aliases },
            (_, index) => `const f${String(index + 1)} = f${String(index)};`,
          ),
          `const DIRECTORY = path.dirname(f${String(aliases)});`,
          consumers('path.join(DIRECTORY, "preload.js")'),
        ].join("\n"),
      );
      expect(pathFacts(analysis)).toEqual(expected);
    },
  );

  it.each([
    { name: "aliases", length: 4096, link: alias },
    {
      name: "concatenations",
      length: 12_000,
      link: (previous: string) => `${previous} + "a"`,
    },
  ])(
    "keeps $length chained $name unknown and still resolves a later read",
    ({ length, link }) => {
      const analysis = analyze(
        "main.cjs",
        [
          COMMONJS_HEADER,
          ...chain(length, link),
          consumers(`c${String(length)}`),
          'utilityProcess.fork(path.join(__dirname, "later.js"));',
        ].join("\n"),
      );
      const facts = pathFacts(analysis);
      expect(facts.preloads).toEqual(UNKNOWN.preloads);
      expect(facts.utilities).toHaveLength(2);
      expect(facts.utilities).toEqual(
        expect.arrayContaining([
          ...UNKNOWN.utilities,
          { path: "later.js", context: "filesystem-expression" },
        ]),
      );
      expect(analysis.analysis_coverage?.examination).toEqual(LIMITED);
    },
  );
});
