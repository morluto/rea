import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { BinaryLayoutService } from "../../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { functionDossierSchema } from "../../../src/domain/hopperValues.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
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
    { kind: "session", session },
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

it("delivers a bounded native dossier view over MCP without a Ghidra provider or lost connection", async () => {
  const { client, session } = await connect();
  const original = functionDossierSchema.parse(ghidraFunctionDossier());
  const parent = createEvidence(
    {
      path: "/fixtures/oversized-native.exe",
      format: "pe",
      sha256: "b".repeat(64),
    },
    { id: "ghidra", name: "Ghidra", version: "12.1.4" },
    {
      operation: "analyze_function",
      parameters: { address: "0x401000" },
      result: { ...original, pseudocode: "X".repeat(11 * 1024 * 1024) },
    },
  );
  expect(session.recordEvidence(parent).ok).toBe(true);
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_analysis_view",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("missing view schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  const arguments_ = {
    source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
    view: { kind: "native", facet: "pseudocode", offset: 0, limit: 500 },
  };
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  expect(
    ajv.validate(inputSchema, arguments_),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: arguments_,
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
    kind: "native",
    parent_evidence_id: parent.evidence_id,
    procedure_address: "0x401000",
    coverage: { examined: 500, next_offset: 500, total: 11 * 1024 * 1024 },
  });
  expect(parsed.evidence_links).toEqual([parent.evidence_id]);
  expect(parsed.locations).toEqual([
    { kind: "artifact-path", path: "/fixtures/oversized-native.exe" },
    { kind: "address", address: "0x401000" },
  ]);
  expect(JSON.stringify(response.structuredContent).length).toBeLessThan(12000);
  await client.ping();
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
    .parse(parseMcpToolError(response)).error.details
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

it("retains an oversized native assembly row and permits a subsequent smaller view", async () => {
  const { client, session } = await connect();
  const row = "\0".repeat(1_000_000);
  const parent = createEvidence(
    { path: "/fixtures/large-row.exe", format: "pe", sha256: "c".repeat(64) },
    { id: "ghidra", name: "Ghidra", version: "12.1.4" },
    {
      operation: "analyze_function",
      parameters: {},
      result: {
        ...functionDossierSchema.parse(ghidraFunctionDossier()),
        assembly: [row],
      },
    },
  );
  expect(session.recordEvidence(parent).ok).toBe(true);
  const source = { kind: "retained-evidence", evidence_id: parent.evidence_id };
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source,
      view: { kind: "native", facet: "assembly", offset: 0, limit: 1 },
    },
  });
  expect(response.isError).toBe(true);
  const error = z
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
    .parse(parseMcpToolError(response));
  const retained = session.evidenceById(
    error.error.details.reported_limits.evidence_reference.evidence_id,
  );
  expect(retained?.normalized_result).toMatchObject({
    item: [row],
    parent_evidence_id: parent.evidence_id,
  });
  const next = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source,
      view: { kind: "native", facet: "pseudocode", offset: 0, limit: 12 },
    },
  });
  expect(next.isError).not.toBe(true);
  expect(
    toolContract("inspect_analysis_view").outputSchema.parse(
      next.structuredContent,
    ).normalized_result,
  ).toMatchObject({
    item: { text: "int fixture_" },
    parent_evidence_id: parent.evidence_id,
  });
  await client.ping();
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
  expect(parseMcpToolError(stale)).toMatchObject({
    error: { details: { reason: "missing" } },
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
