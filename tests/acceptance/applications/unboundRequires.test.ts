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
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const execute = promisify(execFile);

const expectUnknownLoaderCandidates = (
  graph: ReturnType<
    typeof javascriptApplicationAnalysisResultSchema.parse
  >["graph"],
): void => {
  const upper = sourceRequireFacts(graph, "upper-module.MJS");
  expect(upper.module_format).toBe("unknown");
  expect(upper.require_targets).toContainEqual([
    "./dep.cjs",
    null,
    "unavailable",
  ]);
  const candidate = graph.edges.find(
    ({ relation, properties, evidence }) =>
      relation === "imports" &&
      properties.specifier === "./dep.cjs" &&
      evidence.location.available &&
      evidence.location.value.kind === "source-range" &&
      evidence.location.value.source === "upper-module.MJS",
  );
  expect(candidate?.properties.resolution_mode).toBeNull();
  expect(candidate?.evidence.confidence).toBe("low");
  expect(candidate?.evidence.limitations.join(" ")).toContain(
    "loader is unknown",
  );
  const staticCandidate = graph.edges.find(
    ({ relation, properties, evidence }) =>
      relation === "imports" &&
      properties.kind === "require" &&
      properties.specifier === "./dep.cjs" &&
      properties.loader_authority === "candidate" &&
      evidence.location.available &&
      evidence.location.value.kind === "source-range" &&
      evidence.location.value.source === "upper-module.MJS",
  );
  expect(staticCandidate).toMatchObject({
    properties: {
      resolution_mode: null,
      resolved_path: null,
      resolution_status: null,
    },
    evidence: {
      confidence: "low",
    },
  });
  expect(staticCandidate?.evidence.limitations.join(" ")).toContain(
    "loader is unknown",
  );
  expect(graph.edges).toContainEqual(
    expect.objectContaining({
      relation: "imports",
      properties: expect.objectContaining({
        kind: "require",
        operation: "resolve",
        specifier: "./dep.cjs",
        loader_authority: "candidate",
        resolved_path: null,
        resolution_mode: null,
      }),
      evidence: expect.objectContaining({
        confidence: "low",
        location: expect.objectContaining({
          value: expect.objectContaining({ source: "upper-resolve.MJS" }),
        }),
      }),
    }),
  );
  for (const source of ["upper-shadow.MJS", "upper-mutated.MJS"]) {
    expect(
      graph.edges.some(
        ({ properties, evidence }) =>
          properties.loader_authority === "candidate" &&
          properties.specifier === "./dep.cjs" &&
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === source,
      ),
    ).toBe(false);
  }
  const candidateExports = graph.edges.filter(
    ({ relation, properties, evidence }) =>
      relation === "exposes" &&
      properties.loader_authority === "candidate" &&
      evidence.location.available &&
      evidence.location.value.kind === "source-range" &&
      evidence.location.value.source === "upper-export.MJS",
  );
  expect(candidateExports.length).toBeGreaterThan(0);
  expect(candidateExports[0]?.evidence).toMatchObject({
    confidence: "low",
  });
  expect(candidateExports[0]?.evidence.limitations.join(" ")).toContain(
    "wrapper is unknown",
  );
  for (const path of ["upper-alias.MJS", "upper-var-export.MJS"]) {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "exposes",
        properties: expect.objectContaining({
          loader_authority: "candidate",
        }),
        evidence: expect.objectContaining({
          confidence: "low",
          location: expect.objectContaining({
            value: expect.objectContaining({ source: path }),
          }),
        }),
      }),
    );
  }
  expect(graph.edges).toContainEqual(
    expect.objectContaining({
      relation: "imports",
      properties: expect.objectContaining({
        module_link_kind: "commonjs-export",
        loader_authority: "candidate",
        specifier: "./dep.cjs",
        resolved_path: null,
        resolution_status: "unavailable",
      }),
      evidence: expect.objectContaining({
        confidence: "low",
        location: expect.objectContaining({
          value: expect.objectContaining({ source: "upper-alias.MJS" }),
        }),
      }),
    }),
  );
  const candidateExportSource = graph.nodes
    .flatMap(({ observations }) => observations)
    .find(
      ({ properties }) =>
        properties.semantic_role === "source-module" &&
        properties.path === "upper-export.MJS",
    );
  expect(
    candidateExportSource?.properties.omitted_export_names,
  ).toBeGreaterThan(0);
  expect(candidateExportSource?.evidence.limitations.join(" ")).toContain(
    "candidate relationships are retained",
  );
};

cliTest.for(["CLI", "stdio MCP"] as const)(
  "distinguishes exact loader suffixes from uppercase artifact names through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-loader-suffix-case-");
    const source = "console.log(42);";
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({
        type: "commonjs",
        main: "upper-module.MJS",
      }),
      "upper-module.MJS":
        'const value = require("./dep.cjs"); console.log(value);',
      "dep.cjs": "module.exports = 42;",
      "upper-export.MJS": "module.exports = { value: 42 };",
      "upper-resolve.MJS": 'require.resolve("./dep.cjs");',
      "upper-shadow.MJS":
        'const require = { resolve() {} }; require.resolve("./dep.cjs");',
      "upper-mutated.MJS":
        'require.resolve = custom; require.resolve("./dep.cjs");',
      "upper-alias.MJS":
        'var module; const dep = require("./dep.cjs"); module.exports = dep;',
      "upper-var-export.MJS": "var exports; exports.name = 42;",
      "nested-mutated.MJS":
        'require.call=custom;require.call.call(require,"./receiver.cjs","./invented.node");',
      "nested-mutated.cjs":
        'require.call=custom;require.call.apply(require,["./receiver.cjs","./invented.node"]);',
      "candidate-alias.MJS": 'const load = require; load("./alias-dep.cjs");',
      "benign-resolve.cjs":
        'require.resolve.paths = custom; require.resolve("./benign-dep.cjs");',
      "benign-call.cjs":
        'require.call.extra = 1; require.call(null, "./call-dep.cjs");',
      "consecutive-methods.cjs":
        'require.resolve.paths = custom; require.resolve("./benign-dep.cjs"); require.call.extra = 1; require.call(null, "./call-dep.cjs");',
      "nested-loader.cjs":
        'const box = {load: require}; box.load.call = () => 0; box.load.call(null, "./nested-false.cjs");',
      "nested-child.cjs":
        'const box = {load: require}; box.load.call.extra = 1; box.load.call(null, "./nested-valid.cjs");',
      "wrapped-call.cts":
        'require.call = () => 0; (require.call as any)(null, "./false-dep.cjs");',
      "alias-dep.cjs": "module.exports = 1;",
      "benign-dep.cjs": "module.exports = 2;",
      "call-dep.cjs": "module.exports = 3;",
      "false-dep.cjs": "module.exports = 4;",
      "nested-false.cjs": "module.exports = 5;",
      "nested-valid.cjs": "module.exports = 6;",
      "upper-wrapper.CJS": source,
      "lower-module.mjs": source,
      "lower-wrapper.cjs": source,
    });
    const control = await execute(
      process.execPath,
      [join(root, "upper-module.MJS")],
      {
        cwd: root,
        timeout: 5_000,
      },
    );
    expect(control.stdout.trim()).toBe("42");
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(result.statistics.parse_failures).toBe(0);
    expectUnknownLoaderCandidates(result.graph);
    for (const path of ["nested-mutated.MJS", "nested-mutated.cjs"]) {
      expect(
        result.graph.edges.some(
          ({ properties, evidence }) =>
            (properties.specifier === "./receiver.cjs" ||
              properties.specifier === "./invented.node") &&
            evidence.location.available &&
            evidence.location.value.kind === "source-range" &&
            evidence.location.value.source === path,
        ),
      ).toBe(false);
    }
    const loaderEdge = (file: string, specifier: string) =>
      result.graph.edges.find(
        ({ properties, evidence }) =>
          properties.specifier === specifier &&
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === file,
      );
    expect
      .soft(
        loaderEdge("candidate-alias.MJS", "./alias-dep.cjs")?.properties
          .loader_authority,
      )
      .toBe("candidate");
    expect
      .soft(loaderEdge("benign-resolve.cjs", "./benign-dep.cjs"))
      .toBeDefined();
    expect.soft(loaderEdge("benign-call.cjs", "./call-dep.cjs")).toBeDefined();
    expect
      .soft(loaderEdge("consecutive-methods.cjs", "./benign-dep.cjs"))
      .toBeDefined();
    expect
      .soft(loaderEdge("consecutive-methods.cjs", "./call-dep.cjs"))
      .toBeDefined();
    expect
      .soft(loaderEdge("nested-loader.cjs", "./nested-false.cjs"))
      .toBeUndefined();
    expect
      .soft(loaderEdge("nested-child.cjs", "./nested-valid.cjs"))
      .toBeDefined();
    expect
      .soft(loaderEdge("wrapped-call.cts", "./false-dep.cjs"))
      .toBeUndefined();
    const modules = result.graph.nodes
      .filter((node) => node.kind === "javascript-module")
      .flatMap((node) =>
        node.observations.map((observation) => observation.properties),
      );
    expect(modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "upper-module.MJS",
          module_format: "unknown",
        }),
        expect.objectContaining({
          path: "upper-wrapper.CJS",
          module_format: "unknown",
        }),
        expect.objectContaining({
          path: "upper-export.MJS",
          module_format: "unknown",
          export_names: [],
        }),
        expect.objectContaining({
          path: "lower-module.mjs",
          module_format: "esm",
        }),
        expect.objectContaining({
          path: "lower-wrapper.cjs",
          module_format: "commonjs",
        }),
      ]),
    );
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains conditional Electron boundaries without resolving their roles through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-candidate-electron-");
    await writeFixtureFiles(root, {
      "entry.MJS": [
        'const { BrowserWindow, ipcMain, protocol, contextBridge, ipcRenderer } = require("electron");',
        'const win = new BrowserWindow({ webPreferences: { preload: "./preload.cjs" } });',
        'win.loadFile("./index.html");',
        'win.loadURL("https://candidate.example.test/app");',
        'ipcMain.handle("ping", () => 1);',
        'protocol.handle("demo", () => null);',
        'contextBridge.exposeInMainWorld("api", { ping: () => ipcRenderer.invoke("ping") });',
      ].join("\n"),
      "preload.cjs": "console.log(1);",
      "index.html": "<html></html>",
      "dynamic.MJS": [
        'const name = "electron";',
        "const { contextBridge, ipcRenderer } = require(name);",
        'contextBridge.exposeInMainWorld("dynamicApi", { ping: () => ipcRenderer.invoke("dynamicPing") });',
      ].join("\n"),
    });
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    for (const kind of ["browser-window", "ipc-handler", "url-scheme"]) {
      expect(result.graph.nodes).toContainEqual(
        expect.objectContaining({
          kind,
          observations: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                loader_authority: "candidate",
              }),
              evidence: expect.objectContaining({
                confidence: "low",
              }),
            }),
          ]),
        }),
      );
    }
    expect(
      result.graph.nodes.some(({ kind }) => kind === "electron-preload"),
    ).toBe(false);
    expect(
      result.graph.nodes.some(({ kind }) => kind === "electron-renderer"),
    ).toBe(false);
    expect(result.graph.nodes).toContainEqual(
      expect.objectContaining({
        kind: "unknown",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              candidate_role: "renderer",
              loader_authority: "candidate",
              declared_path: "./index.html",
              resolution_status: "unavailable",
              resolved_path: null,
            }),
            evidence: expect.objectContaining({ confidence: "low" }),
          }),
        ]),
      }),
    );
    expect(result.graph.nodes).toContainEqual(
      expect.objectContaining({
        kind: "endpoint",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              value: "https://candidate.example.test/app",
              interpretation: "candidate",
            }),
            evidence: expect.objectContaining({ confidence: "low" }),
          }),
        ]),
      }),
    );
    expect(result.graph.nodes).toContainEqual(
      expect.objectContaining({
        kind: "javascript-expression",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              loader_authority: "candidate",
              terminal: "electron.ipcRenderer.invoke",
            }),
            evidence: expect.objectContaining({
              confidence: "low",
            }),
          }),
        ]),
      }),
    );
    expect(result.graph.nodes).toContainEqual(
      expect.objectContaining({
        kind: "javascript-expression",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              loader_authority: "candidate",
              terminal: "electron.ipcRenderer.invoke",
              channel: "dynamicPing",
            }),
            evidence: expect.objectContaining({ confidence: "low" }),
          }),
        ]),
      }),
    );
    expect(result.summary).toMatchObject({
      browser_windows: 0,
      preload_entrypoints: 0,
      protocol_registrations: 0,
      ipc: { operations: 0, main_handlers: 0 },
    });
    expect(result.graph.limitations.join(" ")).toContain(
      "Conditional Electron findings",
    );
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains loader uncertainty in Electron semantic paths through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory(
      "rea-electron-semantic-authority-",
    );
    const source = [
      'const { contextBridge, ipcRenderer } = require("electron");',
      'contextBridge.exposeInMainWorld("api", { ping: () => ipcRenderer.invoke("ping") });',
    ].join("\n");
    await writeFixtureFiles(root, {
      "candidate.MJS": source,
      "proven.cjs": source,
    });
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    const graph = result.semantic_graph;
    const pathNodes = graph.nodes.filter((node) =>
      node.identity.role_key.startsWith("electron-path:"),
    );
    const candidate = pathNodes.filter(
      (node) => node.identity.module_path === "candidate.MJS",
    );
    const proven = pathNodes.filter(
      (node) => node.identity.module_path === "proven.cjs",
    );
    expect(candidate.length).toBeGreaterThan(0);
    expect(proven.length).toBeGreaterThan(0);
    const evidenceFor = (contextId: string) =>
      graph.evidence_contexts.find(
        ({ context_id }) => context_id === contextId,
      );
    for (const node of candidate) {
      expect(node.properties.loader_authority).toBe("candidate");
      const evidence = evidenceFor(node.evidence.context_id);
      expect(evidence).toMatchObject({ state: "inferred", confidence: "low" });
      expect(evidence?.limitations.join(" ")).toContain("loader is unknown");
    }
    for (const node of proven) {
      expect(node.properties.loader_authority).toBeUndefined();
      expect(evidenceFor(node.evidence.context_id)).toMatchObject({
        state: "observed",
        confidence: "exact",
      });
    }
    const relations = graph.relations.filter(
      ({ properties }) => properties.loader_authority === "candidate",
    );
    expect(relations.length).toBeGreaterThan(0);
    for (const relation of relations) {
      const evidence = evidenceFor(relation.evidence.context_id);
      expect(evidence).toMatchObject({ state: "inferred", confidence: "low" });
      expect(evidence?.limitations.join(" ")).toContain("loader is unknown");
    }
  },
);
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
      "renderer-looking-main.js":
        'try { require("electron").ipcRenderer.send("ready"); require("./dep.cjs"); } catch (error) { console.log(error.name); }',
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
      ["renderer-looking-main.js", "ReferenceError"],
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
      "renderer-looking-main.js",
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
        '    webPreferences: { sandbox: false, preload: fileURLToPath(new URL("./preload.js", import.meta.url)) },',
        "  });",
        '  window.loadFile("index.html");',
        "});",
      ].join("\n"),
      "preload.js": [
        'const { contextBridge, ipcRenderer } = require("electron");',
        'function expose() { contextBridge.exposeInMainWorld("api", { ping: () => ipcRenderer.invoke("ping") }); } expose();',
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
    expect(summary.ipc).toMatchObject({
      main_handlers: 1,
      renderer_transmissions: 1,
      paired_renderer_transmissions: 1,
    });
  },
);

cliTest(
  "keeps a declared preload's helper require without renderer API text",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-helper-only-preload-");
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({ type: "module", main: "main.mjs" }),
      "main.mjs":
        'import { BrowserWindow } from "electron"; import { fileURLToPath } from "node:url"; new BrowserWindow({webPreferences:{sandbox:false,preload:fileURLToPath(new URL("./aaa-preload.js",import.meta.url))}});',
      "aaa-preload.js": 'require("./helper.cjs");',
      "helper.cjs": "module.exports = 1;",
    });
    const response = await cli.run({
      arguments: ["analyze-javascript-application", root, "--format", "json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const { graph } = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(response.json).normalized_result,
    );
    expect(sourceRequireFacts(graph, "aaa-preload.js")).toEqual({
      module_format: "commonjs",
      import_relationships: 1,
      require_targets: [["./helper.cjs", "helper.cjs", "resolved"]],
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
