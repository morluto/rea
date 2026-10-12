import type { Client } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished, vi } from "vitest";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WasmArtifactService } from "../../../src/application/wasm/WasmArtifactService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
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
