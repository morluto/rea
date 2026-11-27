import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { UNICORN_PYTHON_ENV_VAR } from "../../../src/unicorn/UnicornRelease.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

// The run needs the real engine, so the test only runs where the
// caller-supplied pwntools Python is configured; CI without it skips.
it.skipIf(process.env[UNICORN_PYTHON_ENV_VAR] === undefined)(
  "runs emulate_function through MCP with no binary open",
  async () => {
    const python = process.env[UNICORN_PYTHON_ENV_VAR]!;
    const session = createTestBinarySession(() => {
      throw new Error(
        "emulate_function must not open a deep-analysis provider",
      );
    });
    const server = createServer(
      { kind: "session", session },
      {
        environment: {
          ...process.env,
          [UNICORN_PYTHON_ENV_VAR]: python,
        },
      },
    );
    const client = new Client(
      { name: "unicorn-emulate-mcp", version: "1" },
      { jsonSchemaValidator: createMcpSchemaValidation() },
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

    // add: mov eax, edi; add eax, esi; ret — 40 + 2 = 42, target-free.
    const response = await client.callTool({
      name: "emulate_function",
      arguments: {
        architecture: "x86_64",
        function_bytes: "89f801f0c3",
        code_address: "0x1000000",
        registers: { rdi: "0x28", rsi: "0x2" },
        stack_address: "0x7f000000",
        stack_size: 65536,
      },
    });
    expect(response.isError).not.toBe(true);
    const evidence = parseEvidence(response.structuredContent);
    expect(evidence.normalized_result).toMatchObject({
      stop_reason: "returned",
      return_value: "0x2a",
    });
  },
);
