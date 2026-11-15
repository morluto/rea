import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";
import {
  advertisedSchemaErrors,
  localInputReferences,
  recursiveReferences,
} from "../../fixtures/mcpAdvertisedSchemaValidity.js";
import { GENERATED_MCP_TOOL_CATALOG } from "../../fixtures/mcpToolCatalog.js";

// The generated catalog is built on the POSIX build host; live advertisement
// checks that must also hold on Windows stay in toolSchemaValidity.test.ts.

it("ships nonrecursive input and output schemas in the generated catalog", () => {
  expect(advertisedSchemaErrors(GENERATED_MCP_TOOL_CATALOG)).toEqual([]);
  expect(recursiveReferences(GENERATED_MCP_TOOL_CATALOG)).toEqual([]);
});

it("ships input schemas without local references in the generated catalog", () => {
  expect(localInputReferences(GENERATED_MCP_TOOL_CATALOG)).toEqual([]);
});

it("generates the catalog the MCP server advertises", async () => {
  const server = new McpServer({ name: "generated-catalog", version: "0" });
  const client = new Client({ name: "generated-catalog", version: "0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  for (const contract of TOOL_CONTRACTS)
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      async () => ({ content: [] }),
    );
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const project = (tool: (typeof tools)[number]) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    });
    expect(tools.map(project)).toEqual(
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
