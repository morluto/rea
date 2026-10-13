import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { API_SURFACE_EXAMPLE } from "../../../src/contracts/analysisViewApiSurfaceExample.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { WebNetworkCaptureService } from "../../../src/application/WebNetworkCaptureService.js";
import { decodeHarCapture } from "../../../src/browser/history/HarCapture.js";
import { join } from "node:path";
import { apiSurfaceHar } from "../../fixtures/historicalHar.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { BinaryLayoutService } from "../../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { jsonObjectSchema } from "../../../src/domain/jsonValue.js";
import { functionDossierSchema } from "../../../src/domain/hopperValues.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import { ok } from "../../../src/domain/result.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "../../../src/domain/javascript/javascriptApplicationGraph.js";
import { createServer } from "../../../src/server/createServer.js";
import { connectGhidraMcp } from "./ghidraMcpHarness.js";
import {
  analysisViewJavaScriptEvidence,
  analysisViewJavaScriptAnalysisWithSource,
  analysisViewBindJavaScriptGraphs,
  analysisViewLayoutEvidence,
  analysisViewLayoutFixture,
  analysisViewCaptureFixture,
  analysisViewCaptureEvidence,
  analysisViewObjectDenseCapture,
} from "../../fixtures/analysisView.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { BINARY_LAYOUT_TEST_PROVIDER } from "../../fixtures/binaryDiagnostics/layout.js";
import { wasmArtifactFixture } from "../../fixtures/wasm/artifact.js";
import { evmInterfaceFixture } from "../../fixtures/evm/interface.js";

const connect = async (
  binaryLayout?: BinaryLayoutService,
  webNetworkCapture?: WebNetworkCaptureService,
) => {
  const session = createTestBinarySession(() => {
    throw new Error("selected views must not start a deep provider");
  });
  const server = createServer(
    { kind: "session", session },
    {
      ...(binaryLayout === undefined ? {} : { binaryLayout }),
      ...(webNetworkCapture === undefined ? {} : { webNetworkCapture }),
    },
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

it("discovers an oversized native dossier by exact metadata and reads its retained view", async () => {
  const { client, session } = await connect();
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_analysis_view",
  );
  expect(advertised?.description).toContain(
    'Native function Evidence requires kind native: view: {kind: "native", facet: "procedure"}',
  );
  const provider = { id: "ghidra", name: "Ghidra", version: "12.1.4" };
  const profile = createAnalysisProfile(provider, { language: "fixture" });
  const parent = createEvidence(
    { path: "/fixtures/large.exe", format: "pe", sha256: "a".repeat(64) },
    provider,
    {
      operation: "analyze_function",
      parameters: { procedure: "0x401000" },
      analysisProfile: profile,
      result: {
        ...jsonObjectSchema.parse(ghidraFunctionDossier()),
        pseudocode: "x".repeat(6 * 1024 * 1024),
      },
      rawResult: null,
    },
  );
  const other = createEvidence(
    { path: "/fixtures/other.exe", format: "pe", sha256: "b".repeat(64) },
    provider,
    {
      operation: "analyze_function",
      parameters: {},
      result: ghidraFunctionDossier(),
    },
  );
  for (const record of [parent, other]) {
    const retained = session.recordEvidence(record);
    if (!retained.ok) throw retained.error;
  }
  const unsupportedSummary = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "summary" },
    },
  });
  expect(parseMcpToolError(unsupportedSummary).error).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [
        {
          path: ["view"],
          message: "analyze_function Evidence requires a native view.",
        },
      ],
    },
  });
  const broad = await client.callTool({
    name: "get_evidence_bundle",
    arguments: {},
  });
  const broadError = parseMcpToolError(broad).error;
  expect(broadError.code).toBe("resource_constraint");
  expect(broadError.remediation?.action).toContain(
    "get_evidence_bundle and detail: summary",
  );
  const response = await client.callTool({
    name: "get_evidence_bundle",
    arguments: {
      detail: "summary",
      filters: {
        operation: "analyze_function",
        target_sha256: "a".repeat(64),
        analysis_profile_digest: profile.digest,
        procedure_address: "0x401000",
      },
    },
  });
  expect(response.isError).not.toBe(true);
  const result = toolContract("get_evidence_bundle").outputSchema.parse(
    response.structuredContent,
  ).result;
  expect(result).toMatchObject({
    kind: "evidence-bundle-summary",
    total_retained_records: 2,
    matching_records: 1,
    records: [
      {
        evidence_id: parent.evidence_id,
        analysis_profile_digest: profile.digest,
        retention: "complete-record",
        native_dossier: { available: true, procedure_address: "0x401000" },
      },
    ],
  });
  expect(JSON.stringify(response)).not.toContain("pseudocode");
  expect(
    JSON.parse(response.content.find((c) => c.type === "text")?.text ?? "null"),
  ).toEqual(response.structuredContent);
  const page = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "native", facet: "pseudocode", offset: 0, limit: 32 },
    },
  });
  expect(page.isError).not.toBe(true);
  expect(
    toolContract("inspect_analysis_view").outputSchema.parse(
      page.structuredContent,
    ).normalized_result,
  ).toMatchObject({
    item: { text: "x".repeat(32) },
    coverage: { total: 6 * 1024 * 1024, exhausted: false },
  });
  const empty = await client.callTool({
    name: "get_evidence_bundle",
    arguments: {
      detail: "summary",
      filters: { evidence_id: `ev_${"e".repeat(64)}` },
    },
  });
  expect(
    toolContract("get_evidence_bundle").outputSchema.parse(
      empty.structuredContent,
    ).result,
  ).toMatchObject({ matching_records: 0, records: [] });
  await client.ping();
  const invalid = await client.callTool({
    name: "get_evidence_bundle",
    arguments: { filters: { operation: "analyze_function" } },
  });
  expect(parseMcpToolError(invalid).error.code).toBe("invalid_request");
});

it("advertises exact schemas and projects one layout section from retained Evidence", async () => {
  const layout = analysisViewLayoutFixture();
  const service = new BinaryLayoutService({
    inspectAndClose(input, options) {
      return this.inspect(input, options);
    },
    identity: BINARY_LAYOUT_TEST_PROVIDER,
    inspect: () => Promise.resolve(ok(layout)),
  });
  const { client, session } = await connect(service);
  const { ajv, inputSchema, outputSchema } = await advertisedMcpToolSchemas(
    client,
    "inspect_analysis_view",
  );
  expect(
    ajv.validate(inputSchema, {
      source: { kind: "inline", evidence: analysisViewLayoutEvidence() },
      view: { kind: "summary" },
    }),
  ).toBe(true);
  expect(
    ajv.validate(inputSchema, {
      source: { kind: "inline", evidence: {} },
      view: { kind: "summary" },
    }),
  ).toBe(false);
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

it("reports a tampered inline Evidence ID at its full MCP source path", async () => {
  const { client } = await connect();
  const parent = analysisViewLayoutEvidence();
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "inline",
        evidence: { ...parent, evidence_id: `ev_${"0".repeat(64)}` },
      },
      view: { kind: "summary" },
    },
  });

  expect(parseMcpToolError(response).error).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
    details: {
      issues: [
        {
          path: ["source", "evidence", "evidence_id"],
          reason: "invalid_value",
          message: "Evidence semantic identifier does not match its record",
        },
      ],
    },
  });
});

it("rejects self-contained WASM and EVM Evidence views when the subject format differs", async () => {
  const { client } = await connect();
  const wasm = wasmArtifactFixture();
  const evm = evmInterfaceFixture();
  const cases = [
    {
      evidence: createEvidence(
        {
          path: wasm.artifact.path,
          format: "elf",
          sha256: wasm.artifact.sha256,
        },
        { id: "fixture-wabt", name: "WABT", version: "1" },
        {
          operation: "inspect_wasm_artifact",
          parameters: { path: wasm.artifact.path },
          result: wasm,
        },
      ),
    },
    {
      evidence: createEvidence(
        {
          path: evm.artifact.path,
          format: "elf",
          sha256: evm.artifact.sha256,
        },
        { id: "fixture-evm", name: "EVMole", version: "1" },
        {
          operation: "inspect_evm_interface",
          parameters: { path: evm.artifact.path, encoding: "hex" },
          result: evm,
        },
      ),
    },
  ] as const;

  for (const { evidence } of cases) {
    const response = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "inline", evidence },
        view: { kind: "summary" },
      },
    });
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          expect.objectContaining({
            path: ["source", "subject"],
            reason: "invalid_value",
          }),
        ],
      },
    });
  }
});

it("admits portable captures before SDK Evidence parsing and preserves capture caveats", async () => {
  const { client } = await connect();
  const dense = analysisViewCaptureEvidence(analysisViewObjectDenseCapture());
  const refused = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "inline", evidence: dense },
      view: { kind: "api-surface" },
    },
  });
  expect(parseMcpToolError(refused).error).toMatchObject({
    code: "resource_constraint",
    details: { resource: "memory" },
  });
  await client.ping();

  const capture = analysisViewCaptureFixture();
  capture.records = capture.records.slice(0, 1);
  capture.total_records = 1;
  const caveat = "Producer omitted exchanges before capture startup.";
  capture.limitations = [caveat, caveat];
  capture.records[0]!.reported = {
    request: { method: "GET", url: "https://api.test/a" },
    response: { status: 200, content: { mimeType: "\u00a0text/plain\u00a0" } },
  };
  const parent = analysisViewCaptureEvidence(capture);
  expect(parent.limitations).not.toContain(caveat);
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "inline", evidence: parent },
      view: { kind: "api-surface" },
    },
  });
  const result = parseEvidence(response.structuredContent);
  expect(result.limitations.filter((value) => value === caveat)).toEqual([
    caveat,
  ]);
  expect(result.normalized_result).toMatchObject({
    groups: [{ content_types: [], flags: ["single-sample"] }],
    limitations: expect.arrayContaining([caveat]),
    unknowns: [
      "Some retained records have unavailable status or content type values.",
    ],
  });
});

it("rejects inconsistent portable coverage and accepts caller-ordered ordinal subsets", async () => {
  const { client } = await connect();
  for (const [total, ordinals] of [
    [0, [0]],
    [2, [0, 0]],
    [2, [2]],
  ] as const) {
    const capture = analysisViewCaptureFixture();
    capture.total_records = total;
    capture.records = ordinals.map((ordinal) => ({
      ...capture.records[0]!,
      ordinal,
    }));
    const response = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: {
          kind: "inline",
          evidence: analysisViewCaptureEvidence(capture),
        },
        view: { kind: "api-surface" },
      },
    });
    expect(parseMcpToolError(response).error.code).toBe("invalid_request");
  }
  const capture = analysisViewCaptureFixture();
  capture.records = [capture.records[8]!, capture.records[1]!];
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "inline",
        evidence: analysisViewCaptureEvidence(capture),
      },
      view: { kind: "api-surface" },
    },
  });
  expect(
    parseEvidence(response.structuredContent).normalized_result,
  ).toMatchObject({
    records: { examined: 2, total: 15 },
    limitations: expect.arrayContaining([
      "Parent contains an ordinal subset; the surface covers only retained records.",
    ]),
  });
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

it("reads successive native source pages directly from a completed-result transport error", async () => {
  const pseudocode = "int fixture_add(int a, int b) { return a + b; }\n".repeat(
    150_000,
  );
  const harness = await connectGhidraMcp(
    "native-continuation",
    async (operation) => {
      if (operation !== "analyze_function")
        throw new Error(`Unexpected provider operation: ${operation}`);
      return ok({
        value: {
          ...functionDossierSchema.parse(ghidraFunctionDossier()),
          pseudocode,
        },
        limitations: [],
      });
    },
  );
  onTestFinished(() => harness.close());
  const { mcp: client, session, calls } = harness;
  const failed = await client.callTool({
    name: "analyze_function",
    arguments: { procedure: "0x401000" },
  });
  expect(failed.isError).toBe(true);
  const limits = z
    .object({
      error: z.object({
        details: z.object({ reported_limits: jsonObjectSchema }),
      }),
    })
    .parse(parseMcpToolError(failed)).error.details.reported_limits;
  const reference = z
    .object({
      kind: z.literal("retained-evidence"),
      evidence_id: z.string(),
    })
    .parse(limits.evidence_reference);
  const parent = parseEvidence(session.evidenceById(reference.evidence_id));
  expect(parent.operation).toBe("analyze_function");
  expect(parent.parameters).toMatchObject({ procedure: "0x401000" });
  const call = z
    .object({
      name: z.literal("inspect_analysis_view"),
      arguments: toolContract("inspect_analysis_view").inputSchema,
    })
    .parse(limits.continuation);
  expect(call.arguments.source).toEqual({
    kind: "retained-evidence",
    evidence_id: parent.evidence_id,
  });
  const first = await client.callTool(call);
  expect(first.isError).not.toBe(true);
  const page = toolContract("inspect_analysis_view").outputSchema.parse(
    first.structuredContent,
  ).normalized_result;
  expect(page).toMatchObject({
    parent_evidence_id: parent.evidence_id,
    item: { text: pseudocode.slice(0, 64) },
    coverage: { examined: 64, next_offset: 64, exhausted: false },
  });
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(
    STDIO_DEFAULT_MAX_BUFFER_SIZE,
  );
  const second = await client.callTool({
    name: call.name,
    arguments: {
      ...call.arguments,
      view: {
        kind: "native",
        facet: "pseudocode",
        offset: page.coverage.next_offset,
        limit: 64,
      },
    },
  });
  expect(second.isError).not.toBe(true);
  expect(
    toolContract("inspect_analysis_view").outputSchema.parse(
      second.structuredContent,
    ).normalized_result,
  ).toMatchObject({ item: { text: pseudocode.slice(64, 128) } });
  expect(
    session.evidenceById(parent.evidence_id)?.normalized_result,
  ).toMatchObject({ pseudocode });
  await client.ping();
  expect(calls).toEqual(["analyze_function"]);
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

it("projects an actual HAR capture retained by the public MCP workflow", async () => {
  const root = await createTestTempDirectory("rea-surface-mcp-");
  const path = join(root, "surface.har");
  await writeFile(path, JSON.stringify(apiSurfaceHar()));
  const service = new WebNetworkCaptureService({
    inspect: async (input) => {
      const bytes = await readFile(input.capture_path);
      return ok({
        ...decodeHarCapture(bytes.toString("utf8"), input.sensitive_values),
        artifact: {
          path: input.capture_path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        },
        format: "har",
        runtime_attribution: "unknown",
        limitations: [],
      });
    },
  });
  const { client } = await connect(undefined, service);
  const captureResponse = await client.callTool({
    name: "inspect_web_network_capture",
    arguments: { capture_path: path, format: "har" },
  });
  expect(captureResponse.isError).not.toBe(true);
  const parent = parseEvidence(captureResponse.structuredContent);
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "api-surface" },
    },
  });
  expect(response.isError).not.toBe(true);
  const evidence = parseEvidence(response.structuredContent);
  expect(evidence.confidence).toBe("inferred");
  expect(evidence.normalized_result).toMatchObject({
    records: { examined: 13, total: 13, excluded: 0 },
    coverage: { total: 12, exhausted: true },
    groups: expect.arrayContaining([
      expect.objectContaining({
        path_template: "/users/{numeric}",
        record_ordinals: [0, 1],
      }),
    ]),
  });
});

it("reproduces the published API surface example from decoded fixture bytes", async () => {
  const fixture = apiSurfaceHar();
  fixture.log.entries = fixture.log.entries.slice(0, 2);
  const bytes = Buffer.from(JSON.stringify(fixture));
  const service = new WebNetworkCaptureService({
    inspect: async () =>
      ok({
        ...decodeHarCapture(bytes.toString("utf8"), []),
        artifact: {
          path: "/fixtures/api-surface.har",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        },
        format: "har",
        runtime_attribution: "unknown",
        limitations: [],
      }),
  });
  const { client } = await connect(undefined, service);
  const capture = await client.callTool({
    name: "inspect_web_network_capture",
    arguments: { capture_path: "/fixtures/api-surface.har", format: "har" },
  });
  expect(parseEvidence(capture.structuredContent).evidence_id).toBe(
    API_SURFACE_EXAMPLE.input.source.evidence_id,
  );
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: API_SURFACE_EXAMPLE.input,
  });
  expect(parseEvidence(response.structuredContent).normalized_result).toEqual(
    API_SURFACE_EXAMPLE.output,
  );
});
