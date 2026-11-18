import { createHash } from "node:crypto";
import { expect } from "vitest";

import { historicalSourceGraphSchema } from "../../../src/domain/referenceSourceGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  analyzeJavaScriptDirectory,
  runNodeJsonControl,
} from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const fixture = async () => {
  const root = await createTestTempDirectory("rea-bom-hashbang-");
  const files = {
    "package.json": JSON.stringify({ type: "commonjs", main: "module.mjs" }),
    "module.mjs":
      '\uFEFF#!/usr/bin/env node\nconst face="😀"; import {marker} from "./dep.mjs"; console.log(JSON.stringify({marker}));',
    "esm/package.json": JSON.stringify({ type: "module" }),
    "esm/main.js":
      '\uFEFF#!/usr/bin/env node\r\nconst face="😀"; import {marker} from "../dep.mjs"; console.log(JSON.stringify({marker}));',
    "typed.mts":
      '\uFEFF#!/usr/bin/env node\nconst face: string="😀"; import {marker} from "./dep.mjs"; console.log(JSON.stringify({marker}));',
    "typed.cts":
      '\uFEFF#!/usr/bin/env node\nconst face: string="😀"; const {marker}=require("./dep.cjs"); console.log(JSON.stringify({marker}));',
    "rejected.cjs":
      '\uFEFF#!/usr/bin/env node\nconst {marker}=require("./dep.cjs"); console.log(JSON.stringify({marker}));',
    "rejected.js":
      '\uFEFF#!/usr/bin/env node\nconst {marker}=require("./dep.cjs"); console.log(JSON.stringify({marker}));',
    "plain.cjs":
      '#!/usr/bin/env node\nconst {marker}=require("./dep.cjs"); console.log(JSON.stringify({marker}));',
    "dep.mjs": "export const marker=42;",
    "dep.cjs": "exports.marker=42;",
  };
  await writeFixtureFiles(root, files);
  return { root, files };
};

cliTest.for(["CLI", "stdio MCP"] as const)(
  "analyzes BOM/hashbang modules with original Evidence through %s",
  async (surface, { cli }) => {
    const { root, files } = await fixture();
    for (const path of [
      "module.mjs",
      "esm/main.js",
      "typed.mts",
      "typed.cts",
      "plain.cjs",
    ])
      expect(await runNodeJsonControl(root, path)).toEqual({ marker: 42 });
    for (const path of ["rejected.cjs", "rejected.js"])
      await expect(runNodeJsonControl(root, path)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("SyntaxError"),
      });
    const { graph, statistics } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      root,
    );
    expect(statistics.parse_failures).toBe(2);
    for (const [path, kind, target] of [
      ["module.mjs", "static-import", "dep.mjs"],
      ["esm/main.js", "static-import", "dep.mjs"],
      ["typed.mts", "static-import", "dep.mjs"],
      ["typed.cts", "require", "dep.cjs"],
      ["plain.cjs", "require", "dep.cjs"],
    ] as const) {
      const source = files[path];
      const line = source.split(/\r?\n/u)[1]!;
      const start = line.indexOf(kind === "require" ? "require" : "import");
      const end = line.indexOf(kind === "require" ? ")" : ";", start) + 1;
      const edges = graph.edges.filter(
        ({ relation, properties, evidence }) =>
          relation === "imports" &&
          properties.kind === kind &&
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === path,
      );
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        properties: { resolved_path: target },
        evidence: {
          artifact: {
            available: true,
            sha256: createHash("sha256").update(source).digest("hex"),
          },
          location: {
            available: true,
            value: {
              kind: "source-range",
              source: path,
              start: { line: 2, column: start },
              end: { line: 2, column: end },
            },
          },
        },
      });
    }
    expect(
      graph.edges.filter(
        ({ relation, evidence }) =>
          relation === "imports" &&
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          ["rejected.cjs", "rejected.js"].includes(
            evidence.location.value.source,
          ),
      ),
    ).toEqual([]);
  },
);

cliTest.runIf(process.platform !== "win32")(
  "reference import retains module imports and rejects CommonJS BOM/hashbangs",
  async ({ cli }) => {
    const { root, files } = await fixture();
    const output = await cli.run({
      arguments: ["import-reference-source", root, "--json"],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const graph = historicalSourceGraphSchema.parse(output.json);
    expect(
      graph.parse_failures
        .map(({ path }) => path)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(["rejected.cjs", "rejected.js"]);
    for (const path of ["module.mjs", "esm/main.js", "typed.mts"] as const) {
      expect(graph.entries).toContainEqual(
        expect.objectContaining({
          path,
          sha256: createHash("sha256").update(files[path]).digest("hex"),
        }),
      );
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from_path: path,
          to: "dep.mjs",
          kind: "imports",
          parse_state: "parsed",
          resolution: "internal",
        }),
      );
    }
    expect(graph.relationships).toContainEqual(
      expect.objectContaining({
        from_path: "typed.cts",
        to: "dep.cjs",
        kind: "requires",
        parse_state: "parsed",
      }),
    );
    expect(
      graph.relationships.filter(({ from_path }) =>
        from_path.startsWith("rejected."),
      ),
    ).toEqual([]);
  },
);
