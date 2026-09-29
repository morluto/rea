import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { GENERATED_MCP_TOOL_CATALOG } from "../../../src/generatedMcpToolCatalog.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

describe("tool registration options", () => {
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
      for (const contract of TOOL_CONTRACTS) {
        const tool = advertised.find(({ name }) => name === contract.name);
        expect(tool?.inputSchema.examples, contract.name).toEqual(
          contract.examples.map(({ input }) => input),
        );
        expect(
          missingPropertyDescriptions(tool?.inputSchema),
          contract.name,
        ).toEqual([]);
      }
      const analyzeFunction = advertised.find(
        ({ name }) => name === "analyze_function",
      );
      expect(analyzeFunction?.inputSchema.properties).toEqual({
        procedure: expect.objectContaining({ type: "string" }),
      });
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
});

const missingPropertyDescriptions = (
  value: unknown,
  path = "inputSchema",
): string[] => {
  if (Array.isArray(value))
    return value.flatMap((child, index) =>
      missingPropertyDescriptions(child, `${path}[${index}]`),
    );
  if (!isObject(value)) return [];

  const missing: string[] = [];
  if (isObject(value.properties))
    for (const [property, schema] of Object.entries(value.properties)) {
      const propertyPath = `${path}.properties.${property}`;
      if (!isObject(schema) || typeof schema.description !== "string")
        missing.push(propertyPath);
      missing.push(...missingPropertyDescriptions(schema, propertyPath));
    }
  for (const [key, child] of Object.entries(value))
    if (
      key !== "properties" &&
      key !== "examples" &&
      key !== "default" &&
      key !== "const" &&
      key !== "enum"
    )
      missing.push(...missingPropertyDescriptions(child, `${path}.${key}`));
  return missing;
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
