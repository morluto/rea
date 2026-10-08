import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { RecordedCrashService } from "../../../src/application/binaryDiagnostics/RecordedCrashService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  recordedCrashFixture,
  RECORDED_CRASH_TEST_PROVIDER,
} from "../../fixtures/binaryDiagnostics/recordedCrash.js";

it("advertises exact valid schemas and records inline recorded-core evidence without a binary target", async () => {
  const value = recordedCrashFixture();
  const service = new RecordedCrashService({
    identity: RECORDED_CRASH_TEST_PROVIDER,
    inspect: () => Promise.resolve(ok(value)),
  });
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(session, session, { recordedCrash: service });
  const client = new Client({ name: "recorded-crash-contract", version: "1" });
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
    (tool) => tool.name === "inspect_recorded_crash",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("recorded crash must publish both schemas");
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
    name: "inspect_recorded_crash",
    arguments: { path: value.artifact.path },
  });
  expect(response.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, response.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const parsed = toolContract("inspect_recorded_crash").outputSchema.parse(
    response.structuredContent,
  );
  const evidence = parseEvidence(parsed.evidence);
  expect(parsed.result).toEqual(value);
  expect(parsed.result).toEqual(evidence.normalized_result);
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  expect(
    (
      await client.callTool({
        name: "inspect_recorded_crash",
        arguments: { path: "relative.elf" },
      })
    ).isError,
  ).toBe(true);
});
