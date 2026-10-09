import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { javaScriptSemanticTraceResultSchema } from "../../../src/domain/javascript/javascriptSemanticTraceSchemas.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  {
    title: "deleting an absent slot",
    initializer: '{ kind: "r" }',
    mutation: "delete result.count;",
    uncertainPresence: true,
  },
  {
    title: "deleting an initialized slot",
    initializer: '{ kind: "r", count: 1 }',
    mutation: "delete result.count;",
    uncertainPresence: true,
  },
  {
    title: "assigning an absent slot",
    initializer: '{ kind: "r" }',
    mutation: "result.count = query();",
    uncertainPresence: true,
  },
  {
    title: "an unresolved value with known presence",
    initializer: '{ kind: "r", count: query() }',
    mutation: "",
    uncertainPresence: false,
  },
])(
  "respects property presence when tracing $title",
  async ({ initializer, mutation, uncertainPresence }) => {
    const root = await createTestTempDirectory("rea-mutation-presence-mcp-");
    await writeFile(
      join(root, "parser.mjs"),
      `export default function make() {
        const result = ${initializer};
        ${mutation}
        return result;
      }`,
    );
    const application = await analyzeJavaScriptApplication({
      input_path: root,
    });
    if (!application.ok) throw application.error;
    const graph = javascriptApplicationAnalysisResultSchema.parse(
      application.value.normalized_result,
    ).semantic_graph;
    const binding = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "result",
    );
    const uncertain = graph.nodes.find(
      ({ kind, properties }) =>
        kind === "property-slot" && properties.name === "count",
    );
    const known = graph.nodes.find(
      ({ kind, properties }) =>
        kind === "property-slot" && properties.name === "kind",
    );
    if (binding === undefined || uncertain === undefined || known === undefined)
      throw new Error("Expected binding and both property slots");

    const { client, close } = await createApplicationMcpHarness();
    onTestFinished(close);
    for (const includeCandidates of [false, true]) {
      const response = await client.callTool({
        name: "trace_javascript_semantics",
        arguments: {
          application: application.value,
          query: {
            seed: { kind: "semantic-node", node_id: binding.node_id },
            direction: "forward-influence",
            allowed_relations: ["writes-property"],
            include_ambiguous_dynamic_edges: includeCandidates,
          },
        },
      });
      expect(response.isError).not.toBe(true);
      const { result } = z
        .object({ result: javaScriptSemanticTraceResultSchema })
        .parse(response.structuredContent);
      const nodeIds = result.nodes.map(({ node_id }) => node_id);
      expect(nodeIds).toContain(known.node_id);
      expect(nodeIds.includes(uncertain.node_id)).toBe(
        includeCandidates || !uncertainPresence,
      );
      expect(result.relations).toContainEqual(
        expect.objectContaining({
          source_node_id: binding.node_id,
          target_node_id: known.node_id,
          relation: "writes-property",
          resolution: "resolved",
        }),
      );
      if (includeCandidates || !uncertainPresence)
        expect(result.relations).toContainEqual(
          expect.objectContaining({
            source_node_id: binding.node_id,
            target_node_id: uncertain.node_id,
            relation: "writes-property",
            resolution: uncertainPresence ? "candidate" : "resolved",
          }),
        );
    }
  },
);
