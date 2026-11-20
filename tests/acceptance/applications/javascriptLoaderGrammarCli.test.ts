import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect } from "vitest";

import { historicalSourceGraphSchema } from "../../../src/domain/referenceSourceGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const wrapper =
  'void new.target; var await = 1; with ({value: 1}) { void value; } require("./dep.cjs"); return;';
const moduleReturn = 'import {marker} from "./dep.mjs"; return marker;';
const fixture = async () => {
  const root = await createTestTempDirectory("rea-loader-grammar-");
  const files = {
    "package.json": '{"type":"commonjs","main":"main.js"}',
    "main.js": wrapper,
    "valid.ts": 'var await = 1; require("./dep.cjs");',
    "native.cts": 'void new.target; require("./dep.cjs");',
    "native.ts": 'void new.target; require("./dep.cjs");',
    "collision.cjs": 'const module=1; require("./dep.cjs"); return;',
    "dep.cjs": "exports.marker=1;",
    "dep.mjs": "export const marker=1;",
    "explicit.mjs": moduleReturn,
    "explicit.mts": moduleReturn,
    "module/package.json": '{"type":"module"}',
    "module/main.js": moduleReturn,
    "module/dep.mjs": "export const marker=1;",
    "module/override.cjs": wrapper.replace("./dep.cjs", "../dep.cjs"),
    "unspecified/package.json": "{}",
    "unspecified/main.js": wrapper.replace("./dep.cjs", "../dep.cjs"),
    "unspecified/module.js": moduleReturn.replace("./dep.mjs", "../dep.mjs"),
    "unspecified/lexical.js":
      'const module=1; function read(){return require("../dep.cjs");}',
  };
  await writeFixtureFiles(root, files);
  return { root, files };
};

const accepted = [
  "main.js",
  "valid.ts",
  "module/override.cjs",
  "unspecified/main.js",
] as const;
const syntaxRecovery = [
  "explicit.mjs",
  "explicit.mts",
  "module/main.js",
  "unspecified/module.js",
  "native.cts",
  "native.ts",
] as const;
const rejected = [...syntaxRecovery, "collision.cjs"] as const;

cliTest.for(["CLI", "stdio MCP"] as const)(
  "uses observed loader grammar without contaminating source Evidence through %s",
  async (surface, { cli, processes }) => {
    const { root, files } = await fixture();
    for (const path of [...accepted, ...rejected]) {
      const checked = await processes.run(process.execPath, [join(root, path)]);
      expect(checked.exitCode, path).toBe(
        accepted.some((candidate) => candidate === path) ? 0 : 1,
      );
      if (rejected.some((candidate) => candidate === path))
        expect(checked.stderr, path).toContain("SyntaxError");
    }
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const observations = graph.nodes.flatMap(
      ({ observations }) => observations,
    );
    for (const path of accepted) {
      expect(observations, path).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({
            path,
            analysis_coverage: expect.objectContaining({
              syntax: { status: "complete", error_count: 0 },
            }),
          }),
        }),
      );
      expect(graph.edges, path).toContainEqual(
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            kind: "require",
            resolved_path: "dep.cjs",
          }),
          evidence: expect.objectContaining({
            artifact: expect.objectContaining({
              sha256: createHash("sha256").update(files[path]).digest("hex"),
            }),
            location: expect.objectContaining({
              value: expect.objectContaining({ source: path }),
            }),
          }),
        }),
      );
    }
    for (const path of syntaxRecovery)
      expect(observations, path).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({
            path,
            analysis_coverage: expect.objectContaining({
              syntax: { status: "recovered", error_count: 1 },
            }),
          }),
        }),
      );
    expect(observations, "collision.cjs").toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          path: "collision.cjs",
          analysis_coverage: expect.objectContaining({
            syntax: { status: "complete", error_count: 0 },
            semantics: expect.objectContaining({
              uncertainty: ["commonjs-wrapper-redeclaration"],
            }),
          }),
        }),
      }),
    );
  },
);

cliTest.runIf(process.platform !== "win32")(
  "reference import records module-only wrapper errors without losing recovered imports",
  async ({ cli }) => {
    const { root, files } = await fixture();
    const output = await cli.run({
      arguments: ["import-reference-source", root, "--json"],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const graph = historicalSourceGraphSchema.parse(output.json);
    expect(graph.entries).toContainEqual(
      expect.objectContaining({
        path: "collision.cjs",
        sha256: createHash("sha256")
          .update(files["collision.cjs"])
          .digest("hex"),
      }),
    );
    expect(
      graph.relationships.some(
        ({ from_path, kind }) =>
          from_path === "unspecified/lexical.js" && kind === "requires",
      ),
    ).toBe(false);
    expect(
      [...new Set(graph.parse_failures.map(({ path }) => path))].sort(),
    ).toEqual([...rejected].sort());
    expect(graph.parse_failures).toContainEqual(
      expect.objectContaining({
        path: "collision.cjs",
        parser: "rea-node-loader",
      }),
    );
    for (const path of accepted)
      expect(graph.relationships, path).toContainEqual(
        expect.objectContaining({
          from_path: path,
          to: "dep.cjs",
          kind: "requires",
          parse_state: "parsed",
          resolution: "internal",
        }),
      );
    for (const path of rejected)
      expect(graph.relationships, path).toContainEqual(
        expect.objectContaining({
          from_path: path,
          kind:
            path.endsWith(".ts") ||
            path.endsWith(".cts") ||
            path.endsWith(".cjs")
              ? "requires"
              : "imports",
          parse_state: "partial",
          resolution: "internal",
        }),
      );
  },
);

cliTest(
  "matches Node's lexical wrapper detection in CLI and stdio MCP dependency Evidence",
  async ({ cli, processes }) => {
    const root = await createTestTempDirectory("rea-lexical-loader-");
    const request =
      'function read(){return require("./dep.cjs");} console.log(JSON.stringify(typeof require));';
    const files = {
      "package.json": "{}",
      "main.js": `const module=1; ${request}`,
      "control.js": `var module; ${request}`,
      "function.js": `function module(){} ${request}`,
      "block.js": `{let module=1;} ${request}`,
      "dep.cjs": "exports.marker=1;",
    };
    await writeFixtureFiles(root, files);
    for (const [path, value] of [
      ["main.js", "undefined"],
      ["control.js", "function"],
      ["function.js", "function"],
      ["block.js", "function"],
    ] as const) {
      const control = await processes.run(process.execPath, [join(root, path)]);
      expect(control.exitCode, control.stderr).toBe(0);
      expect(JSON.parse(control.stdout)).toBe(value);
    }
    for (const surface of ["CLI", "stdio MCP"] as const) {
      const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
      const observations = graph.nodes.flatMap(
        ({ observations }) => observations,
      );
      for (const [path, format] of [
        ["control.js", "commonjs"],
        ["function.js", "commonjs"],
        ["block.js", "commonjs"],
      ] as const)
        expect(observations).toContainEqual(
          expect.objectContaining({
            properties: expect.objectContaining({
              path,
              module_format: format,
            }),
          }),
        );
      const detected = observations.find(
        ({ properties }) =>
          properties.path === "main.js" &&
          properties.semantic_role === "source-module",
      );
      // The graph's format label summarizes module links, so a source without
      // imports/exports may stay unknown; it must not claim CommonJS links.
      expect(["esm", "unknown"]).toContain(detected?.properties.module_format);
      expect(detected?.properties.source_sha256).toBe(
        createHash("sha256").update(files["main.js"]).digest("hex"),
      );
      const requests = graph.edges.filter(
        ({ relation, properties }) =>
          relation === "imports" && properties.specifier === "./dep.cjs",
      );
      expect(
        requests.some(
          ({ evidence }) =>
            evidence.location.available &&
            evidence.location.value.kind === "source-range" &&
            evidence.location.value.source === "main.js",
        ),
      ).toBe(false);
      expect(requests).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({ resolved_path: "dep.cjs" }),
          evidence: expect.objectContaining({
            artifact: expect.objectContaining({
              sha256: createHash("sha256")
                .update(files["control.js"])
                .digest("hex"),
            }),
            location: expect.objectContaining({
              value: expect.objectContaining({ source: "control.js" }),
            }),
          }),
        }),
      );
    }
  },
);
