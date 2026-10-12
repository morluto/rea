import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import {
  origin,
  topLevelBinding,
} from "./javascriptSemanticAnalysis.fixture.js";

describe("TypeScript import-equals links", () => {
  it("retains runtime external import-equals as a require dependency", () => {
    const links = analyzeJavaScriptSemantics(`
      import dependency = require("./dependency.cjs");
      import type types = require("./types");
      import alias = Namespace.Dependency;
    `).moduleLinks;

    expect(links).toEqual([
      expect.objectContaining({
        kind: "require",
        specifier: "./dependency.cjs",
        importedName: null,
        localName: "dependency",
        exportedName: null,
      }),
    ]);
  });

  it("keeps the exported binding for exported import-equals", () => {
    const source = 'export import dependency = require("./dependency");';
    const links = analyzeJavaScriptSemantics(source).moduleLinks;

    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "require",
          specifier: "./dependency",
          localName: "dependency",
          exportedName: null,
        }),
        expect.objectContaining({
          kind: "export",
          specifier: null,
          localName: "dependency",
          exportedName: "dependency",
        }),
      ]),
    );
    expect(
      links.find(({ kind }) => kind === "require")?.location.start,
    ).toEqual({ line: 1, column: 7 });
  });
});

describe("CommonJS dependency links", () => {
  it.each([
    'require("dependency");',
    'void require("dependency");',
    'consume(require("dependency"));',
    'require("dependency").member;',
    'require("dependency")[key];',
    'const {} = require("dependency");',
    'const [] = require("dependency");',
    'let assigned; assigned = require("dependency");',
    'function run(value = require("dependency")) {}',
    '(require("dependency") as unknown);',
  ])("retains an unbound dependency in %s", (source) => {
    const ir = analyzeJavaScriptSemantics(source);
    expect(ir.moduleLinks).toEqual([
      expect.objectContaining({
        kind: "require",
        specifier: "dependency",
        importedName: null,
        localName: null,
        exportedName: null,
        callableId: null,
      }),
    ]);
  });

  it.each([
    'function run(require) { require("dependency"); }',
    'require("dependency"); const require = loader;',
    'function run() { require("dependency"); var require; }',
    'with (environment) { require("dependency"); }',
    "require(dynamicSpecifier);",
  ])("does not invent a static global dependency in %s", (source) => {
    expect(analyzeJavaScriptSemantics(source).moduleLinks).toEqual([]);
  });

  it("keeps bindings and re-exports without extra dependency links", () => {
    const ir = analyzeJavaScriptSemantics(`
      const bound = (require("bound") as unknown);
      const { left, right } = require("destructured");
      module.exports = require("forwarded");
      exports.member = require("member").value;
      exports.first = exports.second = require("chained");
    `);
    expect(
      ir.moduleLinks.map(({ kind, specifier, localName, exportedName }) => ({
        kind,
        specifier,
        localName,
        exportedName,
      })),
    ).toEqual([
      {
        kind: "require",
        specifier: "bound",
        localName: "bound",
        exportedName: null,
      },
      {
        kind: "require",
        specifier: "destructured",
        localName: "left",
        exportedName: null,
      },
      {
        kind: "require",
        specifier: "destructured",
        localName: "right",
        exportedName: null,
      },
      {
        kind: "commonjs-export",
        specifier: "forwarded",
        localName: null,
        exportedName: "default",
      },
      {
        kind: "commonjs-export",
        specifier: "member",
        localName: null,
        exportedName: "member",
      },
      {
        kind: "commonjs-export",
        specifier: "chained",
        localName: null,
        exportedName: "first",
      },
      {
        kind: "commonjs-export",
        specifier: "chained",
        localName: null,
        exportedName: "second",
      },
    ]);
    expect(
      ir.bindings.find(({ name }) => name === "bound")?.provenance.origins,
    ).toEqual([{ specifier: "bound", importedPath: [] }]);
  });

  it.each([
    'require("outer", require("inner"));',
    'const bound = require("outer", require("inner"));',
    'module.exports = require("outer", require("inner"));',
  ])("retains a distinct nested call in %s", (source) => {
    const links = analyzeJavaScriptSemantics(source).moduleLinks;
    expect(links.map(({ specifier }) => specifier)).toEqual(["outer", "inner"]);
    expect(links[1]).toMatchObject({
      kind: "require",
      importedName: null,
      localName: null,
      exportedName: null,
    });
  });
});

it("preserves unshadowed require origins through aliases and assignments", () => {
  const ir = analyzeJavaScriptSemantics(`
    const { ipcMain: bus } = require("electron");
    const forwarded = bus;
    let assigned;
    assigned = require("electron").ipcMain;
    { const require = localLoader; require("./local.js"); }
  `);
  for (const name of ["bus", "forwarded"])
    expect(origin(topLevelBinding(ir, name))).toEqual({
      specifier: "electron",
      importedPath: ["ipcMain"],
    });
  expect(topLevelBinding(ir, "assigned").provenance).toMatchObject({
    status: "ambiguous",
    origins: [{ specifier: "electron", importedPath: ["ipcMain"] }],
  });
  expect(ir.moduleLinks.filter(({ kind }) => kind === "require")).toEqual([
    expect.objectContaining({
      specifier: "electron",
      importedName: "ipcMain",
      localName: "bus",
    }),
    expect.objectContaining({
      specifier: "electron",
      importedName: null,
      localName: null,
    }),
  ]);
});
