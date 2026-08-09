import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { GENERATED_MCP_TOOL_CATALOG } from "../../../src/generatedMcpToolCatalog.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

describe("tool registration options", () => {
  it("passes canonical Zod schemas directly to the MCP SDK", () => {
    for (const contract of TOOL_CONTRACTS) {
      const options = toolRegistrationOptions(contract);
      expect(options.inputSchema).toBe(contract.inputSchema);
      expect(options.outputSchema).toBe(contract.outputSchema);
    }
  });

  it("retains the canonical parser as the SDK validation boundary", async () => {
    const contract = TOOL_CONTRACTS.find(
      ({ name }) => name === "analyze_function",
    );
    expect(contract).toBeDefined();
    if (contract === undefined) return;

    const result = await contract.inputSchema["~standard"].validate({});
    expect("issues" in result).toBe(true);
  });

  it("generates the checked-in catalog from the SDK wire projection", async () => {
    const server = new McpServer({ name: "catalog-test", version: "0" });
    for (const contract of TOOL_CONTRACTS)
      server.registerTool(
        contract.name,
        toolRegistrationOptions(contract),
        async () => ({
          content: [{ type: "text" as const, text: "catalog-only" }],
          isError: true as const,
        }),
      );
    const client = new Client({ name: "catalog-test", version: "0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const advertised = (await client.listTools()).tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      }));
      expect(advertised).toEqual(
        GENERATED_MCP_TOOL_CATALOG.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations,
        })),
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("delegates output validation to the SDK boundary", async () => {
    const server = new McpServer({ name: "output-test", version: "0" });
    server.registerTool(
      "invalid_output",
      {
        inputSchema: z.object({}),
        outputSchema: z.object({ value: z.string() }),
      },
      async () => ({
        content: [{ type: "text", text: "invalid" }],
        structuredContent: { value: 42 },
      }),
    );
    const client = new Client({ name: "output-test", version: "0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: "invalid_output" });
      expect(result.isError).toBe(true);
      expect(result.content).toContainEqual(
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Output validation error"),
        }),
      );
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
