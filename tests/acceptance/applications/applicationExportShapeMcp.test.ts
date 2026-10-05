import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { analyzeJavaScriptApplication } from "../../../src/application/JavaScriptApplicationService.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascriptApplicationAnalysis.js";

describe("application workflow MCP parity", () => {
  it("compares exact parser export shapes with inline Evidence", async () => {
    const root = await createTestTempDirectory("rea-export-shape-mcp-");
    const leftRoot = join(root, "left");
    const rightRoot = join(root, "right");
    await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
    await Promise.all([
      copyFile(
        resolve("tests/fixtures/replay/parser.mjs"),
        join(leftRoot, "parser.mjs"),
      ),
      copyFile(
        resolve("tests/fixtures/replay/parser-v2.mjs"),
        join(rightRoot, "parser.mjs"),
      ),
    ]);
    const [left, right] = await Promise.all([
      analyzeJavaScriptApplication({
        input_path: leftRoot,
      }),
      analyzeJavaScriptApplication({
        input_path: rightRoot,
      }),
    ]);
    if (!left.ok) throw left.error;
    if (!right.ok) throw right.error;
    const leftAnalysis = javascriptApplicationAnalysisResultSchema.parse(
      left.value.normalized_result,
    );
    const session = createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session);
    const client = new Client({ name: "export-shape-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const selectors = {
      left_module_path: "parser.mjs",
      left_export_name: "default",
      right_module_path: "parser.mjs",
      right_export_name: "default",
    };
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const relativeApplication = await client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: relative(process.cwd(), leftRoot) },
      });
      expect(relativeApplication.isError).not.toBe(true);
      expect(relativeApplication.structuredContent).toMatchObject({
        evidence_id: left.value.evidence_id,
        result: { input_path: leftAnalysis.input_path },
        evidence: {
          subject: { local_path: left.value.subject?.local_path },
        },
      });
      const full = await client.callTool({
        name: "compare_javascript_export_shapes",
        arguments: { left: left.value, right: right.value, ...selectors },
      });
      expect(full.isError).not.toBe(true);
      expect(full.structuredContent).toMatchObject({
        result: {
          summary: { added: 1, removed: 0, changed: 0, unknown: 0 },
          changes: [
            {
              status: "added",
              path: "/depth",
              right: { availability: "literal", value: 1 },
            },
          ],
        },
      });
      expect(session.exportEvidenceBundle().records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "compare_javascript_export_shapes",
            predicate_type: "rea.javascript-export-shape-comparison",
          }),
        ]),
      );

      const analyzed = javascriptApplicationAnalysisResultSchema.parse(
        left.value.normalized_result,
      );
      const seed = analyzed.semantic_graph.relations[0]?.source_node_id;
      if (seed === undefined)
        throw new TypeError("Expected at least one semantic relation");
      const semantic = await client.callTool({
        name: "trace_javascript_semantics",
        arguments: {
          application: left.value,
          query: {
            seed: { kind: "semantic-node", node_id: seed },
            direction: "forward-influence",
            include_ambiguous_dynamic_edges: true,
          },
        },
      });
      expect(semantic.isError).not.toBe(true);
      expect(semantic.structuredContent).toMatchObject({
        result: {
          source_evidence_id: left.value.evidence_id,
          source_graph_id: analyzed.semantic_graph.graph_id,
          summary: { total_seed_matches: 1 },
        },
      });
    } finally {
      await client.close();
      await server.close();
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
