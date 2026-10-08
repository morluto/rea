import { traceSourceMap } from "../../../src/javascript/sourceMaps/TraceSourceMap.js";
import { webSourceLocationArgs as args } from "../../fixtures/webSourceLocation.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { WebSourceLocationService } from "../../../src/application/WebSourceLocationService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { webSourceLocationFixture } from "../../fixtures/webSourceLocation.js";

it("publishes valid SDK schemas and records the named module trace without a binary target", async () => {
  const service = new WebSourceLocationService(
    {
      load: () => Promise.resolve(ok(webSourceLocationFixture())),
    },
    {
      trace: (input) =>
        Promise.resolve(
          ok(traceSourceMap(input.text, input.url, input.position)),
        ),
    },
  );
  const session = createTestBinarySession(() => {
    throw new Error("binary provider must not start");
  });
  const server = createServer(session, session, { webSourceLocation: service });
  const client = new Client({ name: "module-contract", version: "1" });
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
    (tool) => tool.name === "trace_web_source_location",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("module trace must advertise both schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  expect(ajv.validate(inputSchema, args)).toBe(true);
  const response = await client.callTool({
    name: "trace_web_source_location",
    arguments: args,
  });
  expect(response.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, response.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const parsed = toolContract("trace_web_source_location").outputSchema.parse(
    response.structuredContent,
  );
  const evidence = parseEvidence(parsed.evidence);
  expect(parsed.result).toEqual(evidence.normalized_result);
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  const invalid = await client.callTool({
    name: "trace_web_source_location",
    arguments: { ...args, manifest_path: "relative.json" },
  });
  expect(invalid.isError).toBe(true);
});
