import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "retains earlier property dependencies through analysis and default tracing",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-js-destructuring-evidence-",
    );
    await writeFile(
      join(root, "main.js"),
      `
    const src = { a: 1 };
    const { a: declared } = src;
    let a;
    ({ a } = src);
    const direct = src.a;
    src.a = 2;
    const nested = { a: [1], b: 2 };
    const { a: [plain] } = nested;
    const { a: [fallback] = [] } = nested;
    const { b: scalar = 0 } = nested;
  `,
    );
    const output = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
    });
    expect(output.exitCode).toBe(0);
    const { normalized_result: result } = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(output.json);
    const graph = result.semantic_graph;
    for (const [name, path] of [
      ["declared", ["a"]],
      ["a", ["a"]],
      ["plain", ["a", "0"]],
      ["fallback", ["a", "0"]],
      ["scalar", ["b"]],
    ] as const) {
      const binding = graph.nodes.find(
        (node) => node.kind === "binding" && node.label === name,
      );
      expect(binding).toBeDefined();
      const relations = graph.relations.filter(
        (relation) =>
          relation.relation === "destructures" &&
          relation.target_node_id === binding?.node_id,
      );
      expect(relations).toHaveLength(1);
      expect(relations[0]?.resolution).toBe("resolved");
      expect(
        graph.nodes.find(
          (node) => node.node_id === relations[0]?.source_node_id,
        )?.properties.property_path,
      ).toEqual(path);
    }
    expect(
      graph.relations.find(({ relation }) => relation === "reads-property"),
    ).toMatchObject({ resolution: "resolved" });
    const declared = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "declared",
    );
    const queryPath = join(root, "query.json");
    await writeFile(
      queryPath,
      JSON.stringify({
        application: output.json,
        query: {
          seed: { kind: "semantic-node", node_id: declared?.node_id },
          direction: "backward-provenance",
        },
      }),
    );
    const trace = await cli.run({
      arguments: ["trace-javascript-semantics", queryPath, "--json"],
    });
    expect(trace.exitCode, trace.stderr).toBe(0);
    expect(trace.json).toMatchObject({
      normalized_result: {
        relations: expect.arrayContaining([
          expect.objectContaining({
            relation: "destructures",
            resolution: "resolved",
          }),
        ]),
      },
    });
  },
);
