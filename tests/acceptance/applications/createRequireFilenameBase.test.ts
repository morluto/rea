import { createRequire } from "node:module";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  analyzeJavaScriptDirectory,
  runNodeJsonControl,
} from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";
import {
  UNKNOWN_MODULE_LOADER_LIMITATION,
  UNKNOWN_REQUIRE_RESOLVE_SEARCH_PATH_LIMITATION,
} from "../../../src/application/javascript/JavaScriptArtifactPathResolution.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "resolves proven createRequire filenames from their own directory through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-create-require-base-");
    await writeFixtureFiles(root, {
      "main.mjs": `import { createRequire } from "node:module";
const nested = createRequire(new URL("./nested/anchor.cjs", import.meta.url));
const current = createRequire(import.meta.url);
console.log(JSON.stringify([nested("./dep.cjs"), current("./dep.cjs")]));`,
      "dep.cjs": 'module.exports = "root";',
      "nested/anchor.cjs": "",
      "nested/dep.cjs": 'module.exports = "nested";',
    });

    expect(await runNodeJsonControl(root, "main.mjs")).toEqual([
      "nested",
      "root",
    ]);
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const dependencies = graph.edges
      .filter(
        ({ relation, properties }) =>
          relation === "imports" &&
          properties.specifier === "./dep.cjs" &&
          properties.kind === "require",
      )
      .map(({ properties }) => ({
        resolution_base_path: properties.resolution_base_path,
        resolved_path: properties.resolved_path,
      }));
    expect(dependencies).toHaveLength(2);
    expect(dependencies).toEqual(
      expect.arrayContaining([
        {
          resolution_base_path: "./nested/anchor.cjs",
          resolved_path: "nested/dep.cjs",
        },
        { resolution_base_path: null, resolved_path: "dep.cjs" },
      ]),
    );
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains package-scoped require.resolve lookups with an explicit path list through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-resolver-package-scope-");
    const packageJson = (name: string) =>
      JSON.stringify({
        name,
        imports: { "#dep": "./alias.cjs" },
        exports: { "./self": "./self.cjs" },
      });
    const target =
      'throw new Error("require.resolve must only look up a path");';
    await writeFixtureFiles(root, {
      "main.cjs": [
        'require.resolve("#dep", { paths: [] });',
        'require.resolve("root-fixture/self", { paths: [__dirname + "/nested"] });',
        'require.resolve("./dep.cjs", { paths: [] });',
        'require.resolve("./dep.cjs", { paths: [__dirname] });',
        'require.resolve("./dep.cjs", { paths: [__dirname + "/sub"] });',
      ].join("\n"),
      "entry.mjs": [
        'import { createRequire } from "node:module";',
        'const nested = createRequire(new URL("./nested/anchor.cjs", import.meta.url));',
        'nested.resolve("#dep", { paths: [] });',
        'nested.resolve("nested-fixture/self", { paths: [] });',
      ].join("\n"),
      "package.json": packageJson("root-fixture"),
      "alias.cjs": target,
      "self.cjs": target,
      "dep.cjs": target,
      "sub/dep.cjs": target,
      "nested/package.json": packageJson("nested-fixture"),
      "nested/anchor.cjs": "",
      "nested/alias.cjs": target,
      "nested/self.cjs": target,
    });

    const resolve = createRequire(join(root, "main.cjs")).resolve;
    expect(resolve("./dep.cjs", { paths: [join(root, "sub")] })).toBe(
      join(root, "sub", "dep.cjs"),
    );
    expect(() => resolve("./dep.cjs", { paths: [] })).toThrow();

    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const lookups = graph.edges.flatMap(({ properties, evidence }) => {
      if (properties.operation !== "resolve" || !evidence.location.available)
        return [];
      const location = evidence.location.value;
      if (location.kind !== "source-range") return [];
      return [
        {
          call: location.source + ":" + String(location.start.line),
          path: properties.resolved_path,
          anchor: properties.resolution_base_path,
        },
      ];
    });
    expect(lookups).toHaveLength(7);
    expect(lookups).toEqual(
      expect.arrayContaining([
        { call: "main.cjs:1", path: "alias.cjs", anchor: null },
        { call: "main.cjs:2", path: "self.cjs", anchor: null },
        { call: "main.cjs:3", path: null, anchor: null },
        { call: "main.cjs:4", path: "dep.cjs", anchor: null },
        { call: "main.cjs:5", path: null, anchor: null },
        {
          call: "entry.mjs:3",
          path: "nested/alias.cjs",
          anchor: "./nested/anchor.cjs",
        },
        {
          call: "entry.mjs:4",
          path: "nested/self.cjs",
          anchor: "./nested/anchor.cjs",
        },
      ]),
    );
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "keeps unknown loader and search-path evidence distinct through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-resolver-evidence-");
    await writeFixtureFiles(root, {
      "known.cjs": 'require.resolve("./dep.cjs", { paths: [] });',
      "unknown.MJS": 'require.resolve("./dep.cjs", { paths: [] });',
      "dep.cjs": 'throw new Error("the analysis must not load this file");',
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const edges = graph.edges.filter(
      ({ relation, properties }) =>
        relation === "imports" &&
        properties.operation === "resolve" &&
        properties.specifier === "./dep.cjs",
    );
    expect(edges).toHaveLength(2);
    const edgeFrom = (source: string) =>
      edges.find(
        ({ evidence }) =>
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === source,
      );
    const known = edgeFrom("known.cjs");
    expect(known).toMatchObject({
      properties: { resolved_path: null, resolution_status: "unavailable" },
      evidence: { confidence: "high" },
    });
    expect(known?.evidence.limitations).toContain(
      UNKNOWN_REQUIRE_RESOLVE_SEARCH_PATH_LIMITATION,
    );
    const unknown = edgeFrom("unknown.MJS");
    expect(unknown).toMatchObject({
      properties: { loader_authority: "candidate", resolved_path: null },
      evidence: { confidence: "low" },
    });
    expect(unknown?.evidence.limitations).toContain(
      UNKNOWN_MODULE_LOADER_LIMITATION,
    );
    expect(unknown?.evidence.limitations).not.toContain(
      UNKNOWN_REQUIRE_RESOLVE_SEARCH_PATH_LIMITATION,
    );
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves default paths and uncertain traversal through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-resolver-default-paths-");
    await writeFixtureFiles(root, {
      "main.cjs": [
        'require.resolve("./dep.cjs", { paths: undefined });',
        'require.resolve("./dep.cjs", { paths: void 0 });',
        'require.resolve("./dep.cjs", { paths: [__dirname + "/."] });',
        'require.resolve("./dep.cjs", { paths: [__dirname + "/sub/.."] });',
        'require.resolve("./dep.cjs", { paths: [__dirname + "/missing/.."] });',
        'require.resolve("./dep.cjs", { paths: [] });',
        'require.resolve("./dep.cjs", { paths: [__dirname + "/sub"] });',
        'function shadow(undefined) { require.resolve("./dep.cjs", { paths: undefined }); }',
      ].join("\n"),
      "nested.mjs": [
        'import { createRequire } from "node:module";',
        'const nested = createRequire(new URL("./sub/anchor.cjs", import.meta.url));',
        'nested.resolve("./dep.cjs", { paths: undefined });',
        'nested.resolve("./dep.cjs", { paths: [] });',
      ].join("\n"),
      "dep.cjs": 'throw new Error("resolve must not load this file");',
      "sub/anchor.cjs": "",
      "sub/dep.cjs": 'throw new Error("resolve must not load this file");',
    });
    const resolve = createRequire(join(root, "main.cjs")).resolve;
    expect(resolve("./dep.cjs", { paths: undefined })).toBe(
      join(root, "dep.cjs"),
    );
    expect(resolve("./dep.cjs", { paths: [join(root, ".")] })).toBe(
      join(root, "dep.cjs"),
    );
    expect(resolve("./dep.cjs", { paths: [`${root}/sub/..`] })).toBe(
      join(root, "dep.cjs"),
    );
    if (process.platform === "win32") {
      expect(resolve("./dep.cjs", { paths: [`${root}/missing/..`] })).toBe(
        join(root, "dep.cjs"),
      );
    } else if (process.platform === "linux") {
      expect(() =>
        resolve("./dep.cjs", { paths: [`${root}/missing/..`] }),
      ).toThrow();
    }
    expect(() => resolve("./dep.cjs", { paths: [] })).toThrow();
    const nested = createRequire(join(root, "sub/anchor.cjs")).resolve;
    expect(nested("./dep.cjs", { paths: undefined })).toBe(
      join(root, "sub/dep.cjs"),
    );

    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const lookups = graph.edges.flatMap(({ properties, evidence }) => {
      if (
        properties.operation !== "resolve" ||
        properties.specifier !== "./dep.cjs" ||
        !evidence.location.available
      )
        return [];
      const location = evidence.location.value;
      return location.kind === "source-range"
        ? [
            {
              source: location.source,
              line: location.start.line,
              path: properties.resolved_path,
            },
          ]
        : [];
    });
    expect(lookups).toHaveLength(10);
    expect(lookups).toEqual(
      expect.arrayContaining([
        ...[1, 2, 3].map((line) => ({
          source: "main.cjs",
          line,
          path: "dep.cjs",
        })),
        ...[4, 5, 6, 7, 8].map((line) => ({
          source: "main.cjs",
          line,
          path: null,
        })),
        { source: "nested.mjs", line: 3, path: "sub/dep.cjs" },
        { source: "nested.mjs", line: 4, path: null },
      ]),
    );
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains a parent in a createRequire filename that re-enters a same-named directory through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-create-require-parent-");
    await writeFixtureFiles(root, {
      "app/main.mjs": `import { createRequire } from "node:module";
const sibling = createRequire(new URL("../source/anchor.cjs", import.meta.url));
console.log(JSON.stringify(sibling("./dep.cjs")));`,
      "app/dep.cjs": 'module.exports = "app";',
      "source/dep.cjs": 'module.exports = "source";',
    });

    expect(await runNodeJsonControl(root, "app/main.mjs")).toBe("source");
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(
      graph.edges
        .filter(
          ({ relation, properties }) =>
            relation === "imports" &&
            properties.specifier === "./dep.cjs" &&
            properties.kind === "require",
        )
        .map(({ properties }) => ({
          resolution_base_path: properties.resolution_base_path,
          resolved_path: properties.resolved_path,
        })),
    ).toEqual([
      {
        resolution_base_path: "../source/anchor.cjs",
        resolved_path: "source/dep.cjs",
      },
    ]);
  },
);
