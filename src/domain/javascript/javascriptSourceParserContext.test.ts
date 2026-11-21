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
  semanticRequireOriginCandidate,
} from "./javascriptSemanticRequireOrigin.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";
import { referenceSourceRequireCalls } from "../referenceSourceRequireBindings.js";

import {
  javaScriptRuntimeContext,
  parseJavaScriptSource,
  parseRecoveredJavaScript,
} from "./javascriptSourceParser.js";

it.each([
  ["entry.cts", ["ReservedArrowTypeParam"]],
  ["entry.mts", ["ReservedArrowTypeParam"]],
  ["entry.ts", []],
] as const)(
  "applies the TypeScript suffix grammar for %s and preserves recovered declarations",
  (path, errors) => {
    const source = [
      "const ambiguous = <T>(value: T) => value;",
      "const explicit = <T,>(value: T) => value;",
      "const constrained = <T extends unknown>(value: T) => value;",
      'const angle = <string>"value";',
      'const assertion = "value" as string;',
    ].join("\n");
    const application = parseJavaScriptSource(source, path);
    const reference = parseRecoveredJavaScript(source, path, {}).file;
    if (application === null) throw new Error("Expected recovered source");
    for (const file of [application, reference]) {
      expect(file.errors.map(({ reasonCode }) => reasonCode)).toEqual(errors);
      expect(file.program.body).toHaveLength(5);
    }
  },
);

it.each([
  ["main.js", "commonjs", "void new.target; return;", false],
  ["main.cjs", "module", "void new.target; return;", false],
  ["main.js", "unspecified", "void new.target; return;", false],
  ["main.js", "module", "return;", true],
  ["main.mjs", "commonjs", "return;", true],
  ["main.js", "unspecified", "export const marker=1; return;", true],
  ["main.ts", "commonjs", "return;", true],
  ["main.cts", "module", "void new.target;", true],
  ["main.d.cts", "commonjs", "return;", true],
  ["main.ts", "commonjs", "var await = 1;", false],
  ["main.cts", "module", "var await = 1;", false],
] as const)(
  "selects loader grammar before interpreting %s (%s): %s",
  (path, packageType, source, invalid) => {
    const application = parseJavaScriptSource(source, path, packageType);
    const reference = parseRecoveredJavaScript(
      source,
      path,
      {
        allowReturnOutsideFunction: true,
      },
      packageType,
    ).file;
    expect(application).not.toBeNull();
    expect((application?.errors.length ?? 0) > 0).toBe(invalid);
    expect(reference.errors.length > 0).toBe(invalid);
  },
);

it.each([
  ["entry.js", "commonjs"],
  ["entry.cjs", "module"],
] as const)(
  "retains recovered imports and grammar errors for mixed syntax in %s",
  (path, packageType) => {
    const source = 'import "./dep.mjs"; void new.target; return;';
    const application = parseJavaScriptSource(source, path, packageType);
    const reference = parseRecoveredJavaScript(
      source,
      path,
      {},
      packageType,
    ).file;

    expect(
      application?.program.body.some((node) => t.isImportDeclaration(node)),
    ).toBe(true);
    expect(application?.errors.map(({ reasonCode }) => reasonCode)).toContain(
      "IllegalReturn",
    );
    expect(
      reference.program.body.some((node) => t.isImportDeclaration(node)),
    ).toBe(true);
    expect(reference.errors.map(({ reasonCode }) => reasonCode)).toContain(
      "ImportOutsideModule",
    );
  },
);

it.each([
  ["const module=1;", "module"],
  ["let require;", "require"],
  ["class __filename {}", "__filename"],
  ["const {value: exports}={value: 1};", "exports"],
  ["const [__dirname]=['x'];", "__dirname"],
] as const)(
  "distinguishes a detected module from wrapper collision: %s",
  (declaration, name) => {
    const prefix = "void '😀'; ";
    const source = `const face='😀';\r\n${prefix}${declaration}`;
    for (const context of ["unspecified", "commonjs"] as const) {
      const application = parseJavaScriptSource(source, "entry.js", context);
      const reference = parseRecoveredJavaScript(
        source,
        "entry.js",
        {
          allowReturnOutsideFunction: true,
        },
        context,
      ).file;
      if (application === null) throw new Error("Expected recovered source");
      for (const file of [application, reference]) {
        expect(javaScriptRuntimeContext(file.program)).toBe(
          context === "unspecified" ? "module" : "commonjs",
        );
        if (context === "unspecified") expect(file.errors).toEqual([]);
        else
          expect(file.errors).toEqual([
            expect.objectContaining({
              reasonCode: "CommonJsWrapperLexicalDeclaration",
              pos: source.lastIndexOf(name),
              loc: expect.objectContaining({
                line: 2,
                column: prefix.length + declaration.lastIndexOf(name),
              }),
            }),
          ]);
      }
    }
  },
);

it.each([
  "var module;",
  "function module(){}",
  "{let module;}",
  "for(let module of []) {}",
  "const value=function(module){};",
  "class Value { module=1; }",
])(
  "keeps wrapper-compatible bindings in the CommonJS script: %s",
  (declaration) => {
    const source = `${declaration} void new.target; return;`;
    const application = parseJavaScriptSource(
      source,
      "entry.js",
      "unspecified",
    );
    const reference = parseRecoveredJavaScript(
      source,
      "entry.js",
      {},
      "unspecified",
    ).file;
    expect(application?.errors).toEqual([]);
    expect(reference.errors).toEqual([]);
    expect(javaScriptRuntimeContext(reference.program)).toBe("commonjs");
  },
);

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
] as const)(
  "preserves parser-owned %s context over an observed %s package type",
  (path, observed, expected) => {
    const parsed = parseRecoveredJavaScript("", path, {}, observed);
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
    {},
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

// The loader and the origin of one unbound require call answer one question,
// with activation timing: may an assignment to `require` run before the call?
// Each "after" row states why the call is proven to run before every
// assignment; each "may precede" row states why that proof is missing.
const unboundRequireCases = [
  {
    source: 'const fs = require("fs"); for (const x of [1]) require = custom;',
    precedes: false,
    why: "the loop is a later top-level statement, so it starts only after the call",
  },
  {
    source: 'const fs = require("fs"); for (const x of []) require = custom;',
    precedes: false,
    why: "an empty array literal with unchanged array iteration never runs the body",
  },
  {
    source: 'require = wrap(require("fs"));',
    precedes: false,
    why: "the right-hand side is evaluated before the assignment stores its value",
  },
  {
    source: 'const fs = require("fs"); require = custom;',
    precedes: false,
    why: "a later straight-line top-level statement runs after the call",
  },
  {
    source:
      'Array.prototype[Symbol.iterator] = gen; const fs = require("fs"); for (const x of []) require = custom;',
    precedes: true,
    why: "a replaced array iterator can yield from an empty literal",
  },
  {
    source: 'for (const x of [1]) require = custom; const fs = require("fs");',
    precedes: true,
    why: "the loop body runs before the call",
  },
  {
    source: 'const fs = require("fs"); while (ready) require = custom;',
    precedes: true,
    why: "a while body is not placed by top-level statement order",
  },
  {
    source: 'function load() { require = custom; } const fs = require("fs");',
    precedes: true,
    why: "a hoisted function may run before the call",
  },
  {
    source:
      'class C { fs = require("fs"); } for (const x of [1]) require = custom; const c = new C();',
    precedes: true,
    why: "an instance field runs on construction, after the loop",
  },
  {
    source: 'require = class { fs = require("fs"); }; new require();',
    precedes: true,
    why: "a field of the replacement class runs on construction, after the replacement",
  },
] as const;

const unboundRequireCall = (
  source: string,
  sourcePath: string,
  packageType?: "commonjs",
  specifier = "fs",
) => {
  const { file } = parseRecoveredJavaScript(
    source,
    sourcePath,
    {},
    packageType,
  );
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(file.program),
  );
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  let required: t.CallExpression | undefined;
  traverseJavaScriptAst(file.program, {
    enter: (node) => {
      if (
        t.isCallExpression(node) &&
        t.isIdentifier(node.callee, { name: "require" }) &&
        t.isStringLiteral(node.arguments[0], { value: specifier })
      )
        required = node;
    },
  });
  if (required === undefined) throw new Error("Expected a require call");
  return { program: file.program, required, state: index.bindings };
};

it.each(unboundRequireCases)(
  "agrees on loader and origin for a CommonJS require in $source ($why)",
  ({ source, precedes }) => {
    const { program, required, state } = unboundRequireCall(
      source,
      "entry.cjs",
      "commonjs",
    );
    expect(javaScriptRuntimeContext(program)).toBe("commonjs");
    expect(semanticRequireLoaderAt(required, state, new Set())).toBe(
      precedes ? "unknown" : "commonjs-loader",
    );
    expect(semanticRequireOrigin(required, state)?.origin.specifier).toBe(
      precedes ? undefined : "fs",
    );
  },
);

it.each(unboundRequireCases)(
  "keeps an unknown-runtime require a candidate in $source ($why)",
  ({ source, precedes }) => {
    const { program, required, state } = unboundRequireCall(source, "entry.js");
    expect(javaScriptRuntimeContext(program)).toBe("unknown");
    expect(semanticRequireLoaderAt(required, state, new Set())).toBe("unknown");
    expect(semanticRequireOriginCandidate(required, state)?.origin).toEqual(
      precedes
        ? undefined
        : {
            specifier: "fs",
            importedPath: [],
            resolutionMode: "require",
            loaderAuthority: "candidate",
          },
    );
    expect(semanticRequireOrigin(required, state)).toBeUndefined();
  },
);

it.each([
  ["function outcome(){}", "outcome()", "commonjs-loader"],
  [
    "function outcome(flag){if(flag)return;}",
    "outcome(true)",
    "commonjs-loader",
  ],
  [
    "function outcome(){function nested(){return unknown;}}",
    "outcome()",
    "commonjs-loader",
  ],
  ["function outcome(){}", "outcome(module)", "unknown"],
  [
    "function outcome(flag){if(flag)return external();}",
    "outcome(true)",
    "unknown",
  ],
])(
  "checks argument evaluation independently of an empty return: %s, %s",
  (declaration, prefix, loader) => {
    const { required, state } = unboundRequireCall(
      `${declaration}
     Reflect.set({}, "require", 0, (${prefix}, {}));
     require("node:path");`,
      "ordinary.cjs",
      "commonjs",
      "node:path",
    );
    expect(semanticRequireLoaderAt(required, state, new Set())).toBe(loader);
  },
);

it.each([
  [
    "const box={get owner(){observe(module);return 0;}};",
    "typeof box.owner",
    "unknown",
  ],
  ["function owner(){observe(module);return 0;}", "typeof owner()", "unknown"],
  [
    "const box={get owner(){listener.value=module;return 0;}};",
    "typeof box.owner",
    "unknown",
  ],
  [
    "function owner(){listener.value=module;return 0;}",
    "typeof owner()",
    "unknown",
  ],

  ["", "typeof ({owner:module}).owner", "commonjs-loader"],
  ["const box={owner:module};", "typeof box.owner", "commonjs-loader"],
  ["const box={owner:module};", "void box.owner", "commonjs-loader"],
  ["const box={owner:module};", "box.owner === null", "commonjs-loader"],
  [
    "const box={get owner(){return module;}};",
    "typeof box.owner",
    "commonjs-loader",
  ],
  ["function owner(){return module;}", "typeof owner()", "commonjs-loader"],
  ["", "typeof ({owner:observe(module)}).owner", "unknown"],
  [
    "const box={get owner(){return observe(module);}};",
    "typeof box.owner",
    "unknown",
  ],
  ["function owner(){return observe(module);}", "typeof owner()", "unknown"],
  ["const box={owner:module};", "typeof box[select(module)]", "unknown"],
])(
  "separates scalar evaluation from an intermediate value: %s %s",
  (setup, prefix, expected) => {
    const { required, state } = unboundRequireCall(
      `${setup} Reflect.set({}, "require", 0, (${prefix}, {})); require("node:path");`,
      "scalar.cjs",
      "commonjs",
      "node:path",
    );
    expect(semanticRequireLoaderAt(required, state, new Set())).toBe(expected);
  },
);
