import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { WasmArtifactService } from "../../../src/application/wasm/WasmArtifactService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  wasmArtifactFixture,
  wasmArtifactExecution,
} from "../../fixtures/wasm/artifact.js";

it("advertises exact valid schemas and records inline WASM interface evidence without a binary target", async () => {
  const value = wasmArtifactFixture();
  const service = new WasmArtifactService({
    inspect: () => Promise.resolve(ok(wasmArtifactExecution(value))),
  });
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { wasmArtifact: service },
  );
  const client = new Client({ name: "wasm-artifact-contract", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_wasm_artifact",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("WASM interface inspection must publish both schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
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
});
