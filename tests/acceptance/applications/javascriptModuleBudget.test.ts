import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { SEMANTIC_MODULE_SOURCE_BYTES_LIMIT } from "../../../src/domain/javascript/javascriptSemanticResourceLimits.js";
import { javaScriptSemanticTraceResultSchema } from "../../../src/domain/javascript/javascriptSemanticTraceSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const limit = {
  name: "javascript_semantic_module_source_bytes",
  value: SEMANTIC_MODULE_SOURCE_BYTES_LIMIT,
  unit: "bytes",
};

const assertAnalysis = (rawResult: unknown): void => {
  const result = javascriptApplicationAnalysisResultSchema.parse(rawResult);
  expect(result.graph.coverage.limits).toContainEqual(limit);
  expect(result.semantic_graph.coverage).toMatchObject({
    status: "partial",
    truncated: true,
    omitted_nodes: null,
    omitted_relations: null,
    limits: [limit],
  });
  expect(
    result.semantic_graph.coverage.families.every(
      (family) =>
        family.omitted_relations === null && family.unknown_ids.length > 0,
    ),
  ).toBe(true);
  expect(result.semantic_graph.nodes).toContainEqual(
    expect.objectContaining({ kind: "binding", label: "answer" }),
  );
  expect(result.semantic_graph.nodes).not.toContainEqual(
    expect.objectContaining({ kind: "binding", label: "skipped" }),
  );
  expect(result.graph.nodes).toContainEqual(
    expect.objectContaining({
      kind: "endpoint",
      identity: expect.objectContaining({ key: "/skipped" }),
    }),
  );
};

const assertTrace = (rawResult: unknown, oversized: string): void => {
  const trace = javaScriptSemanticTraceResultSchema.parse(rawResult);
  expect(trace.status).toBe("partial");
  expect(trace.seed_node_ids).toEqual([]);
  expect(trace.coverage.status).toBe("partial");
  expect(trace.limitations).toContainEqual(expect.stringContaining("2097152"));
  expect(trace.unknowns).toContainEqual(
    expect.objectContaining({
      family: "request",
      reason: "resource-limit",
      node_id: null,
      detail: expect.stringContaining("oversized.js"),
      evidence: expect.objectContaining({
        location: {
          available: true,
          value: { kind: "artifact-path", path: "oversized.js" },
        },
      }),
    }),
  );
  expect(trace.evidence_contexts).toContainEqual(
    expect.objectContaining({
      artifact: expect.objectContaining({
        sha256: createHash("sha256").update(oversized).digest("hex"),
      }),
      coverage: expect.objectContaining({
        status: "partial",
        omitted_count: null,
        limits: [limit],
      }),
    }),
  );
};

cliTest(
  "preserves skipped module coverage through CLI and MCP semantic traces",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-module-budget-");
    const oversized = `/*${"a".repeat(SEMANTIC_MODULE_SOURCE_BYTES_LIMIT)}*/\nexport const skipped = 41; fetch("/skipped");`;
    await writeFile(join(root, "oversized.js"), oversized);
    await writeFile(
      join(root, "app.js"),
      'export const answer = 42; fetch("/regular");',
    );
    const query = {
      seed: { kind: "endpoint", value: "/skipped" },
      direction: "backward-provenance",
      allowed_relations: ["constructs-request"],
    };
    const analysisContract = toolContract("analyze_javascript_application");
    const traceContract = toolContract("trace_javascript_semantics");
    const cliAnalysis = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--artifact-format",
        "directory",
        "--json",
      ],
      environment: { NODE_OPTIONS: "--max-old-space-size=768" },
    });
    expect(cliAnalysis.exitCode).toBe(0);
    const cliEvidence = analysisContract.outputSchema.parse(cliAnalysis.json);
    const cliTrace = await cli.run({
      arguments: [
        "trace-javascript-semantics",
        JSON.stringify({ application: cliEvidence, query }),
        "--json",
      ],
    });
    expect(cliTrace.exitCode).toBe(0);
    const cliTraceEvidence = traceContract.outputSchema.parse(cliTrace.json);

    const client = new Client({
      name: "module-budget-acceptance",
      version: "1",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        NODE_OPTIONS: "--max-old-space-size=768",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport);
      const response = await client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: root, format: "directory" },
      });
      expect(response.isError).not.toBe(true);
      const mcpEvidence = analysisContract.outputSchema.parse(
        response.structuredContent,
      );
      expect(mcpEvidence.evidence_id).toBe(cliEvidence.evidence_id);
      const traceResponse = await client.callTool({
        name: "trace_javascript_semantics",
        arguments: { application: mcpEvidence, query },
      });
      expect(traceResponse.isError).not.toBe(true);
      const mcpTraceEvidence = traceContract.outputSchema.parse(
        traceResponse.structuredContent,
      );
      expect(mcpTraceEvidence.evidence_id).toBe(cliTraceEvidence.evidence_id);

      for (const evidence of [cliEvidence, mcpEvidence])
        assertAnalysis(evidence.normalized_result);
      for (const evidence of [cliTraceEvidence, mcpTraceEvidence])
        assertTrace(evidence.normalized_result, oversized);
      await client.ping();
      const regularRoot = await createTestTempDirectory(
        "rea-module-budget-small-",
      );
      await writeFile(join(regularRoot, "app.js"), "export const answer = 42;");
      const regularResponse = await client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: regularRoot, format: "directory" },
      });
      expect(regularResponse.isError).not.toBe(true);
      const regular = javascriptApplicationAnalysisResultSchema.parse(
        analysisContract.outputSchema.parse(regularResponse.structuredContent)
          .normalized_result,
      );
      expect(regular.semantic_graph.coverage).toMatchObject({
        truncated: false,
        omitted_nodes: 0,
        omitted_relations: 0,
        limits: [],
      });
      expect(regular.semantic_graph.unknowns).not.toContainEqual(
        expect.objectContaining({ reason: "resource-limit" }),
      );
    } finally {
      await client.close();
    }
  },
);
