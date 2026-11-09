import { expect, it } from "vitest";
import {
  isJsonModuleTarget,
  isNativeAddonModuleTarget,
  moduleResolutionModeForJavaScriptReference,
} from "./javascriptModuleResolutionMode.js";
import * as t from "@babel/types";

import {
  analyzeParsedJavaScriptSemantics,
  indexJavaScriptBindingsWithReceiversSteps,
} from "./javascriptSemanticAnalysis.js";
import {
  semanticRequireLoaderAt,
  semanticRequireOrigin,
} from "./javascriptSemanticRequireOrigin.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";
import { referenceSourceRequireCalls } from "../referenceSourceRequireBindings.js";

import {
  javaScriptRuntimeContext,
  parseRecoveredJavaScript,
  parserPluginsForPath,
} from "./javascriptSourceParser.js";

it("does not treat suffix-only dotfiles as JSON or native addon loaders", () => {
  expect(isJsonModuleTarget(".json", "json")).toBe(false);
  expect(isNativeAddonModuleTarget(".node", "native-addon")).toBe(false);
  expect(isJsonModuleTarget("value.json", "json")).toBe(true);
  expect(isNativeAddonModuleTarget("value.node", "native-addon")).toBe(true);
});

it.each([
  ["entry.cjs", "require"],
  ["entry.cts", "require"],
  ["entry.CJS", "import"],
  ["entry.CTS", "import"],
  ["entry.TS", "compiler-dependent"],
] as const)(
  "uses exact loader evidence for static imports from %s",
  (path, expected) => {
    expect(
      moduleResolutionModeForJavaScriptReference(path, "static-import"),
    ).toBe(expected);
  },
);

it.each([
  [".js", "module", "unknown"],
  [".ts", "commonjs", "unknown"],
  [".mjs", "commonjs", "unknown"],
  [".cjs", "module", "unknown"],
  ["entry.cjs", "module", "commonjs"],
  ["entry.cts", "module", "commonjs"],
  ["entry.mjs", "commonjs", "module"],
  ["entry.mts", "commonjs", "module"],
  ["entry.MJS", "commonjs", "unknown"],
  ["entry.CJS", "module", "unknown"],
  ["entry.MTS", "commonjs", "unknown"],
  ["entry.CTS", "module", "unknown"],
  ["entry.d.cts", "module", "unknown"],
  ["entry.D.cts", "module", "unknown"],
  ["entry.d.ts", "commonjs", "unknown"],
  ["entry.d.mts", "commonjs", "module"],
  ["entry.jsx", "commonjs", "unknown"],
  ["entry.tsx", "commonjs", "unknown"],
  ["entry.js", "module", "module"],
  ["entry.ts", "commonjs", "commonjs"],
  ["entry.JS", "module", "unknown"],
  ["entry.JS", "commonjs", "unknown"],
  ["entry.JS", "unspecified", "unknown"],
  ["entry.TS", "module", "unknown"],
  ["entry.TS", "commonjs", "unknown"],
  ["entry.js", "unspecified", "commonjs"],
  ["entry.ts", "unspecified", "unknown"],
  ["entry.js", "unknown", "unknown"],
  // Node dispatches on the exact suffix, so a case-folded `.MJS`/`.CJS` does
  // not select the lowercase suffix's loader mode; without another loader
  // observation the context stays unknown.
  ["entry.MJS", "module", "unknown"],
  ["entry.MJS", "commonjs", "unknown"],
  ["entry.CJS", "module", "unknown"],
  ["entry.MTS", "commonjs", "unknown"],
  ["entry.D.CTS", "commonjs", "unknown"],
] as const)(
  "preserves parser-owned %s context over an observed %s package type",
  (path, observed, expected) => {
    const parsed = parseRecoveredJavaScript(
      "",
      path,
      {
        plugins: parserPluginsForPath(path),
      },
      observed,
    );
    expect(parsed.file.errors).toEqual([]);
    expect(parsed.moduleOnlyErrors).toEqual([]);
    expect(javaScriptRuntimeContext(parsed.file.program)).toBe(expected);
  },
);

it("does not derive factory authority from an ambient require in a proven module", () => {
  const source = [
    'const { createRequire } = require("node:module");',
    'const load = createRequire(import.meta.url); load("./dep.cjs");',
  ].join("\n");
  const { file } = parseRecoveredJavaScript(source, "entry.js", {}, "module");
  expect(file.errors).toEqual([]);
  expect(analyzeParsedJavaScriptSemantics(file).moduleLinks).toEqual([]);
  expect([...referenceSourceRequireCalls(file, "entry.js")]).toEqual([]);
});

it.each([
  "entry.JS",
  "entry.MJS",
  "entry.CJS",
  "entry.TS",
  "entry.MTS",
  "entry.CTS",
  ".MJS",
])("retains unknown host authority for mixed module syntax in %s", (path) => {
  const { file } = parseRecoveredJavaScript(
    'import {join} from "node:path"; require("./dep.cjs");',
    path,
    { plugins: parserPluginsForPath(path) },
    "module",
  );
  expect(javaScriptRuntimeContext(file.program)).toBe("unknown");
  expect(analyzeParsedJavaScriptSemantics(file).moduleLinks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "import", specifier: "node:path" }),
      expect.objectContaining({
        kind: "require",
        specifier: "./dep.cjs",
        loaderAuthority: "candidate",
      }),
    ]),
  );
});

it.each([
  ["without source redeclarations", "", "", true],
  ["with a var redeclaration", "var require;\n", "", true],
  ["after a prior write", "require = custom;\n", "", false],
  ["before a later write", "", "\nrequire = custom;", true],
  ["behind a lexical declaration", "const require = custom;\n", "", false],
  ["behind a nested parameter", "function shadow(require) {\n", "\n}", false],
] as const)(
  "uses the seeded wrapper fact consistently %s",
  (_name, prefix, suffix, expected) => {
    const source =
      prefix +
      [
        'const { createRequire } = require("node:module");',
        'const load = createRequire(import.meta.url); load("./dep.cjs");',
      ].join("\n") +
      suffix;
    const { file } = parseRecoveredJavaScript(source, "entry.js", {});
    expect(file.errors).toEqual([]);
    expect(file.program.sourceType).toBe("module");
    expect(javaScriptRuntimeContext(file.program)).toBe("unknown");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(
        file.program,
        "commonjs-wrapper",
      ),
    );
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    let required: t.CallExpression | undefined;
    let loaded: t.CallExpression | undefined;
    traverseJavaScriptAst(file.program, {
      enter: (node) => {
        if (!t.isCallExpression(node)) return;
        if (t.isIdentifier(node.callee, { name: "require" })) required = node;
        if (t.isIdentifier(node.callee, { name: "load" })) loaded = node;
      },
    });
    if (required === undefined || loaded === undefined)
      throw new Error("Expected loader fixture calls");
    expect(
      semanticRequireOrigin(required, index.bindings)?.origin.specifier,
    ).toBe(expected ? "node:module" : undefined);
    expect(semanticRequireLoaderAt(loaded, index.bindings, new Set())).toBe(
      expected ? "create-require" : "local",
    );
  },
);

it.each([
  ["unbound", 'require("./dep.cjs");'],
  ["var redeclaration", 'var require; require("./dep.cjs");'],
  ["var initializer", 'var require; require = require("./dep.cjs");'],
] as const)(
  "does not infer a CommonJS wrapper from %s in unknown runtime context",
  (_name, source) => {
    const { file } = parseRecoveredJavaScript(
      source,
      "entry.MJS",
      {},
      "commonjs",
    );
    expect(javaScriptRuntimeContext(file.program)).toBe("unknown");
    const links = analyzeParsedJavaScriptSemantics(file).moduleLinks;
    expect(links.filter((link) => link.specifier === "./dep.cjs")).toEqual([
      expect.objectContaining({
        kind: "require",
        loaderAuthority: "candidate",
      }),
    ]);
  },
);

it.each([
  ["module.exports = 1;", "default"],
  ["var module; module.exports = 1;", "default"],
  ["var exports; exports.value = 1;", "value"],
] as const)("retains unknown-host export candidates for %s", (source, name) => {
  const { file } = parseRecoveredJavaScript(
    source,
    "entry.MJS",
    {},
    "commonjs",
  );
  expect(analyzeParsedJavaScriptSemantics(file).moduleLinks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "commonjs-export",
        exportedName: name,
        loaderAuthority: "candidate",
      }),
    ]),
  );
});

it("does not claim an unbound module export in a known ES module", () => {
  const { file } = parseRecoveredJavaScript(
    "module.exports = 1;",
    "entry.mjs",
    {},
  );
  expect(analyzeParsedJavaScriptSemantics(file).moduleLinks).toEqual([]);
});

it("retains conditional require provenance through aliases without claiming a host loader", () => {
  const source =
    'const { ipcMain: bus } = require("electron"); const alias = bus;';
  const { file } = parseRecoveredJavaScript(
    source,
    "entry.MJS",
    {},
    "commonjs",
  );
  const ir = analyzeParsedJavaScriptSemantics(file);
  for (const name of ["bus", "alias"]) {
    const binding = ir.bindings.find((item) => item.name === name);
    expect(binding?.provenance).toMatchObject({
      status: "ambiguous",
      origins: [
        {
          specifier: "electron",
          importedPath: ["ipcMain"],
          loaderAuthority: "candidate",
        },
      ],
    });
  }
});

it("detects JavaScript module syntax within an observed unspecified package", () => {
  const { file } = parseRecoveredJavaScript(
    "void import.meta.url;",
    "entry.js",
    {},
    "unspecified",
  );
  expect(file.errors).toEqual([]);
  expect(javaScriptRuntimeContext(file.program)).toBe("module");
});
