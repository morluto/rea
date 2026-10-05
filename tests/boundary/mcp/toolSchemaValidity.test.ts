import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { emptyArraySchema } from "../../../src/domain/emptyArraySchema.js";
import { GENERATED_MCP_TOOL_CATALOG } from "../../../src/generatedMcpToolCatalog.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

interface ToolSchemas {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown> | undefined;
}

function schemaErrors(tools: readonly ToolSchemas[]): string[] {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  return tools.flatMap((tool) =>
    ["inputSchema", "outputSchema"].flatMap((kind) => {
      const schema =
        kind === "inputSchema" ? tool.inputSchema : tool.outputSchema;
      if (schema === undefined || ajv.validateSchema(schema)) return [];
      return [`${tool.name}.${kind}: ${ajv.errorsText(ajv.errors)}`];
    }),
  );
}

describe("MCP JSON Schema validity", () => {
  it("preserves empty-array validation in the advertised representation", () => {
    const schema = z.toJSONSchema(emptyArraySchema);
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    expect(ajv.validateSchema(schema)).toBe(true);
    const validate = ajv.compile(schema);
    expect(validate([])).toBe(true);
    for (const value of [
      [null],
      ["candidate"],
      [0],
      [false],
      [{}],
      [[]],
      null,
      {},
    ])
      expect(validate(value)).toBe(false);
  });

  it("uses an oracle that rejects empty prefixItems under Draft 2020-12", () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    expect(ajv.defaultMeta()).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(ajv.validateSchema({ type: "array", prefixItems: [] })).toBe(false);
    expect(ajv.validateSchema({ type: "array", maxItems: 0 })).toBe(true);
  });

  it("advertises valid input and output schemas for every canonical tool", async () => {
    const server = new McpServer({ name: "schema-validation", version: "0" });
    const client = new Client({ name: "schema-validation", version: "0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    for (const contract of TOOL_CONTRACTS)
      server.registerTool(
        contract.name,
        toolRegistrationOptions(contract),
        async () => ({
          content: [],
        }),
      );
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name).sort()).toEqual(
        TOOL_CONTRACTS.map(({ name }) => name).sort(),
      );
      expect(schemaErrors(tools)).toEqual([]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("ships valid input and output schemas in the generated catalog", () => {
    expect(schemaErrors(GENERATED_MCP_TOOL_CATALOG)).toEqual([]);
  });
});
