import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { expect, it, onTestFinished } from "vitest";

import {
  TOOL_CONTRACTS,
  toolContract,
} from "../../../src/contracts/toolContracts.js";
import { createServer as createProductionServer } from "../../../src/server/createServer.js";
import { silentLogger } from "../../../src/logger.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { createCatalogIdentity } from "../../../src/contracts/catalog/catalogIdentity.js";
import type { ToolContract } from "../../../src/contracts/toolContractTypes.js";
import { advertisedSchemaErrors } from "../../fixtures/mcpAdvertisedSchemaValidity.js";
import {
  COMPACT_OUTPUT_SCHEMA_BUDGET_BYTES,
  type McpOutputSchemaProfile,
} from "../../../src/contracts/mcpSchemaPresentation.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const createServer = (outputSchemaProfile: McpOutputSchemaProfile) =>
  new EvidenceMcpServer(
    { name: "output-schema-fixture", version: "1" },
    { capabilities: {} },
    undefined,
    createToolResultDelivery(10 * 1024 * 1024),
    undefined,
    outputSchemaProfile,
  );

it("rejects canonical-invalid output when output schema advertisements are off", async () => {
  const server = createServer("off");
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "schema-profile-test", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const contract = {
    ...toolContract("comment"),
    name: "output_schema_fixture",
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ value: z.string() }),
  } satisfies ToolContract;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async () => ({
      content: [{ type: "text" as const, text: "invalid fixture" }],
      structuredContent: { value: 42 },
    }),
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    expect(tools).toMatchObject([{ name: contract.name }]);
    expect(tools[0]?.outputSchema).toBeUndefined();
    const invalid = await client.callTool({
      name: contract.name,
      arguments: {},
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Output validation error"),
      }),
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

it("strips nested guidance from compact output schemas and preserves result fields", async () => {
  const server = createServer("compact");
  expect(server.catalogIdentity.digests).toEqual(
    createCatalogIdentity({ outputSchemaProfile: "compact" }).digests,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "compact-output-test", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const contract = {
    ...toolContract("comment"),
    name: "compact_output_schema_fixture",
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({
      value: z.string().describe("Nested guidance leaves."),
      nested: z
        .object({ count: z.number().int() })
        .describe("Nested guidance leaves."),
    }),
  } satisfies ToolContract;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async () => ({
      content: [{ type: "text" as const, text: "fixture" }],
      structuredContent: { value: "complete", nested: { count: 1 } },
    }),
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    const advertised = tools.find((tool) => tool.name === contract.name)!
      .outputSchema as Record<string, unknown>;
    expect(advertised.type).toBe("object");
    expect(advertised.$id).toBeUndefined();
    expect((advertised.properties as Record<string, unknown>).value).toEqual({
      type: "string",
    });
    expect(
      (advertised.properties as Record<string, unknown>).nested,
    ).toMatchObject({ type: "object" });

    const success = await client.callTool({
      name: contract.name,
      arguments: {},
    });
    expect(success.isError).not.toBe(true);
    expect(success.structuredContent).toEqual({
      value: "complete",
      nested: { count: 1 },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

it("keeps both output profiles below a measured one-megabyte frame", async () => {
  const names = new Set(TOOL_CONTRACTS.map(({ name }) => name));
  const measure = async (profile: McpOutputSchemaProfile): Promise<number> => {
    const harness = await createApplicationMcpHarness({
      serverOptions: {
        environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: profile },
      },
    });
    try {
      const listed = await harness.client.listTools();
      expect(listed.tools).toHaveLength(names.size);
      expect(new Set(listed.tools.map((tool) => tool.name))).toEqual(names);
      if (profile === "off")
        expect(
          listed.tools.every((tool) => tool.outputSchema === undefined),
        ).toBe(true);
      if (profile === "compact") {
        // Validate the advertised documents as the client receives them, not
        // just their bytes: a projection that broke a reference or left an
        // invalid schema would otherwise still pass the budget assertion.
        expect(
          advertisedSchemaErrors(
            listed.tools.map((tool) => ({
              name: tool.name,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
            })),
          ),
        ).toEqual([]);
        for (const tool of listed.tools) {
          expect(tool.outputSchema).toBeDefined();
          expect(
            Buffer.byteLength(JSON.stringify(tool.outputSchema), "utf8"),
          ).toBeLessThanOrEqual(COMPACT_OUTPUT_SCHEMA_BUDGET_BYTES);
        }
      }
      return Buffer.byteLength(JSON.stringify(listed), "utf8");
    } finally {
      await harness.close();
    }
  };

  const compactBytes = await measure("compact");
  const offBytes = await measure("off");
  expect(compactBytes).toBeLessThan(1024 * 1024);
  expect(offBytes).toBeLessThan(1024 * 1024);
  expect(compactBytes).toBeGreaterThan(offBytes);
});

it("rejects canonical-invalid output that the reduced advertisement accepts", async () => {
  // Enough nested detail that the compact projection cannot inline the
  // canonical schema within the budget, so the advertised form is the shallow
  // root shape rather than the complete validation structure.
  const nestedDetail = Object.fromEntries(
    Array.from({ length: 150 }, (_, index) => [
      `nested_${String(index).padStart(3, "0")}`,
      z.string().optional(),
    ]),
  );
  const outputSchema = z
    .strictObject({
      value: z.string(),
      payload: z.object({
        inner: z.string(),
        count: z.number().int(),
        ...nestedDetail,
      }),
    })
    .describe("Fixture result envelope.");
  const server = createServer("compact");
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "reduced-output-test", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const contract = {
    ...toolContract("comment"),
    name: "reduced_output_schema_fixture",
    inputSchema: z.strictObject({}),
    outputSchema,
  } satisfies ToolContract;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async () => ({
      content: [{ type: "text" as const, text: "fixture" }],
      structuredContent: {
        value: "complete",
        payload: { inner: "text", count: 1 },
      },
    }),
  );
  // `payload.inner` is a string canonically. The shallow advertisement keeps
  // only `payload: {type: "object"}`, so it accepts the malformed value.
  const malformed = {
    value: "complete",
    payload: { inner: 42, count: 1 },
  };
  const invalidContract = {
    ...contract,
    name: "invalid_reduced_output_schema_fixture",
  } satisfies ToolContract;
  server.registerTool(
    invalidContract.name,
    toolRegistrationOptions(invalidContract),
    async () => ({
      content: [{ type: "text" as const, text: "invalid fixture" }],
      structuredContent: malformed,
    }),
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    const advertised = tools.find((tool) => tool.name === contract.name)!
      .outputSchema as Record<string, unknown>;
    expect(advertised.description).toContain("Fixture result envelope.");
    expect(advertised.description).toContain("reduced form");
    expect((advertised.properties as Record<string, unknown>).payload).toEqual({
      type: "object",
    });
    expect(
      Buffer.byteLength(JSON.stringify(advertised), "utf8"),
    ).toBeLessThanOrEqual(COMPACT_OUTPUT_SCHEMA_BUDGET_BYTES);
    // The regression this guards: the advertisement accepts a value the
    // canonical contract rejects, so validating results against the
    // advertisement instead of the contract would deliver malformed output.
    const validateAdvertised = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(advertised);
    expect(validateAdvertised(malformed)).toBe(true);
    expect(validateAdvertised({ payload: malformed.payload })).toBe(false);
    expect(validateAdvertised({ ...malformed, extra: true })).toBe(false);

    const success = await client.callTool({
      name: contract.name,
      arguments: {},
    });
    expect(success.isError).not.toBe(true);
    expect(success.structuredContent).toEqual({
      value: "complete",
      payload: { inner: "text", count: 1 },
    });
    const invalid = await client.callTool({
      name: invalidContract.name,
      arguments: {},
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Output validation error"),
      }),
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

it.each(["REA_MCP_INPUT_SCHEMA_PROFILE", "REA_MCP_OUTPUT_SCHEMA_PROFILE"])(
  "rejects a retained full profile in $0 at server startup",
  async (setting) => {
    await expect(
      createApplicationMcpHarness({
        serverOptions: { environment: { [setting]: "full" } },
      }),
    ).rejects.toMatchObject({
      settings: [
        {
          setting,
          constraint: expect.stringMatching(/full.*removed.*compact/u),
        },
      ],
    });
  },
);

it("omits output schemas by default and still delivers validated structured results", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider may start for a catalog listing");
  });
  // An environment without the setting selects the product default.
  const server = createProductionServer(
    { kind: "session", session },
    { environment: { HOME: process.env.HOME }, logger: silentLogger },
  );
  const client = new Client(
    { name: "default-output-profile", version: "1" },
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
  const { tools } = await client.listTools();
  expect(tools).toHaveLength(TOOL_CONTRACTS.length);
  expect(
    tools.filter(({ outputSchema }) => outputSchema !== undefined),
  ).toEqual([]);
  // The SDK client accepts structured content from a tool without a listed
  // output schema; REA validated it against the canonical contract.
  const result = await client.callTool({
    name: "list_unknowns",
    arguments: {},
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({
    result: { items: [], total: 0, offset: 0, next_offset: null },
  });
});
