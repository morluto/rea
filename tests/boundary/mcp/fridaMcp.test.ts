import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";

import type { FridaInstrumentationPort } from "../../../src/application/frida/FridaInstrumentationPort.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

const createFridaTestProvider = (): FridaInstrumentationPort => ({
  async listDevices() {
    return {
      ok: true,
      value: {
        devices: [
          { deviceId: "remote-device", name: "target", type: "remote" },
        ],
        cleanupError: null,
      },
    };
  },
  async listProcesses() {
    return {
      ok: true,
      value: { deviceId: "remote-device", processes: [], cleanupError: null },
    };
  },
  async startSession(input) {
    return {
      ok: true,
      value: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        deviceId: "remote-device",
        target: String(input.mode),
        pid: 10,
        mode: input.mode,
        state: input.mode === "spawn" ? "paused" : "running",
      },
    };
  },
  async loadScript() {
    return {
      ok: true,
      value: {
        scriptId: "00000000-0000-4000-8000-000000000002",
        sourceKind: "inline",
        sourcePath: null,
        sourceSha256: "a".repeat(64),
        messages: [],
        messagesTruncated: false,
      },
    };
  },
  async resumeSession() {
    return { ok: true, value: null };
  },
  async unloadScript() {
    return { ok: true, value: null };
  },
  status(sessionId) {
    return {
      sessionId,
      deviceId: "remote-device",
      target: "fixture",
      pid: 10,
      mode: "attach",
      state: "running",
      scripts: [],
      messages: [],
      messagesTruncated: false,
    };
  },
  async closeSession() {
    return { ok: true, value: null };
  },
  async closeAll() {},
});

it("advertises Frida MCP schemas and keeps remote credentials out of results", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Binary provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    {
      fridaInstrumentation: createFridaTestProvider(),
    },
  );
  const client = new Client({ name: "frida-contract", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = (await client.listTools()).tools;
  const advertised = tools.find((tool) => tool.name === "list_frida_devices");
  if (
    advertised?.inputSchema === undefined ||
    advertised.outputSchema === undefined
  )
    throw new Error("Missing advertised Frida schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  const response = await client.callTool({
    name: "list_frida_devices",
    arguments: {
      remote: { address: "127.0.0.1:27042", token: "synthetic-secret-token" },
    },
  });
  expect(response.isError).not.toBe(true);
  expect(JSON.stringify(response.structuredContent)).not.toContain(
    "synthetic-secret-token",
  );
  expect(ajv.validate(outputSchema, response.structuredContent)).toBe(true);
  expect(toolContract("start_frida_session").effects.mutatesTarget).toBe(true);

  const processes = await client.callTool({
    name: "list_frida_processes",
    arguments: { device_id: "remote-device" },
  });
  expect(processes.isError).not.toBe(true);

  const started = await client.callTool({
    name: "start_frida_session",
    arguments: {
      mode: "attach",
      pid: 10,
      remote: { address: "127.0.0.1:27042", token: "synthetic-secret-token" },
    },
  });
  expect(started.isError).not.toBe(true);
  expect(JSON.stringify(started.structuredContent)).not.toContain(
    "synthetic-secret-token",
  );
  const loaded = await client.callTool({
    name: "load_frida_script",
    arguments: {
      session_id: "00000000-0000-4000-8000-000000000001",
      source_kind: "inline",
      source: "send('loaded');",
    },
  });
  expect(loaded.isError).not.toBe(true);
  expect(JSON.stringify(loaded.structuredContent)).not.toContain(
    "synthetic-secret-token",
  );
  const loadedValue = loaded.structuredContent;
  if (
    loadedValue === undefined ||
    typeof loadedValue !== "object" ||
    loadedValue === null ||
    !("evidence_id" in loadedValue) ||
    typeof loadedValue.evidence_id !== "string"
  )
    throw new Error("Expected inline Frida Evidence");
  const retainedEvidence = session.evidenceById(loadedValue.evidence_id);
  expect(JSON.stringify(retainedEvidence)).not.toContain(
    "synthetic-secret-token",
  );

  for (const [name, args] of [
    [
      "resume_frida_session",
      { session_id: "00000000-0000-4000-8000-000000000001" },
    ],
    [
      "unload_frida_script",
      {
        session_id: "00000000-0000-4000-8000-000000000001",
        script_id: "00000000-0000-4000-8000-000000000002",
      },
    ],
    [
      "frida_session_status",
      { session_id: "00000000-0000-4000-8000-000000000001" },
    ],
    [
      "close_frida_session",
      { session_id: "00000000-0000-4000-8000-000000000001" },
    ],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
  }

  const invalidAddress = await client.callTool({
    name: "list_frida_devices",
    arguments: {
      remote: { address: "tcp://127.0.0.1:27042?token=synthetic-secret-token" },
    },
  });
  expect(invalidAddress.isError).toBe(true);
});
