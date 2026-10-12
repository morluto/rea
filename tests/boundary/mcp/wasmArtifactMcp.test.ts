import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished, vi } from "vitest";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WasmArtifactService } from "../../../src/application/wasm/WasmArtifactService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { wasmArtifactSummaryViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createServer } from "../../../src/server/createServer.js";
import { ok } from "../../../src/domain/result.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  wasmArtifactFixture,
  wasmArtifactExecution,
} from "../../fixtures/wasm/artifact.js";

const wasmToolSchemas = async (client: Client) => {
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_wasm_artifact",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("WASM recovery must name an advertised static tool");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  return { name: advertised.name, ajv, inputSchema, outputSchema };
};

const assertFirstSummaryDelivery = async (
  harness: Awaited<ReturnType<typeof createApplicationMcpHarness>>,
  value: ReturnType<typeof wasmArtifactFixture>,
  inspect: WasmArtifactService["provider"]["inspect"],
) => {
  const {
    ajv: wasmAjv,
    inputSchema,
    outputSchema,
  } = await wasmToolSchemas(harness.client);
  const summaryInput = { path: value.artifact.path, detail: "summary" };
  expect(wasmAjv.validate(inputSchema, summaryInput)).toBe(true);
  expect(
    wasmAjv.validate(inputSchema, { ...summaryInput, detail: "brief" }),
  ).toBe(false);
  const directSummary = await harness.client.callTool({
    name: "inspect_wasm_artifact",
    arguments: summaryInput,
  });
  expect(directSummary.isError).not.toBe(true);
  expect(
    wasmAjv.validate(outputSchema, directSummary.structuredContent),
    JSON.stringify(wasmAjv.errors),
  ).toBe(true);
  const summaryEvidence = parseEvidence(directSummary.structuredContent);
  const summary = wasmArtifactSummaryViewResultSchema.parse(
    summaryEvidence.normalized_result,
  );
  expect(summaryEvidence.confidence).toBe("derived");
  expect(summaryEvidence.evidence_links).toEqual([summary.parent_evidence_id]);
  expect(summary.summary.wat).toMatchObject({
    sha256: value.wat.sha256,
    code_units: value.wat.text.length,
  });
  expect(summary.summary.wat).not.toHaveProperty("text");
  const retained = harness.session.evidenceById(summary.parent_evidence_id);
  if (retained === undefined) throw new Error("Summary lost original Evidence");
  expect(retained.normalized_result).toEqual(value);
  expect(retained.parameters).toEqual({
    path: value.artifact.path,
    glue_paths: [],
    candidate_paths: [],
  });
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(inspect).toHaveBeenLastCalledWith(
    retained.parameters,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(
    wasmAjv.validate(outputSchema, {
      ...summaryEvidence,
      normalized_result: { ...summary, parent_operation: "inventory_artifact" },
    }),
  ).toBe(false);
  return { summary, retained };
};

it("directs rejected native WASM opening to the advertised static tool while preserving missing-WABT diagnostics", async () => {
  const directory = await createTestTempDirectory("rea-wasm-recovery-");
  const path = join(
    await realpath(directory),
    process.platform === "win32" ? "module space.bin" : 'module "quoted".bin',
  );
  await writeFile(path, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  const createClient = vi.fn(() => {
    throw new Error("native provider must not start for WASM");
  });
  const session = createTestBinarySession(createClient);
  const harness = await createApplicationMcpHarness({
    session,
    serverOptions: { environment: {} },
  });
  onTestFinished(harness.close);
  const { client } = harness;
  const { name, ajv, inputSchema } = await wasmToolSchemas(client);
  const input = { path };
  expect(
    toolContract("inspect_wasm_artifact").inputSchema.safeParse(input).success,
  ).toBe(true);
  const opening = await client.callTool({
    name: "open_binary",
    arguments: input,
  });
  expect(opening.isError).toBe(true);
  const failure = parseMcpToolError(opening);
  expect(failure).toMatchObject({
    error: {
      code: "target_unavailable",
      category: "unsupported_target",
      details: { constraint: "wasm_requires_static_inspection" },
    },
  });
  expect(failure.error.remediation.action).toContain(JSON.stringify({ path }));
  expect(ajv.validate(inputSchema, input)).toBe(true);
  const inspection = await client.callTool({
    name,
    arguments: input,
  });
  expect(inspection.isError).toBe(true);
  expect(parseMcpToolError(inspection)).toMatchObject({
    error: {
      code: "capability_unavailable",
      details: {
        operation: "inspect_wasm_artifact",
        reason: expect.stringContaining("REA_WABT_BIN_DIRECTORY"),
      },
    },
  });
  const summary = await client.callTool({
    name,
    arguments: { ...input, detail: "summary" },
  });
  expect(parseMcpToolError(summary)).toMatchObject({
    error: {
      code: "capability_unavailable",
      details: { reason: expect.stringContaining("REA_WABT_BIN_DIRECTORY") },
    },
  });
  await client.ping();
  expect(createClient).not.toHaveBeenCalled();
  expect(await readFile(path)).toEqual(
    Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
  );
});

it("advertises exact valid schemas and records inline WASM interface evidence without a binary target", async () => {
  const value = wasmArtifactFixture();
  const close = vi.fn(() => Promise.resolve());
  const service = new WasmArtifactService({
    close,
    inspect: () => Promise.resolve(ok(wasmArtifactExecution(value))),
  });
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const harness = await createApplicationMcpHarness({
    session,
    serverOptions: { wasmArtifact: service },
  });
  onTestFinished(harness.close);
  const { client } = harness;
  const { ajv, inputSchema, outputSchema } = await wasmToolSchemas(client);
  expect(ajv.validate(inputSchema, { path: value.artifact.path })).toBe(true);
  expect(
    ajv.validate(inputSchema, {
      path: value.artifact.path,

      approval: true,
    }),
  ).toBe(false);
  const response = await client.callTool({
    name: "inspect_wasm_artifact",
    arguments: { path: value.artifact.path },
  });
  expect(response.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, response.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const parsed = toolContract("inspect_wasm_artifact").outputSchema.parse(
    response.structuredContent,
  );
  const evidence = parseEvidence(parsed);
  expect(evidence.confidence).toBe("observed");
  expect(evidence.subject?.digest.sha256).toBe(value.artifact.sha256);
  expect(parsed.normalized_result).toEqual(value);
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  expect(
    (
      await client.callTool({
        name: "inspect_wasm_artifact",
        arguments: { path: "relative.hex" },
      })
    ).isError,
  ).toBe(true);
  await harness.close();
  expect(close).toHaveBeenCalled();
});

it("reads an oversized completed WASM result through its reported retained reference", async () => {
  const text = "(module)\n" + ";;😀\n" + " ".repeat(6 * 1024 * 1024);
  const value = {
    ...wasmArtifactFixture(),
    imports: ['(import "env" "memory.with punctuation" (memory 1))'],
    exports: ['(export "first" (func 0))', '(export "second" (func 1))'],
    wat: {
      text,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      representation: "decoded-wat" as const,
    },
  };
  const inspect = vi.fn(() =>
    Promise.resolve(ok(wasmArtifactExecution(value))),
  );
  const service = new WasmArtifactService({
    close: () => Promise.resolve(),
    inspect,
  });
  const harness = await createApplicationMcpHarness({
    serverOptions: { wasmArtifact: service },
  });
  onTestFinished(harness.close);
  const { summary, retained } = await assertFirstSummaryDelivery(
    harness,
    value,
    inspect,
  );
  const reply = await harness.client.callTool({
    name: "inspect_wasm_artifact",
    arguments: { path: value.artifact.path },
  });
  const reference = z
    .object({
      details: z.object({
        reported_limits: z.object({
          evidence_reference: z.object({
            kind: z.literal("retained-evidence"),
            evidence_id: z.string(),
          }),
        }),
      }),
    })
    .parse(parseMcpToolError(reply).error).details
    .reported_limits.evidence_reference;
  expect(reference.evidence_id).toBe(summary.parent_evidence_id);
  const explicitComplete = await harness.client.callTool({
    name: "inspect_wasm_artifact",
    arguments: { path: value.artifact.path, detail: "complete" },
  });
  expect(parseMcpToolError(explicitComplete)).toMatchObject({
    error: {
      code: "resource_constraint",
      details: { reported_limits: { evidence_reference: reference } },
    },
  });
  const catalog = await harness.client.listTools();
  const advertised = catalog.tools.find(
    (tool) => tool.name === "inspect_analysis_view",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("Missing WASM view schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const input: Record<string, unknown> = advertised.inputSchema;
  const output: Record<string, unknown> = advertised.outputSchema;
  for (const [view, expected] of [
    [
      { kind: "summary" },
      {
        summary: {
          validation: "valid",
          available_counts: { imports: 1, exports: 2 },
          runtime_execution: "not-performed",
          network_fetch: "not-performed",
          wat: { sha256: value.wat.sha256, code_units: text.length },
        },
      },
    ],
    [
      { kind: "wasm", facet: "exports", offset: 1, limit: 1 },
      {
        item: [value.exports[1]],
        coverage: { total: 2, next_offset: null, exhausted: true },
      },
    ],
    [{ kind: "wasm", facet: "imports" }, { item: value.imports }],
    [
      { kind: "wasm", facet: "wat", offset: 0, limit: 16 },
      {
        item: { text: text.slice(0, 16), unit: "utf16-code-units" },
        coverage: { total: text.length, next_offset: 16, exhausted: false },
      },
    ],
  ] as const) {
    const args = { source: reference, view };
    expect(ajv.validate(input, args), JSON.stringify(ajv.errors)).toBe(true);
    const selected = await harness.client.callTool({
      name: "inspect_analysis_view",
      arguments: args,
    });
    expect(
      selected.isError,
      JSON.stringify(selected.structuredContent),
    ).not.toBe(true);
    expect(
      ajv.validate(output, selected.structuredContent),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const evidence = parseEvidence(selected.structuredContent);
    expect(evidence.confidence).toBe("derived");
    expect(evidence.evidence_links).toEqual([reference.evidence_id]);
    expect(evidence.normalized_result).toMatchObject({
      parent_evidence_id: reference.evidence_id,
      ...expected,
    });
  }
  const original = harness.session.evidenceById(reference.evidence_id);
  expect(original?.normalized_result).toEqual(value);
  expect(original).toEqual(retained);
  expect(inspect).toHaveBeenCalledTimes(3);
  await harness.client.ping();
});

it("rejects inconsistent decoded-WAT digests in portable Evidence without a provider run", async () => {
  const value = wasmArtifactFixture();
  const harness = await createApplicationMcpHarness({
    serverOptions: { environment: {} },
  });
  onTestFinished(harness.close);
  const inconsistent = createEvidence(
    {
      path: value.artifact.path,
      sha256: value.artifact.sha256,
      format: "file",
    },
    { id: "historical-wabt", name: "Historical WABT", version: "1" },
    {
      operation: "inspect_wasm_artifact",
      parameters: {},
      result: { ...value, wat: { ...value.wat, sha256: "f".repeat(64) } },
    },
  );
  const invalid = await harness.client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "inline", evidence: inconsistent },
      view: { kind: "summary" },
    },
  });
  expect(parseMcpToolError(invalid)).toMatchObject({
    error: {
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["source", "normalized_result", "wat", "sha256"],
            reason: "invalid_value",
          },
        ],
      },
    },
  });
  await harness.client.ping();
});

it("rejects absent or inconsistent WASM source identity before deriving portable views", async () => {
  const value = wasmArtifactFixture();
  const harness = await createApplicationMcpHarness({
    serverOptions: { environment: {} },
  });
  onTestFinished(harness.close);
  for (const target of [
    undefined,
    {
      path: `${value.artifact.path}.other`,
      sha256: value.artifact.sha256,
      format: "file" as const,
    },
    {
      path: value.artifact.path,
      sha256: "f".repeat(64),
      format: "file" as const,
    },
  ]) {
    const source = createEvidence(
      target,
      { id: "historical-wabt", name: "Historical WABT", version: "1" },
      { operation: "inspect_wasm_artifact", parameters: {}, result: value },
    );
    for (const view of [
      { kind: "summary" },
      { kind: "wasm", facet: "exports", offset: 0, limit: 1 },
    ]) {
      const reply = await harness.client.callTool({
        name: "inspect_analysis_view",
        arguments: { source: { kind: "inline", evidence: source }, view },
      });
      expect(parseMcpToolError(reply)).toMatchObject({
        error: {
          code: "invalid_request",
          details: {
            issues: [{ path: ["source", "subject"], reason: "invalid_value" }],
          },
        },
      });
    }
  }
  await harness.client.ping();
});

it("requires retention for WASM summary delivery while keeping fixed-server complete delivery", async () => {
  const value = wasmArtifactFixture();
  const service = new WasmArtifactService({
    close: () => Promise.resolve(),
    inspect: () => Promise.resolve(ok(wasmArtifactExecution(value))),
  });
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider");
  });
  const server = createServer(
    { kind: "fixed", analysis: session },
    { wasmArtifact: service },
  );
  const client = new Client({ name: "wasm-fixed-delivery", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const summary = await client.callTool({
      name: "inspect_wasm_artifact",
      arguments: { path: value.artifact.path, detail: "summary" },
    });
    expect(parseMcpToolError(summary)).toMatchObject({
      error: {
        code: "capability_unavailable",
        message: expect.stringContaining("does not retain Evidence"),
      },
    });
    const complete = await client.callTool({
      name: "inspect_wasm_artifact",
      arguments: { path: value.artifact.path },
    });
    expect(complete.isError).not.toBe(true);
    expect(parseEvidence(complete.structuredContent).normalized_result).toEqual(
      value,
    );
    await client.ping();
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});

it("retries cleanup of the injected WASM module after server shutdown fails", async () => {
  const close = vi
    .fn()
    .mockRejectedValueOnce(new Error("retained WASM workspace"))
    .mockResolvedValue(undefined);
  const service = new WasmArtifactService({
    close,
    inspect: () => Promise.resolve(ok(wasmArtifactExecution())),
  });
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider");
  });
  const server = createServer(
    { kind: "session", session },
    { wasmArtifact: service },
  );
  const client = new Client({ name: "wasm-cleanup-retry", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    await expect(server.close()).rejects.toThrow("REA session cleanup failed");
    await server.close();
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});
