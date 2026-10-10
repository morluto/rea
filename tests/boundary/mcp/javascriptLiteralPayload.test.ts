import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { javaScriptSemanticTraceResultSchema } from "../../../src/domain/javascript/javascriptSemanticTraceSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "delivers complete large literals through CLI and default stdio MCP without metadata copies",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-literal-payload-");
    const value = 'rea_literal_payload_ğ\\"\0'.padEnd(24, "x").repeat(65_536);
    const source = [
      `export const payload = ${JSON.stringify(value)};`,
      'export const choice = flag ? 1 : "1";',
      'export const empty = "";',
    ].join("\n");
    await writeFile(join(root, "main.js"), source);
    const cliResponse = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--artifact-format",
        "directory",
        "--json",
      ],
      timeoutMs: 60_000,
    });
    expect(cliResponse.exitCode).toBe(0);
    const cliEvidence = toolContract(
      "analyze_javascript_application",
    ).outputSchema.parse(cliResponse.json);

    const client = new Client({ name: "literal-payload-e2e", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport);
      const response = await client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: root, format: "directory" },
      });
      // The old payload-bearing role key/label exceed the default wire budget.
      expect(response.isError).not.toBe(true);
      const evidence = toolContract(
        "analyze_javascript_application",
      ).outputSchema.parse(response.structuredContent);
      expect(evidence.evidence_id).toBe(cliEvidence.evidence_id);
      const text = response.content.find((item) => item.type === "text");
      if (text?.type !== "text") throw new Error("Missing MCP text result");
      const textEvidence = toolContract(
        "analyze_javascript_application",
      ).outputSchema.parse(JSON.parse(text.text));
      expect(textEvidence.evidence_id).toBe(evidence.evidence_id);
      const graph = javascriptApplicationAnalysisResultSchema.parse(
        evidence.normalized_result,
      ).semantic_graph;
      const literal = graph.nodes.find(
        (node) => node.kind === "literal" && node.properties.value === value,
      );
      if (literal === undefined) throw new Error("Complete literal was lost");
      const sourceSha256 = createHash("sha256").update(source).digest("hex");
      expect(literal.identity).toMatchObject({
        module_path: "main.js",
        artifact_sha256: sourceSha256,
      });
      expect(literal.evidence.location).toMatchObject({
        available: true,
        value: { kind: "source-range", source: "main.js" },
      });
      const choices = graph.nodes.filter(
        (node) =>
          node.kind === "literal" &&
          (node.properties.value === 1 || node.properties.value === "1"),
      );
      expect(choices.length).toBe(2);
      expect(new Set(choices.map((node) => node.node_id)).size).toBe(2);
      expect(
        graph.nodes.some(
          (node) => node.kind === "literal" && node.properties.value === "",
        ),
      ).toBe(true);

      const traceResponse = await client.callTool({
        name: "trace_javascript_semantics",
        arguments: {
          application: {
            kind: "retained-evidence",
            evidence_id: evidence.evidence_id,
          },
          query: {
            seed: { kind: "semantic-node", node_id: literal.node_id },
            direction: "backward-provenance",
          },
        },
      });
      expect(traceResponse.isError).not.toBe(true);
      const traceEvidence = toolContract(
        "trace_javascript_semantics",
      ).outputSchema.parse(traceResponse.structuredContent);
      const trace = javaScriptSemanticTraceResultSchema.parse(
        traceEvidence.normalized_result,
      );
      expect(
        trace.nodes.some(
          (node) =>
            node.node_id === literal.node_id && node.properties.value === value,
        ),
      ).toBe(true);
      const valueTraceResponse = await client.callTool({
        name: "trace_javascript_semantics",
        arguments: {
          application: {
            kind: "retained-evidence",
            evidence_id: evidence.evidence_id,
          },
          query: {
            seed: { kind: "literal", value: "1" },
            direction: "backward-provenance",
          },
        },
      });
      expect(valueTraceResponse.isError).not.toBe(true);
      const valueTraceEvidence = toolContract(
        "trace_javascript_semantics",
      ).outputSchema.parse(valueTraceResponse.structuredContent);
      const valueTrace = javaScriptSemanticTraceResultSchema.parse(
        valueTraceEvidence.normalized_result,
      );
      expect(valueTrace.seed_node_ids).toEqual(
        choices
          .filter((node) => node.properties.value === "1")
          .map((node) => node.node_id),
      );
      await client.ping();
    } finally {
      await client.close();
      await transport.close();
    }
  },
  60_000,
);
