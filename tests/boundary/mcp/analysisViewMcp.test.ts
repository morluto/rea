import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { BinaryLayoutService } from "../../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "../../../src/domain/javascript/javascriptApplicationGraph.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  analysisViewJavaScriptEvidence,
  analysisViewJavaScriptAnalysisWithSource,
  analysisViewBindJavaScriptGraphs,
  analysisViewLayoutFixture,
} from "../../fixtures/analysisView.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { BINARY_LAYOUT_TEST_PROVIDER } from "../../fixtures/binaryDiagnostics/layout.js";

const connect = async (binaryLayout?: BinaryLayoutService) => {
  const session = createTestBinarySession(() => {
    throw new Error("selected views must not start a deep provider");
  });
  const server = createServer(
    session,
    session,
    binaryLayout === undefined ? {} : { binaryLayout },
  );
  const client = new Client({ name: "analysis-view-mcp", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, session };
};

it("advertises exact schemas and projects one layout section from retained Evidence", async () => {
  const layout = analysisViewLayoutFixture();
  const service = new BinaryLayoutService({
    identity: BINARY_LAYOUT_TEST_PROVIDER,
    inspect: () => Promise.resolve(ok(layout)),
  });
  const { client, session } = await connect(service);
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_analysis_view",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("inspect_analysis_view must publish both schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  expect(
    ajv.validate(inputSchema, {
      source: {
        kind: "retained-evidence",
        evidence_id: `ev_${"a".repeat(64)}`,
      },
      view: { kind: "summary", approval: true },
    }),
  ).toBe(false);
  const inspected = await client.callTool({
    name: "inspect_binary_layout",
    arguments: { path: layout.artifact.path },
  });
  expect(inspected.isError).not.toBe(true);
  const parent = toolContract("inspect_binary_layout").outputSchema.parse(
    inspected.structuredContent,
  );
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: parent.evidence_id,
      },
      view: {
        kind: "item",
        collection: "sections",
        selector: { name: ".data" },
      },
    },
  });
  expect(response.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, response.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const parsed = toolContract("inspect_analysis_view").outputSchema.parse(
    response.structuredContent,
  );
  expect(parsed.normalized_result).toMatchObject({
    kind: "item",
    parent_evidence_id: parent.evidence_id,
    item: { name: { display: ".data" } },
  });
  expect(session.evidenceById(parsed.evidence_id)).toEqual(
    parseEvidence(parsed),
  );
});

it("retains an oversized selected observation and keeps subsequent views usable", async () => {
  const { client, session } = await connect();
  const analysis = analysisViewJavaScriptAnalysisWithSource();
  const original = analysis.graph.nodes[0];
  if (original === undefined) throw new Error("missing module");
  const source = "\0".repeat(1_000_000);
  const node = createJavaScriptApplicationNode({
    kind: original.kind,
    identity: original.identity,
    observations: original.observations.map((observation) => ({
      label: observation.label,
      properties: { ...observation.properties, source },
      evidence: observation.evidence,
    })),
  });
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [node.node_id],
    nodes: [node],
    edges: [],
    coverage: analysis.graph.coverage,
    limitations: analysis.graph.limitations,
  });
  const parent = analysisViewJavaScriptEvidence(
    analysisViewBindJavaScriptGraphs(analysis, graph),
  );
  expect(session.recordEvidence(parent).ok).toBe(true);
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: {
        kind: "item",
        collection: "modules",
        selector: { node_id: node.node_id },
      },
    },
  });
  expect(response.isError).toBe(true);
  const reference = z
    .object({
      error: z.object({
        details: z.object({
          reported_limits: z.object({
            evidence_reference: z.object({
              kind: z.literal("retained-evidence"),
              evidence_id: z.string(),
            }),
          }),
        }),
      }),
    })
    .parse(response.structuredContent).error.details
    .reported_limits.evidence_reference;
  expect(
    session.evidenceById(reference.evidence_id)?.normalized_result,
  ).toMatchObject({
    item: {
      observations: [
        expect.objectContaining({
          properties: expect.objectContaining({ source }),
        }),
      ],
    },
  });
  await client.ping();
  const summary = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "summary" },
    },
  });
  expect(summary.isError).not.toBe(true);
});

it("returns a JavaScript summary without graph payloads from a retained reference", async () => {
  const { client, session } = await connect();
  const parent = analysisViewJavaScriptEvidence();
  expect(session.recordEvidence(parent).ok).toBe(true);
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: parent.evidence_id,
      },
      view: { kind: "summary" },
    },
  });
  expect(response.isError).not.toBe(true);
  const parsed = toolContract("inspect_analysis_view").outputSchema.parse(
    response.structuredContent,
  );
  expect(parsed.normalized_result).toMatchObject({
    kind: "summary",
    parent_operation: "analyze_javascript_application",
    summary: { format: "directory" },
  });
  expect(parsed.normalized_result).not.toHaveProperty("summary.semantic_graph");
  const stale = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: `ev_${"e".repeat(64)}`,
      },
      view: { kind: "summary" },
    },
  });
  expect(stale).toMatchObject({
    isError: true,
    structuredContent: {
      error: { details: { reason: "missing" } },
    },
  });
});

it("accepts a transport-constraint retained reference as the view source", async () => {
  const { client, session } = await connect();
  const parent = analysisViewJavaScriptEvidence();
  expect(session.recordEvidence(parent).ok).toBe(true);
  const evidenceReference = {
    kind: "retained-evidence" as const,
    evidence_id: parent.evidence_id,
  };
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: evidenceReference,
      view: {
        kind: "page",
        collection: "modules",
        offset: 0,
        limit: 8,
      },
    },
  });
  expect(response.isError).not.toBe(true);
  const parsed = toolContract("inspect_analysis_view").outputSchema.parse(
    response.structuredContent,
  );
  expect(parsed.normalized_result).toMatchObject({
    kind: "page",
    parent_evidence_id: parent.evidence_id,
    coverage: { exhausted: true },
  });
  if (parsed.normalized_result.kind !== "page")
    throw new Error("expected page view");
  expect(parsed.normalized_result.items).toEqual([
    {
      node_id: expect.any(String),
      kind: "javascript-asset",
      path: "renderer.js",
    },
  ]);
});
