import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  findExportNode,
  findGraphEdge,
  findSourceModule,
  writeFixtureFiles,
} from "../../support/javascriptApplicationFixture.js";

cliTest(
  "returns literal self-import evidence while preserving sibling imports and self-re-exports",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-self-import-");
    await writeFixtureFiles(root, {
      "a.js":
        'import "./a.js";\nexport const value = 1;\nexport { value as forwarded } from "./a.js";\n',
      "b.js": 'import { value } from "./a.js";\nconsole.log(value);\n',
    });
    const output = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
    });
    expect(output.exitCode).toBe(0);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(output.json).normalized_result,
    );
    const { graph } = result;
    expect(
      graph.edges.filter((edge) => edge.source_node_id === edge.target_node_id),
    ).toEqual([]);
    expect(graph.limitations).toContainEqual(
      expect.stringMatching(/^1 import specifier .*was omitted;/u),
    );
    expect(result.limitations).toEqual(
      expect.arrayContaining(graph.limitations),
    );
    const source = findSourceModule(graph, "a.js");
    expect(source).toBeDefined();
    expect(
      findGraphEdge(graph, findSourceModule(graph, "b.js"), source, "imports")
        ?.properties,
    ).toMatchObject({
      specifier: "./a.js",
      resolution_status: "resolved",
    });
    expect(
      findGraphEdge(
        graph,
        findExportNode(graph, "a.js", "forwarded"),
        source,
        "imports",
      )?.properties,
    ).toMatchObject({
      specifier: "./a.js",
      resolution_status: "resolved",
    });
    expect(
      graph.edges.find(
        (edge) =>
          edge.source_node_id === source?.node_id &&
          edge.properties.kind === "static-import" &&
          edge.properties.specifier === "./a.js" &&
          edge.evidence.location.available &&
          edge.evidence.location.value.kind === "source-range" &&
          edge.evidence.location.value.start.line === 1,
      )?.evidence.location,
    ).toMatchObject({
      available: true,
      value: { kind: "source-range", source: "a.js", start: { line: 1 } },
    });
  },
);

cliTest(
  "discloses CommonJS and TypeScript self-imports while retaining unresolved extension rewrites",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-self-require-");
    await writeFixtureFiles(root, {
      "c.cjs": 'const self = require("./c.cjs");\nmodule.exports = self;\n',
      "util.ts":
        'import "./util.ts";\nimport "./util.js";\nexport const value = 1;\n',
    });
    const output = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
    });
    expect(output.exitCode).toBe(0);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(output.json).normalized_result,
    );
    const { graph } = result;
    expect(
      graph.edges.filter((edge) => edge.source_node_id === edge.target_node_id),
    ).toEqual([]);
    expect(graph.limitations).toContainEqual(
      expect.stringMatching(/^2 import specifiers .*were omitted;/u),
    );
    expect(result.limitations).toEqual(
      expect.arrayContaining(graph.limitations),
    );
    for (const [path, specifier] of [
      ["c.cjs", "./c.cjs"],
      ["util.ts", "./util.ts"],
    ] as const) {
      const source = findSourceModule(graph, path);
      expect(source).toBeDefined();
      expect(
        graph.edges.find(
          (edge) =>
            edge.source_node_id === source?.node_id &&
            edge.properties.specifier === specifier &&
            edge.properties.resolved_path === path,
        )?.evidence.location,
      ).toMatchObject({
        available: true,
        value: { kind: "source-range", source: path, start: { line: 1 } },
      });
      expect(
        graph.nodes.some((node) =>
          node.observations.some(
            ({ properties }) =>
              properties.semantic_role === "module-reference" &&
              properties.declared_specifier === specifier,
          ),
        ),
      ).toBe(false);
    }
    expect(
      graph.edges.find(
        (edge) =>
          edge.source_node_id === findSourceModule(graph, "util.ts")?.node_id &&
          edge.properties.specifier === "./util.js" &&
          edge.properties.module_link_kind === "import",
      )?.properties,
    ).toMatchObject({ resolved_path: null, resolution_status: "not-found" });
  },
);
