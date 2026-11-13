import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  analyzeJavaScriptDirectory,
  runNodeJsonControl,
} from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

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
      "nested/package.json": packageJson("nested-fixture"),
      "nested/anchor.cjs": "",
      "nested/alias.cjs": target,
      "nested/self.cjs": target,
    });

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
    expect(lookups).toHaveLength(6);
    expect(lookups).toEqual(
      expect.arrayContaining([
        { call: "main.cjs:1", path: "alias.cjs", anchor: null },
        { call: "main.cjs:2", path: "self.cjs", anchor: null },
        { call: "main.cjs:3", path: null, anchor: null },
        { call: "main.cjs:4", path: "dep.cjs", anchor: null },
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
