import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, expect, it, onTestFinished } from "vitest";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { emptyProcessCapture } from "../../../src/domain/process/processCapture.fixture.js";
import { parseProcessCapture } from "../../../src/domain/process/processCaptureParsing.js";
import { createProcessCaptureEvidence } from "../../../src/application/process/ProcessEvidence.js";
import { processScenarioSchema } from "../../../src/domain/process/processScenario.js";

const validation = createMcpSchemaValidation();
afterAll(() => validation.clear());

it.each(["full", "compact"] as const)(
  "advertises quiesced cleanup intervention without rejecting saved captures (%s)",
  async (profile) => {
    const session = createTestBinarySession(() => {
      throw new Error("Schema discovery must not start a provider");
    });
    const server = createServer(
      { kind: "session", session },
      {
        environment: {
          ...process.env,
          REA_MCP_INPUT_SCHEMA_PROFILE: profile,
          REA_MCP_OUTPUT_SCHEMA_PROFILE: "full",
        },
      },
    );
    const client = new Client(
      { name: "capture-cleanup-schema", version: "1" },
      { jsonSchemaValidator: validation },
    );
    onTestFinished(async () => {
      await client.close();
      await server.close();
      await session.close();
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const schemas = await advertisedMcpToolSchemas(
      client,
      "capture_process_scenario",
      validation.assertions,
    );
    const saved = emptyProcessCapture();
    const scenario = processScenarioSchema.parse({
      executable: "fixture-program",
    });
    const intervened = parseProcessCapture({
      ...saved,
      settlement: { ...saved.settlement, cleanup_outcome: "cleaned" },
      residual_unknowns: [
        { scope: "process", reason: "Fixture cleanup intervention" },
      ],
    });
    for (const capture of [saved, intervened]) {
      const evidence = createProcessCaptureEvidence(scenario, capture);
      expect(
        schemas.ajv.validate(schemas.outputSchema, evidence),
        JSON.stringify(schemas.ajv.errors),
      ).toBe(true);
    }
    const evidence = createProcessCaptureEvidence(scenario, intervened);
    expect(
      schemas.ajv.validate(schemas.outputSchema, {
        ...evidence,
        normalized_result: {
          ...intervened,
          settlement: { ...intervened.settlement, cleanup_outcome: "invented" },
        },
      }),
    ).toBe(false);
  },
);
