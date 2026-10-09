import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";

import { BinaryLayoutService } from "../../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  analysisViewJavaScriptEvidence,
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
  expect(ajv.validateSchema(advertised.inputSchema)).toBe(true);
  expect(ajv.validateSchema(advertised.outputSchema)).toBe(true);
  expect(
    ajv.validate(advertised.inputSchema, {
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
    ajv.validate(advertised.outputSchema, response.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const parsed = toolContract("inspect_analysis_view").outputSchema.parse(
    response.structuredContent,
  );
  expect(parsed.result).toMatchObject({
    kind: "item",
    parent_evidence_id: parent.evidence_id,
    item: { name: { display: ".data" } },
  });
  expect(parsed.result).toEqual(
    parseEvidence(parsed.evidence).normalized_result,
  );
  expect(session.evidenceById(parsed.evidence_id)).toEqual(
    parseEvidence(parsed.evidence),
  );
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
  expect(parsed.result).toMatchObject({
    kind: "summary",
    parent_operation: "analyze_javascript_application",
    summary: { format: "directory" },
  });
  expect(JSON.stringify(parsed.result)).not.toMatch(/semantic_graph/);
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
  expect(parsed.result).toMatchObject({
    kind: "page",
    parent_evidence_id: parent.evidence_id,
    coverage: { exhausted: true },
  });
  expect(parsed.result.items).toEqual([
    {
      node_id: expect.any(String),
      kind: "javascript-asset",
      path: "renderer.js",
    },
  ]);
});
