import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const execute = promisify(execFile);
const compiler = join(
  dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
  "bin",
  "tsc",
);

const typedLines = [
  'export import typed = require("typed-package");',
  'import type TypeOnly = require("./type-only.cjs");',
] as const;
const typedSource = typedLines.join("\n");
const aliasSource = [
  'import raw = require("typed-package");',
  "const alias = raw;",
  "export { alias };",
].join("\n");
const mixedSource = [
  'import { value as imported } from "mixed-package";',
  'import required = require("mixed-package");',
  "const mixed = Date.now() > 0 ? imported : required.value;",
  "export { imported as staticChoice, mixed };",
  "export const requireChoice = required.value;",
].join("\n");
const typescriptSourceFiles = {
  "typed.cts": typedSource,
  "typed.mts": typedSource,
  "alias.cts": aliasSource,
  "alias.mts": aliasSource,
  "mixed.cts": mixedSource,
  "mixed.mts": mixedSource,
};
const typedPackageFiles = {
  "node_modules/typed-package/package.json": JSON.stringify({
    exports: { require: "./actual.cjs", import: "./decoy.mjs" },
  }),
  "node_modules/typed-package/actual.cjs": "module.exports = 42;",
  "node_modules/typed-package/actual.d.cts":
    "declare const value: number; export = value;",
  "node_modules/typed-package/decoy.mjs": "export default 99;",
  "node_modules/typed-package/decoy.d.mts":
    "declare const value: number; export default value;",
  "node_modules/mixed-package/package.json": JSON.stringify({
    exports: { require: "./actual.cjs", import: "./decoy.mjs" },
  }),
  "node_modules/mixed-package/actual.cjs": "exports.value = 42;",
  "node_modules/mixed-package/actual.d.cts":
    "export declare const value: number;",
  "node_modules/mixed-package/decoy.mjs": "export const value = 99;",
  "node_modules/mixed-package/decoy.d.mts":
    "export declare const value: number;",
};

const expectNativeModuleControls = async (root: string): Promise<void> => {
  const emitted = await createTestTempDirectory("rea-import-equals-output-");
  await writeFixtureFiles(emitted, typedPackageFiles);
  await execute(
    process.execPath,
    [
      compiler,
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
      "--allowJs",
      "--outDir",
      emitted,
      join(root, "typed.cts"),
      join(root, "typed.mts"),
      join(root, "alias.cts"),
      join(root, "alias.mts"),
      join(root, "mixed.cts"),
      join(root, "mixed.mts"),
    ],
    { cwd: root, timeout: 10_000 },
  );
  for (const [filename, script] of [
    [
      "typed.cjs",
      'console.log(require("./typed.cjs").typed, require("./alias.cjs").alias);',
    ],
    [
      "typed.mjs",
      'Promise.all([import("./typed.mjs"), import("./alias.mjs")]).then(([first, second]) => console.log(first.typed, second.alias));',
    ],
  ] as const) {
    const typedControl = await execute(process.execPath, ["-e", script], {
      cwd: emitted,
      timeout: 5_000,
    });
    expect(typedControl.stdout.trim()).toBe("42 42");
    expect(await readFile(join(emitted, filename), "utf8")).not.toContain(
      "./type-only.cjs",
    );
  }
  for (const [filename, expected] of [
    ["mixed.cjs", "42 42 42"],
    ["mixed.mjs", "99 42 99"],
  ] as const) {
    const control = await execute(
      process.execPath,
      [
        "-e",
        `import("./${filename}").then(({staticChoice, requireChoice, mixed}) => console.log(staticChoice, requireChoice, mixed));`,
      ],
      { cwd: emitted, timeout: 5_000 },
    );
    expect(control.stdout.trim()).toBe(expected);
  }
  const nativeRequire = createRequire(join(root, "main.cjs"));
  for (const name of ["dependency", "nested"])
    expect(
      relative(root, nativeRequire.resolve(`./${name}.cjs`)).replaceAll(
        "\\",
        "/",
      ),
    ).toBe(`${name}.cjs`);
};

const expectAliasRelationships = (
  graph: ReturnType<
    typeof javascriptApplicationAnalysisResultSchema.parse
  >["graph"],
): void => {
  for (const source of ["alias.cts", "alias.mts"]) {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "imports",
        properties: expect.objectContaining({
          module_link_kind: "export",
          local_name: "alias",
          exported_name: "alias",
          resolution_mode: "require",
          resolved_path: "node_modules/typed-package/actual.cjs",
          resolution_status: "resolved",
        }),
        evidence: expect.objectContaining({
          artifact: expect.objectContaining({
            sha256: createHash("sha256").update(aliasSource).digest("hex"),
          }),
          location: expect.objectContaining({
            value: expect.objectContaining({ source }),
          }),
        }),
      }),
    );
  }
};

const expectMixedRelationships = (
  graph: ReturnType<
    typeof javascriptApplicationAnalysisResultSchema.parse
  >["graph"],
): void => {
  const exported = (source: string, name: string) =>
    graph.edges.filter(
      ({ relation, properties, evidence }) =>
        relation === "imports" &&
        properties.module_link_kind === "export" &&
        properties.exported_name === name &&
        evidence.location.available &&
        evidence.location.value.kind === "source-range" &&
        evidence.location.value.source === source,
    );
  for (const source of ["mixed.cts", "mixed.mts"]) {
    for (const [name, target] of [
      ["staticChoice", source.endsWith(".cts") ? "actual.cjs" : "decoy.mjs"],
      ["requireChoice", "actual.cjs"],
    ] as const)
      expect(exported(source, name)).toMatchObject([
        {
          properties: {
            resolved_path: `node_modules/mixed-package/${target}`,
            resolution_status: "resolved",
          },
          evidence: {
            artifact: {
              sha256: createHash("sha256").update(mixedSource).digest("hex"),
            },
          },
        },
      ]);
  }
  expect(exported("mixed.cts", "mixed")).toMatchObject([
    {
      properties: {
        resolved_path: "node_modules/mixed-package/actual.cjs",
        resolution_status: "resolved",
      },
      evidence: {
        artifact: {
          sha256: createHash("sha256").update(mixedSource).digest("hex"),
        },
      },
    },
  ]);
  expect(exported("mixed.mts", "mixed")).toEqual([]);
};

const expectImportEqualsRelationships = (
  graph: ReturnType<
    typeof javascriptApplicationAnalysisResultSchema.parse
  >["graph"],
): void => {
  for (const [sourcePath, format] of [
    ["typed.cts", "commonjs"],
    ["typed.mts", "esm"],
  ] as const) {
    const typedLinks = graph.edges.filter(
      ({ relation, properties, evidence: edgeEvidence }) =>
        relation === "imports" &&
        properties.module_link_kind === "require" &&
        edgeEvidence.location.available &&
        edgeEvidence.location.value.kind === "source-range" &&
        edgeEvidence.location.value.source === sourcePath,
    );
    expect(typedLinks).toHaveLength(1);
    expect(typedLinks[0]).toMatchObject({
      properties: {
        specifier: "typed-package",
        imported_name: null,
        local_name: "typed",
        resolved_path: "node_modules/typed-package/actual.cjs",
        resolution_status: "resolved",
      },
      evidence: {
        artifact: {
          available: true,
          sha256: createHash("sha256").update(typedSource).digest("hex"),
        },
        location: {
          available: true,
          value: {
            source: sourcePath,
            start: { line: 1, column: 7 },
            end: { line: 1, column: typedLines[0].length },
          },
        },
      },
    });
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "imports",
        properties: expect.objectContaining({
          module_link_kind: "export",
          local_name: "typed",
          resolution_mode: "require",
          resolved_path: "node_modules/typed-package/actual.cjs",
        }),
        evidence: expect.objectContaining({
          location: expect.objectContaining({
            value: expect.objectContaining({ source: sourcePath }),
          }),
        }),
      }),
    );
    expect(
      graph.nodes.flatMap(({ observations }) => observations),
    ).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          semantic_role: "source-module",
          path: sourcePath,
          export_names: ["typed"],
          export_relationships: 1,
        }),
      }),
    );
    expect(
      graph.edges.filter(
        ({ relation, evidence: edgeEvidence }) =>
          relation === "exposes" &&
          edgeEvidence.location.available &&
          edgeEvidence.location.value.kind === "source-range" &&
          edgeEvidence.location.value.source === sourcePath,
      ),
    ).toHaveLength(1);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "imports",
        properties: expect.objectContaining({
          kind: "require",
          specifier: "typed-package",
          resolved_path: "node_modules/typed-package/actual.cjs",
        }),
      }),
    );
    expect(
      graph.nodes.flatMap(({ observations }) => observations),
    ).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          semantic_role: "source-module",
          path: sourcePath,
          module_format: format,
          import_relationships: 1,
        }),
      }),
    );
  }
  expect(
    graph.edges.filter(
      ({ relation, properties }) =>
        relation === "imports" && properties.specifier === "./type-only.cjs",
    ),
  ).toHaveLength(0);
};

/** Source-module facts and semantic require edges of one analyzed source. */
const sourceRequireFacts = (
  graph: ReturnType<
    typeof javascriptApplicationAnalysisResultSchema.parse
  >["graph"],
  path: string,
) => {
  const module = graph.nodes
    .flatMap(({ observations }) => observations)
    .find(
      ({ properties }) =>
        properties.semantic_role === "source-module" &&
        properties.path === path,
    )?.properties;
  const requires = graph.edges.filter(
    ({ relation, properties, evidence }) =>
      relation === "imports" &&
      properties.module_link_kind === "require" &&
      evidence.location.available &&
      evidence.location.value.kind === "source-range" &&
      evidence.location.value.source === path,
  );
  return {
    module_format: module?.module_format,
    import_relationships: module?.import_relationships,
    require_targets: requires.map(({ properties }) => [
      properties.specifier,
      properties.resolved_path,
      properties.resolution_status,
    ]),
  };
};

cliTest(
  "follows the nearest package type for an unbound require in .js sources",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-package-type-requires-");
    const source = (dependency: string) =>
      `try { console.log(require(${JSON.stringify(dependency)})); } catch (error) { console.log(error.name); }\n`;
    // The nearest package.json owns each .js file's scope (Node packages.md,
    // "Determining module system"). Requiring Electron, directly, through a
    // local loader, or in a bundler factory default that never runs, does not
    // give a Node-loaded module a require.
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({ type: "module" }),
      "main.js": source("./dep.cjs"),
      "electron-main.js":
        'try { require("electron"); console.log(require("./dep.cjs")); } catch (error) { console.log(error.name); }\n',
      "shadowed.js": `function load(require) { return require("electron").contextBridge; }\n${source("./dep.cjs")}`,
      "dead-default.js": [
        source("./dep.cjs"),
        "globalThis.webpackChunkApp = [];",
        "globalThis.webpackChunkApp.push([[1], {",
        '  7(module = require("electron").ipcRenderer.send("unused"), exports, load) {}',
        "}]);",
      ].join("\n"),
      "dep.cjs": "module.exports = 1;\n",
      "legacy/package.json": JSON.stringify({ type: "commonjs" }),
      "legacy/main.js": source("../dep.cjs"),
      "untyped/package.json": JSON.stringify({}),
      "untyped/main.js": source("../dep.cjs"),
    });
    for (const [path, expected] of [
      ["main.js", "ReferenceError"],
      ["electron-main.js", "ReferenceError"],
      ["shadowed.js", "ReferenceError"],
      ["dead-default.js", "ReferenceError"],
      ["legacy/main.js", "1"],
      ["untyped/main.js", "1"],
    ] as const) {
      const control = await execute(process.execPath, [join(root, path)], {
        cwd: root,
        timeout: 5_000,
      });
      expect(control.stdout.trim(), path).toBe(expected);
    }

    const response = await cli.run({
      arguments: ["analyze-javascript-application", root, "--format", "json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });

    expect(response.exitCode, response.stderr).toBe(0);
    const { graph } = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(response.json).normalized_result,
    );
    for (const path of [
      "main.js",
      "electron-main.js",
      "shadowed.js",
      "dead-default.js",
    ])
      expect(sourceRequireFacts(graph, path), path).toEqual({
        module_format: "unknown",
        import_relationships: 0,
        require_targets: [],
      });
    for (const path of ["legacy/main.js", "untyped/main.js"])
      expect(sourceRequireFacts(graph, path), path).toEqual({
        module_format: "commonjs",
        import_relationships: 1,
        require_targets: [["../dep.cjs", "dep.cjs", "resolved"]],
      });
  },
);

cliTest(
  "keeps Electron's script loader for a .js preload in a module package scope",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-package-type-preload-");
    // Electron's preload loader ignores "type": "module" ("ES Modules (ESM)
    // in Electron"); main.mjs is an ES module by its suffix.
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({ type: "module", main: "main.mjs" }),
      "main.mjs": [
        'import { app, BrowserWindow, ipcMain } from "electron";',
        'import { fileURLToPath } from "node:url";',
        'ipcMain.handle("ping", () => "pong");',
        "app.whenReady().then(() => {",
        "  const window = new BrowserWindow({",
        '    webPreferences: { preload: fileURLToPath(new URL("./preload.js", import.meta.url)) },',
        "  });",
        '  window.loadFile("index.html");',
        "});",
      ].join("\n"),
      "preload.js": [
        'const { contextBridge, ipcRenderer } = require("electron");',
        'contextBridge.exposeInMainWorld("api", { ping: () => ipcRenderer.invoke("ping") });',
      ].join("\n"),
      // Its only renderer call is a contextBridge exposure inside a helper.
      "bridge-helper.js": [
        'const { contextBridge } = require("electron");',
        "function expose(key) {",
        "  contextBridge.exposeInMainWorld(key, { version: () => 1 });",
        "}",
        'expose("helper");',
      ].join("\n"),
      "index.html": "<!doctype html><title>app</title>\n",
    });

    const response = await cli.run({
      arguments: ["analyze-javascript-application", root, "--format", "json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });

    expect(response.exitCode, response.stderr).toBe(0);
    const { graph, summary } = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(response.json).normalized_result,
    );
    expect(sourceRequireFacts(graph, "preload.js")).toEqual({
      module_format: "commonjs",
      import_relationships: 2,
      require_targets: [
        ["electron", null, "external"],
        ["electron", null, "external"],
      ],
    });
    expect(sourceRequireFacts(graph, "bridge-helper.js")).toEqual({
      module_format: "commonjs",
      import_relationships: 1,
      require_targets: [["electron", null, "external"]],
    });
    expect(summary.ipc).toMatchObject({
      main_handlers: 1,
      renderer_transmissions: 1,
      paired_renderer_transmissions: 1,
    });
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains unbound CommonJS semantic relationships through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-unbound-requires-");
    const lines = [
      'require("./dependency.cjs");',
      'void require("./dependency.cjs");',
      'consume(require("./dependency.cjs"));',
      'require("./dependency.cjs").member;',
      'const {} = require("./dependency.cjs");',
      'const bound = require("./dependency.cjs");',
      'const { left, right } = require("./dependency.cjs");',
      'module.exports = require("./dependency.cjs", require("./nested.cjs"));',
      'function local(require) { require("./shadow.cjs"); }',
      "require(dynamicSpecifier);",
      'let assigned; assigned = require("./dependency.cjs");',
    ] as const;
    const source = lines.join("\n");
    const files = {
      "main.cjs": source,
      "imports.mjs": 'import "./dependency.cjs";',
      "dependency.cjs": 'throw new Error("fixture must not execute");',
      "nested.cjs": 'throw new Error("fixture must not execute");',
      ...typescriptSourceFiles,
      "type-only.d.cts": "declare const value: unknown; export = value;",
    };
    await Promise.all(
      Object.entries(files).map(([path, text]) =>
        writeFile(join(root, path), text),
      ),
    );
    await writeFixtureFiles(root, typedPackageFiles);
    await expectNativeModuleControls(root);

    let document: unknown;
    if (surface === "CLI") {
      const response = await cli.run({
        arguments: ["analyze-javascript-application", root, "--format", "json"],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(response.exitCode, response.stderr).toBe(0);
      document = response.json;
    } else {
      const { call } = await connectLocalToolsMcp();
      const response = await call("analyze_javascript_application", {
        input_path: root,
        format: "directory",
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      document = response.structuredContent;
    }
    const evidence = parseEvidence(document);
    const { graph } = javascriptApplicationAnalysisResultSchema.parse(
      evidence.normalized_result,
    );
    expectImportEqualsRelationships(graph);
    expectAliasRelationships(graph);
    expectMixedRelationships(graph);
    const links = graph.edges.filter(
      ({ relation, properties, evidence: edgeEvidence }) =>
        relation === "imports" &&
        properties.module_link_kind === "require" &&
        edgeEvidence.location.available &&
        edgeEvidence.location.value.kind === "source-range" &&
        edgeEvidence.location.value.source === "main.cjs",
    );
    expect(links).toHaveLength(10);
    for (const [line, count] of [
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 1],
      [7, 2],
      [8, 1],
      [11, 1],
    ] as const)
      expect(
        links.filter(
          ({ evidence: edgeEvidence }) =>
            edgeEvidence.location.available &&
            edgeEvidence.location.value.kind === "source-range" &&
            edgeEvidence.location.value.start.line === line,
        ),
        `semantic links on line ${line}`,
      ).toHaveLength(count);
    const digest = createHash("sha256").update(source).digest("hex");
    for (const edge of links) {
      expect(edge.evidence.artifact).toMatchObject({
        available: true,
        sha256: digest,
      });
      expect(edge.properties.resolution_status).toBe("resolved");
      expect(edge.properties.resolved_path).toBe(
        edge.properties.specifier === "./nested.cjs"
          ? "nested.cjs"
          : "dependency.cjs",
      );
    }
    const bare = links.find(
      ({ evidence: edgeEvidence }) =>
        edgeEvidence.location.available &&
        edgeEvidence.location.value.kind === "source-range" &&
        edgeEvidence.location.value.start.line === 1,
    );
    expect(bare).toMatchObject({
      properties: {
        imported_name: null,
        local_name: null,
        exported_name: null,
      },
      evidence: {
        location: {
          available: true,
          value: {
            source: "main.cjs",
            start: { line: 1, column: 0 },
            end: { line: 1, column: lines[0].length - 1 },
          },
        },
      },
    });
    expect(
      graph.nodes
        .flatMap(({ observations }) => observations)
        .find(
          ({ properties }) =>
            properties.semantic_role === "source-module" &&
            properties.path === "main.cjs",
        )?.properties.import_relationships,
    ).toBe(10);
    expect(
      graph.edges.some(
        ({ relation, properties }) =>
          relation === "imports" &&
          properties.kind === "require" &&
          properties.specifier === "./dependency.cjs",
      ),
    ).toBe(true);
    expect(
      graph.edges.filter(
        ({ relation, properties }) =>
          relation === "imports" &&
          properties.module_link_kind === "commonjs-export" &&
          properties.specifier === "./dependency.cjs",
      ),
    ).toHaveLength(1);
  },
);
