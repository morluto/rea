import { join } from "node:path";
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

const importedDotfiles = [
  ".cjs",
  ".CJS",
  ".JS",
  ".MJS",
  ".jsx",
  ".JSX",
  ".ts",
  ".TS",
  ".mts",
  ".MTS",
  ".cts",
  ".CTS",
  ".tsx",
  ".TSX",
].map((name, index) => ({
  path: `esm/dot-${index}/${name}`,
  specifier: `./dot-${index}/${name}`,
}));

const fixture = async () => {
  const root = await createTestTempDirectory("rea-bom-hashbang-");
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ type: "commonjs", main: "module.mjs" }),
    "module.mjs":
      '\uFEFF#!/usr/bin/env node\nconst face="😀"; import {marker} from "./dep.mjs"; console.log(JSON.stringify({marker}));',
    "esm/package.json": JSON.stringify({ type: "module" }),
    "esm/main.js":
      '\uFEFF#!/usr/bin/env node\r\nconst face="😀"; import {marker} from "../dep.mjs"; console.log(JSON.stringify({marker}));',
    "esm/.js":
      '\uFEFF#!/usr/bin/env node\nimport {marker} from "../dep.mjs"; console.log(JSON.stringify({marker}));',
    "esm/.mjs":
      '\uFEFF#!/usr/bin/env node\nimport {marker} from "../dep.mjs"; console.log(JSON.stringify({marker}));',
    "view.jsx":
      '\uFEFF#!/usr/bin/env node\nconst element = <div/>; import "./dep.mjs";',
    "typed.mts":
      '\uFEFF#!/usr/bin/env node\nconst face: string="😀"; import {marker} from "./dep.mjs"; console.log(JSON.stringify({marker}));',
    "typed.cts":
      '\uFEFF#!/usr/bin/env node\nconst face: string="😀"; const {marker}=require("./dep.cjs"); console.log(JSON.stringify({marker}));',
    "rejected.cjs":
      '\uFEFF#!/usr/bin/env node\nconst {marker}=require("./dep.cjs"); console.log(JSON.stringify({marker}));',
    "rejected.js":
      '\uFEFF#!/usr/bin/env node\nconst {marker}=require("./dep.cjs"); console.log(JSON.stringify({marker}));',
    ".cjs":
      '\uFEFF#!/usr/bin/env node\nwith ({}) {} const {marker}=require("./dep.cjs"); console.log(JSON.stringify({marker}));',
    "invoke-commonjs.mjs":
      'const print = console.log; console.log = () => {}; await import("./rejected.cjs"); await import("./rejected.js"); await import("./.cjs"); print(JSON.stringify({loaded:true}));',
    "plain.cjs":
      '#!/usr/bin/env node\nconst {marker}=require("./dep.cjs"); console.log(JSON.stringify({marker}));',
    "dep.mjs": "export const marker=42;",
    "dep.cjs": "exports.marker=42;",
    ...Object.fromEntries(
      importedDotfiles.map(({ path }) => [
        path,
        '\uFEFF#!/usr/bin/env node\r\nconst face="😀"; import {marker} from "../../dep.mjs"; export {marker};',
      ]),
    ),
    "esm/invoke.mjs": `const modules = await Promise.all([${importedDotfiles.map(({ specifier }) => `import(${JSON.stringify(specifier)})`).join(",")}]); console.log(JSON.stringify(modules.map(({marker}) => marker)));`,
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
      "esm/.js",
      "esm/.mjs",
      "typed.mts",
      "typed.cts",
      "plain.cjs",
    ])
      expect(await runNodeJsonControl(root, path)).toEqual({ marker: 42 });
    for (const path of ["rejected.cjs", "rejected.js", ".cjs"])
      await expect(runNodeJsonControl(root, path)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("SyntaxError"),
      });
    expect(await runNodeJsonControl(root, "invoke-commonjs.mjs")).toEqual({
      loaded: true,
    });
    expect(await runNodeJsonControl(root, "esm/invoke.mjs")).toEqual(
      importedDotfiles.map(() => 42),
    );
    await expect(
      runNodeJsonControl(root, "esm/dot-0/.cjs"),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("SyntaxError"),
    });
    const { graph, statistics } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      root,
    );
    expect(statistics.parse_failures).toBe(0);
    for (const [path, kind, target] of [
      ["module.mjs", "static-import", "dep.mjs"],
      ["esm/main.js", "static-import", "dep.mjs"],
      ["esm/.js", "static-import", "dep.mjs"],
      ["esm/.mjs", "static-import", "dep.mjs"],
      ["view.jsx", "static-import", "dep.mjs"],
      ["typed.mts", "static-import", "dep.mjs"],
      ["typed.cts", "require", "dep.cjs"],
      ["plain.cjs", "require", "dep.cjs"],
      ["rejected.cjs", "require", "dep.cjs"],
      ["rejected.js", "require", "dep.cjs"],
      [".cjs", "require", "dep.cjs"],
      ...importedDotfiles.map(
        ({ path }) => [path, "static-import", "dep.mjs"] as const,
      ),
    ] as const) {
      const source = files[path]!;
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
      if (
        path === "rejected.cjs" ||
        path === "rejected.js" ||
        path === ".cjs"
      ) {
        expect(edges[0]?.evidence).toMatchObject({
          coverage: { status: "partial" },
          limitations: expect.arrayContaining([
            expect.stringContaining("imported through the ES module loader"),
          ]),
        });
      }

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
    const dotfile = graph.nodes
      .flatMap(({ observations }) => observations)
      .find(
        ({ properties }) =>
          properties.path === "esm/dot-0/.cjs" &&
          properties.text_status !== undefined,
      );
    expect(dotfile).toMatchObject({
      properties: {
        parse_status: "partial",
        analysis_coverage: {
          syntax: { status: "complete", error_count: 0 },
          semantics: { uncertainty: ["conditional-loader"] },
        },
      },
      evidence: {
        limitations: expect.arrayContaining([
          expect.stringContaining("loader invocation is unknown"),
        ]),
      },
    });
    for (const path of ["rejected.cjs", "rejected.js", ".cjs"]) {
      expect(
        graph.nodes.flatMap(({ observations }) => observations),
      ).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({
            path,
            parse_status: "partial",
            analysis_coverage: expect.objectContaining({
              semantics: expect.objectContaining({
                uncertainty: ["conditional-loader"],
              }),
            }),
          }),
        }),
      );
    }
  },
);

cliTest.runIf(process.platform !== "win32")(
  "reference import retains conditional CommonJS BOM/hashbang dependencies",
  async ({ cli }) => {
    const { root, files } = await fixture();
    const output = await cli.run({
      arguments: ["import-reference-source", root, "--json"],
    });
    const subtree = join(root, "esm", "src");
    await writeFixtureFiles(subtree, {
      "main.js": '\uFEFF#!/usr/bin/env node\nimport "./dep.mjs";',
      "dep.mjs": "export const marker=42;",
    });
    const narrowed = await cli.run({
      arguments: ["import-reference-source", subtree, "--json"],
    });
    expect(narrowed.exitCode, narrowed.stderr).toBe(0);
    const partial = historicalSourceGraphSchema.parse(narrowed.json);
    expect(partial.parse_failures).toEqual([]);
    expect(partial.relationships).toContainEqual(
      expect.objectContaining({
        from_path: "main.js",
        to: "dep.mjs",
        kind: "imports",
        parse_state: "partial",
        resolution: "internal",
      }),
    );
    expect(partial.limitations).toContainEqual(
      expect.stringContaining("package loader mode is unknown"),
    );
    expect(output.exitCode, output.stderr).toBe(0);
    const graph = historicalSourceGraphSchema.parse(output.json);
    expect(
      graph.parse_failures
        .map(({ path }) => path)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([]);
    for (const [path, parseState] of [
      ["module.mjs", "parsed"],
      ["esm/main.js", "parsed"],
      ["esm/.js", "partial"],
      ["esm/.mjs", "partial"],
      ["view.jsx", "parsed"],
      ["typed.mts", "parsed"],
      ...importedDotfiles.map(({ path }) => [path, "partial"] as const),
    ] as const) {
      expect(graph.entries).toContainEqual(
        expect.objectContaining({
          path,
          sha256: createHash("sha256").update(files[path]!).digest("hex"),
        }),
      );
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from_path: path,
          to: "dep.mjs",
          kind: "imports",
          parse_state: parseState,
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
    for (const path of ["rejected.cjs", "rejected.js", ".cjs"]) {
      expect(graph.relationships).toContainEqual(
        expect.objectContaining({
          from_path: path,
          to: "dep.cjs",
          kind: "requires",
          parse_state: "partial",
          resolution: "internal",
        }),
      );
    }
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains conditional BOM/hashbang imports when analyzing a package subtree through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-bom-subtree-");
    const source =
      '\uFEFF#!/usr/bin/env node\r\nconst face="😀"; import {marker} from "./dep.mjs"; console.log(JSON.stringify({marker}));';
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({ type: "module" }),
      "src/main.js": source,
      "src/dep.mjs": "export const marker=42;",
    });
    expect(await runNodeJsonControl(root, "src/main.js")).toEqual({
      marker: 42,
    });
    const result = await analyzeJavaScriptDirectory(
      surface,
      cli,
      join(root, "src"),
    );
    expect(result.statistics.parse_failures).toBe(0);
    const properties = result.graph.nodes
      .flatMap(({ observations }) =>
        observations.map(({ properties }) => properties),
      )
      .find(
        (properties) =>
          properties.path === "main.js" && properties.text_status !== undefined,
      );
    expect(properties).toMatchObject({
      parse_status: "partial",
      analysis_coverage: {
        syntax: { status: "complete", error_count: 0 },
        semantics: { uncertainty: ["conditional-loader"] },
      },
    });
    const edge = result.graph.edges.find(
      ({ relation, properties, evidence }) =>
        relation === "imports" &&
        properties.kind === "static-import" &&
        evidence.location.available &&
        evidence.location.value.kind === "source-range" &&
        evidence.location.value.source === "main.js",
    );
    expect(edge).toMatchObject({
      properties: { kind: "static-import", resolved_path: "dep.mjs" },
      evidence: {
        artifact: {
          available: true,
          sha256: createHash("sha256").update(source).digest("hex"),
        },
        location: {
          available: true,
          value: {
            kind: "source-range",
            source: "main.js",
            start: { line: 2, column: 17 },
            end: { line: 2, column: 50 },
          },
        },
      },
    });
    const sourceObservation = result.graph.nodes
      .flatMap(({ observations }) => observations)
      .find(
        ({ properties }) =>
          properties.path === "main.js" && properties.text_status !== undefined,
      );
    expect(sourceObservation?.evidence.limitations).toContainEqual(
      expect.stringContaining("package loader mode is unknown"),
    );
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains conditional loader evidence on worker references through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-bom-worker-");
    const source =
      '\uFEFF#!/usr/bin/env node\nnew Worker(new URL("./worker.js", import.meta.url));\nnavigator.serviceWorker.register(new URL("./worker.js", import.meta.url));';
    await writeFixtureFiles(root, {
      "main.js": source,
      "worker.js": "export {};",
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const workerIds = new Set(
      graph.nodes
        .filter(({ kind }) => kind === "worker" || kind === "service-worker")
        .map(({ node_id }) => node_id),
    );
    const workers = graph.nodes.filter(({ node_id }) => workerIds.has(node_id));
    expect(workers.map(({ kind }) => kind).sort()).toEqual([
      "service-worker",
      "worker",
    ]);
    const loads = graph.edges.filter(
      ({ relation, target_node_id }) =>
        relation === "loads" && workerIds.has(target_node_id),
    );
    const mappings = graph.edges.filter(
      ({ relation, source_node_id }) =>
        relation === "maps_to" && workerIds.has(source_node_id),
    );
    expect(loads).toHaveLength(2);
    expect(mappings).toHaveLength(2);
    for (const { evidence } of [
      ...workers.flatMap(({ observations }) => observations),
      ...loads,
      ...mappings,
    ]) {
      expect(evidence).toMatchObject({
        confidence: "medium",
        coverage: { status: "partial" },
        artifact: {
          available: true,
          sha256: createHash("sha256").update(source).digest("hex"),
        },
        limitations: expect.arrayContaining([
          expect.stringContaining("package loader mode is unknown"),
        ]),
      });
    }
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains loader evidence for compiler dotfiles and semantic calls through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-bom-semantic-");
    const callSource =
      'function marker(value) { return value; } marker(42); fetch("https://example.test");';
    await writeFixtureFiles(root, {
      "package.json": '{"type":"commonjs"}',
      ".jsx": '\uFEFF#!/usr/bin/env node\nimport("./dep.mjs");',
      ".tsx": '\uFEFF#!/usr/bin/env node\nimport("./dep.mjs");',
      "main.cjs": `\uFEFF#!/usr/bin/env node\n${callSource}`,
      "plain.cjs": callSource,
      "dep.mjs": "export {};",
    });
    const { graph, semantic_graph: semantic } =
      await analyzeJavaScriptDirectory(surface, cli, root);
    for (const path of [".jsx", ".tsx"]) {
      const edge = graph.edges.find(
        ({ relation, evidence }) =>
          relation === "imports" &&
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === path,
      );
      expect.soft(edge?.evidence).toMatchObject({
        coverage: { status: "partial" },
        confidence: "medium",
        limitations: expect.arrayContaining([
          expect.stringContaining("BOM/hashbang"),
        ]),
      });
    }
    for (const path of ["main.cjs", "plain.cjs"]) {
      const atSource = ({
        evidence,
      }: {
        evidence: (typeof graph.edges)[number]["evidence"];
      }) =>
        evidence.location.available &&
        evidence.location.value.kind === "source-range" &&
        evidence.location.value.source === path;
      const endpoint = graph.nodes.find(
        ({ kind, observations }) =>
          kind === "endpoint" && observations.some(atSource),
      );
      const observation = endpoint?.observations.find(atSource);
      const edge = graph.edges.find(
        (edge) =>
          edge.relation === "calls" &&
          edge.target_node_id === endpoint?.node_id &&
          atSource(edge),
      );
      expect(observation).toBeDefined();
      expect(edge).toBeDefined();
      if (path === "main.cjs") {
        for (const fact of [observation, edge])
          expect.soft(fact?.evidence).toMatchObject({
            coverage: { status: "partial" },
            confidence: "medium",
            limitations: expect.arrayContaining([
              expect.stringContaining("BOM/hashbang"),
            ]),
          });
      } else {
        expect.soft(edge?.evidence).toMatchObject({
          confidence: "high",
          coverage: { status: "complete" },
        });
        expect
          .soft(observation?.evidence.limitations)
          .not.toContainEqual(expect.stringContaining("BOM/hashbang"));
      }
    }
    for (const { path, status } of [
      { path: "main.cjs", status: "partial" },
      { path: "plain.cjs", status: "complete" },
    ]) {
      const relations = semantic.relations.filter(
        ({ evidence }) =>
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === path,
      );
      expect(relations.length).toBeGreaterThan(0);
      for (const { evidence } of relations) {
        const context = semantic.evidence_contexts.find(
          ({ context_id }) => context_id === evidence.context_id,
        );
        expect.soft(context?.coverage.status).toBe(status);
        if (status === "partial")
          expect
            .soft(context?.limitations)
            .toContainEqual(expect.stringContaining("BOM/hashbang"));
      }
    }
  },
);
