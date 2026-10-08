import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { EvmInterfaceService } from "../../../src/application/evm/EvmInterfaceService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  evmInterfaceFixture,
  evmInterfaceExecution,
} from "../../fixtures/evm/interface.js";

it("advertises exact valid schemas and records inline EVM interface evidence without a binary target", async () => {
  const value = evmInterfaceFixture();
  const service = new EvmInterfaceService({
    inspect: () => Promise.resolve(ok(evmInterfaceExecution(value))),
  });
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(session, session, { evmInterface: service });
  const client = new Client({ name: "evm-interface-contract", version: "1" });
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
    (tool) => tool.name === "inspect_evm_interface",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("EVM interface inspection must publish both schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  expect(
    ajv.validate(inputSchema, { path: value.artifact.path, encoding: "hex" }),
  ).toBe(true);
  expect(
    ajv.validate(inputSchema, {
      path: value.artifact.path,
      encoding: "hex",
      approval: true,
    }),
  ).toBe(false);
  const response = await client.callTool({
    name: "inspect_evm_interface",
    arguments: { path: value.artifact.path, encoding: "hex" },
  });
  expect(response.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, response.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const parsed = toolContract("inspect_evm_interface").outputSchema.parse(
    response.structuredContent,
  );
  const evidence = parseEvidence(parsed.evidence);
  expect(parsed.result).toEqual(value);
  expect(parsed.result).toEqual(evidence.normalized_result);
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  expect(
    (
      await client.callTool({
        name: "inspect_evm_interface",
        arguments: { path: "relative.hex", encoding: "hex" },
      })
    ).isError,
  ).toBe(true);
});
