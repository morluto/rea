import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { GENERATED_MCP_TOOL_CATALOG } from "../../../src/generatedMcpToolCatalog.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

describe("tool registration options", () => {
  it("preserves canonical Zod parsers in the SDK schemas", () => {
    for (const contract of TOOL_CONTRACTS) {
      const options = toolRegistrationOptions(contract);
      expect(options.inputSchema).not.toBe(contract.inputSchema);
      expect(
        options.inputSchema.safeParse(contract.examples[0]?.input ?? {}),
      ).toEqual(
        contract.inputSchema.safeParse(contract.examples[0]?.input ?? {}),
      );
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
      expect(analyzeFunction?.inputSchema.properties).toMatchObject({
        include_assembly: {
          description: "Whether to include assembly in the result.",
        },
        max_instructions: {
          description: "Maximum permitted instructions for this operation.",
        },
        pseudocode_offset: {
          description: "Zero-based index of the first pseudocode to return.",
        },
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
