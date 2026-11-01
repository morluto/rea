import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { readFile } from "node:fs/promises";
import { afterAll, expect, it } from "vitest";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const validation = createMcpSchemaValidation();
afterAll(() => validation.clear());

it.each(["full", "compact"] as const)(
  "preserves captured bit-field base and lookup observations in %s MCP",
  async (profile) => {
    // Captured from the source-owned Ghidra layout project described in #8224.
    const layout = JSON.parse(
      await readFile("tests/fixtures/nativeBitfieldLayout.json", "utf8"),
    );
    const provider = { id: "ghidra", name: "Ghidra", version: "12.1.4" };
    const session = createTestBinarySession(() => ({
      execute: async () => ok(createAnalysisExecution(layout, provider)),
      close: async () => ok(null),
    }));
    const server = createServer(
      { kind: "session", session },
      {
        environment: {
          REA_MCP_INPUT_SCHEMA_PROFILE: profile,
          REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
        },
      },
    );
    const client = new Client({ name: "bitfield-type", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const schema = (await client.listTools()).tools.find(
        (x) => x.name === "inspect_native_data_type",
      )?.outputSchema;
      if (schema === undefined)
        throw new Error("Missing data-type output schema");
      expect(validation.assertions.validateSchema(schema)).toBe(true);
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path: process.execPath },
      });
      expect(opened.isError).not.toBe(true);
      const result = await client.callTool({
        name: "inspect_native_data_type",
        arguments: { type: "/audit/layout/Packed" },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(
        validation.assertions.validate(schema, result.structuredContent),
        JSON.stringify(validation.assertions.errors),
      ).toBe(true);
      const evidence = parseEvidence(result.structuredContent);
      expect(evidence.normalized_result).toMatchObject({
        fields: expect.arrayContaining([
          expect.objectContaining({
            name: "low",
            type_id: "/uint:3",
            bit_size: 3,
            bit_offset: 0,
            bit_field: {
              base_type_id: "/uint",
              declared_bit_size: 3,
              component_type_lookup: "not-found",
              base_type_lookup: "equivalent",
            },
          }),
        ]),
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
      const closed = await session.close();
      if (!closed.ok) throw closed.error;
    }
  },
);
