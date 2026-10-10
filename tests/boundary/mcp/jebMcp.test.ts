import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";

import type { JebAnalysisPort } from "../../../src/application/jeb/JebAnalysisPort.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

const identity = { id: "jeb", name: "JEB", version: "5.48.0" } as const;

it("advertises exact valid JEB schemas and records inline evidence through MCP", async () => {
  const execution = createAnalysisExecution(
    {
      engine: {
        name: "jeb",
        version: "5.48.0",
        endpoint: "http://127.0.0.1:8425/mcp",
        gui_client: false,
      },
      startup_ts: 1791623439,
      message: null,
    },
    identity,
  );
  const provider: JebAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute() {
      return ok(execution);
    },
  };
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { jebAnalysis: provider },
  );
  const client = new Client({ name: "jeb-contract", version: "1" });
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
    (tool) => tool.name === "inspect_jeb_client",
  );
  if (advertised?.inputSchema === undefined)
    throw new Error("JEB tools must publish both schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  expect(ajv.validateSchema(advertised.inputSchema)).toBe(true);
  const outputSchema: Record<string, unknown> = advertised.outputSchema ?? {};
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  expect(ajv.validate(advertised.inputSchema, {})).toBe(true);
  expect(ajv.validate(advertised.inputSchema, { unexpected: 1 })).toBe(false);

  const called = await client.callTool({
    name: "inspect_jeb_client",
    arguments: {},
  });
  expect(called.isError).not.toBe(true);
  const text = (called.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  const evidence = parseEvidence(JSON.parse(text));
  expect(evidence.provider.id).toBe("jeb");
  expect(evidence.normalized_result).toEqual(execution.result);
});

it("preserves JEB provider failure reasons through the MCP boundary", async () => {
  const contract = toolContract("list_jeb_units");
  const provider: JebAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute() {
      return ok(
        createAnalysisExecution(
          { engine: null, units: [], coverage: "complete" } as never,
          identity,
        ),
      );
    },
  };
  void contract;
  const unavailable: JebAnalysisPort = {
    ...provider,
    async execute() {
      const { AnalysisCapabilityUnavailableError } =
        await import("../../../src/domain/analysisErrorCore.js");
      return {
        ok: false as const,
        error: new AnalysisCapabilityUnavailableError(
          "jeb",
          "list_jeb_units",
          "connect ECONNREFUSED 127.0.0.1:8425",
          {
            userMessage:
              "Start a JEB client serving MCP (default http://127.0.0.1:8425/mcp) or set REA_JEB_MCP_URL to the running endpoint.",
          },
        ),
      };
    },
  };
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { jebAnalysis: unavailable },
  );
  const client = new Client({ name: "jeb-failure", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const failed = await client.callTool({
    name: "list_jeb_units",
    arguments: {},
  });
  expect(failed.isError).toBe(true);
  const text = (failed.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  expect(text).toContain("ECONNREFUSED");
  expect(text).toContain("REA_JEB_MCP_URL");
});
