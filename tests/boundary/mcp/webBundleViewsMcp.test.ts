import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import {
  webBundlePageViewResultSchema,
  webBundleSummaryViewResultSchema,
} from "../../../src/domain/analysisView/analysisViewResult.js";
import { sampleWebBundleAnalysis } from "../../fixtures/webBundleAnalysis.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";

const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());

const makeParent = () =>
  createEvidence(
    undefined,
    { id: "rea-browser", name: "REA Browser", version: "6.8.0" },
    {
      operation: "analyze_web_bundle",
      parameters: { target_url: "https://example.test/app" },
      result: sampleWebBundleAnalysis(),
    },
  );

const connect = async () => {
  const session = createTestBinarySession(() => {
    throw new Error("selected views must not start a deep provider");
  });
  const { client } = await createApplicationMcpHarness({
    session,
    serverOptions: {
      environment: { ...process.env, REA_MCP_INPUT_SCHEMA_PROFILE: "full" },
    },
    clientIdentity: { name: "web-bundle-view-mcp", version: "1" },
    schemaValidator: schemaValidation,
  });
  const schemas = await advertisedMcpToolSchemas(
    client,
    "inspect_analysis_view",
    schemaValidation.assertions,
  );
  return { client, session, schemas };
};

it("projects web bundle summary views over MCP using retained and inline sources", async () => {
  const { client, session, schemas } = await connect();
  const parent = makeParent();
  expect(session.recordEvidence(parent).ok).toBe(true);

  const summaryCall = await client.callTool(
    {
      name: schemas.toolDefinition.name,
      arguments: {
        source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
        view: { kind: "summary" },
      },
    },
    { toolDefinition: schemas.toolDefinition },
  );
  expect(summaryCall.isError, JSON.stringify(summaryCall)).not.toBe(true);

  const summaryResult = webBundleSummaryViewResultSchema.parse(
    parseEvidence(summaryCall.structuredContent).normalized_result,
  );
  expect(summaryResult.kind).toBe("summary");
  expect(summaryResult.parent_operation).toBe("analyze_web_bundle");
  expect(summaryResult.summary).toMatchObject({
    target_url: "https://example.test/app",
    counts: { endpoints: 3, inferences: 2, endpoint_candidates: 1 },
    completeness: { status: "partial" },
  });

  const collectionSummaryCall = await client.callTool(
    {
      name: schemas.toolDefinition.name,
      arguments: {
        source: { kind: "inline", evidence: parent },
        view: { kind: "web-bundle", collection: "summary" },
      },
    },
    { toolDefinition: schemas.toolDefinition },
  );
  expect(collectionSummaryCall.isError).not.toBe(true);

  const collectionSummaryResult = webBundlePageViewResultSchema.parse(
    parseEvidence(collectionSummaryCall.structuredContent).normalized_result,
  );
  expect(collectionSummaryResult.kind).toBe("web-bundle");
  expect(collectionSummaryResult.summary).toMatchObject({
    target_url: "https://example.test/app",
    counts: { endpoints: 3, inferences: 2, endpoint_candidates: 1 },
  });
});

it("pages web bundle endpoints and inferences over MCP using evidence-file source", async () => {
  const { client, schemas } = await connect();
  const parent = makeParent();
  const tempDir = await createTestTempDirectory("rea-webbundle-mcp-");
  const evidenceFile = join(tempDir, "webbundle-evidence.json");
  await writeFile(evidenceFile, JSON.stringify(parent));

  const page1Call = await client.callTool(
    {
      name: schemas.toolDefinition.name,
      arguments: {
        source: { kind: "evidence-file", path: evidenceFile },
        view: {
          kind: "web-bundle",
          collection: "endpoints",
          offset: 0,
          limit: 2,
        },
      },
    },
    { toolDefinition: schemas.toolDefinition },
  );
  expect(page1Call.isError).not.toBe(true);

  const page1 = webBundlePageViewResultSchema.parse(
    parseEvidence(page1Call.structuredContent).normalized_result,
  );
  expect(page1.items).toHaveLength(2);
  expect(page1.items[0]).toMatchObject({
    source_index: 0,
    value: "/api/users",
  });
  expect(page1.items[1]).toMatchObject({
    source_index: 1,
    value: "/api/users",
  });
  expect(page1.coverage).toMatchObject({
    status: "page",
    examined: 2,
    total: 3,
    next_offset: 2,
    exhausted: false,
  });
  expect(page1.completeness.status).toBe("partial");

  const page2Call = await client.callTool(
    {
      name: schemas.toolDefinition.name,
      arguments: {
        source: { kind: "evidence-file", path: evidenceFile },
        view: {
          kind: "web-bundle",
          collection: "endpoints",
          offset: 2,
          limit: 2,
        },
      },
    },
    { toolDefinition: schemas.toolDefinition },
  );
  expect(page2Call.isError).not.toBe(true);

  const page2 = webBundlePageViewResultSchema.parse(
    parseEvidence(page2Call.structuredContent).normalized_result,
  );
  expect(page2.items).toHaveLength(1);
  expect(page2.items[0]).toMatchObject({
    source_index: 2,
    value: "/api/orders",
  });
  expect(page2.coverage).toMatchObject({
    status: "page",
    examined: 1,
    total: 3,
    next_offset: null,
    exhausted: true,
  });

  const candidatesCall = await client.callTool(
    {
      name: schemas.toolDefinition.name,
      arguments: {
        source: { kind: "evidence-file", path: evidenceFile },
        view: {
          kind: "web-bundle",
          collection: "inferences",
          kinds: ["endpoint_candidate"],
        },
      },
    },
    { toolDefinition: schemas.toolDefinition },
  );
  expect(candidatesCall.isError).not.toBe(true);

  const candidatesPage = webBundlePageViewResultSchema.parse(
    parseEvidence(candidatesCall.structuredContent).normalized_result,
  );
  expect(candidatesPage.items).toEqual([
    expect.objectContaining({
      source_index: 0,
      kind: "endpoint_candidate",
      value: "/api/dynamic-user",
      confidence: "low",
    }),
  ]);

  const emptyCall = await client.callTool(
    {
      name: schemas.toolDefinition.name,
      arguments: {
        source: { kind: "evidence-file", path: evidenceFile },
        view: {
          kind: "web-bundle",
          collection: "endpoints",
          offset: 100,
          limit: 10,
        },
      },
    },
    { toolDefinition: schemas.toolDefinition },
  );
  expect(emptyCall.isError).not.toBe(true);

  const emptyPage = webBundlePageViewResultSchema.parse(
    parseEvidence(emptyCall.structuredContent).normalized_result,
  );
  expect(emptyPage.items).toEqual([]);
  expect(emptyPage.coverage).toMatchObject({
    status: "empty",
    examined: 0,
    total: 3,
    next_offset: null,
    exhausted: true,
  });
});
