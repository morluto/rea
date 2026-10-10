import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { compactAdvertisedInputSchema } from "../../../src/contracts/compactInputSchema.js";
import {
  COMPACT_INPUT_SCHEMA_BUDGET_BYTES,
  parseMcpInputSchemaProfile,
} from "../../../src/config/mcpInputSchemaProfile.js";
import { processScenarioSchema } from "../../../src/domain/process/processScenario.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

interface AdvertisedTool {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown> | undefined;
  readonly description?: string | undefined;
}

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const listToolsThroughTransport = async (
  server: EvidenceMcpServer,
): Promise<readonly AdvertisedTool[]> => {
  const client = new Client({ name: "compact-profile", version: "0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return (await client.listTools()).tools;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
};

const registerCatalog = (server: EvidenceMcpServer): void => {
  for (const contract of TOOL_CONTRACTS)
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      async () => ({ content: [] }),
    );
};

const compactServer = (): EvidenceMcpServer =>
  new EvidenceMcpServer(
    { name: "compact-profile", version: "0" },
    { capabilities: {} },
    undefined,
    new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
    { budgetBytes: COMPACT_INPUT_SCHEMA_BUDGET_BYTES },
  );

const fullServer = (): EvidenceMcpServer =>
  new EvidenceMcpServer(
    { name: "full-profile", version: "0" },
    { capabilities: {} },
    undefined,
    new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
  );

describe("MCP compact input schema profile", () => {
  it("advertises every tool input schema within the provider budget", async () => {
    const server = compactServer();
    registerCatalog(server);
    const tools = await listToolsThroughTransport(server);
    expect(tools.map(({ name }) => name).sort()).toEqual(
      TOOL_CONTRACTS.map(({ name }) => name).sort(),
    );
    const oversized = tools.filter(
      ({ inputSchema }) =>
        serializedBytes(inputSchema) > COMPACT_INPUT_SCHEMA_BUDGET_BYTES,
    );
    expect(oversized.map(({ name }) => name)).toEqual([]);
  });

  it("keeps output schemas and tool descriptions identical to the default profile", async () => {
    const compact = compactServer();
    const full = fullServer();
    registerCatalog(compact);
    registerCatalog(full);
    const [compactTools, fullTools] = await Promise.all([
      listToolsThroughTransport(compact),
      listToolsThroughTransport(full),
    ]);
    const fullByName = new Map(fullTools.map((tool) => [tool.name, tool]));
    expect(compactTools.length).toBe(fullTools.length);
    for (const tool of compactTools) {
      const reference = fullByName.get(tool.name);
      if (reference === undefined) throw new Error(`Missing ${tool.name}`);
      expect(tool.outputSchema, tool.name).toEqual(reference.outputSchema);
      expect(tool.description, tool.name).toBe(reference.description);
    }
  });

  it("keeps compact schemas valid and accepting canonical examples", async () => {
    const server = compactServer();
    registerCatalog(server);
    const tools = await listToolsThroughTransport(server);
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const contractsByName = new Map<string, (typeof TOOL_CONTRACTS)[number]>(
      TOOL_CONTRACTS.map((contract) => [contract.name, contract]),
    );
    for (const tool of tools) {
      expect(
        ajv.validateSchema(tool.inputSchema),
        `${tool.name}: ${ajv.errorsText(ajv.errors)}`,
      ).toBe(true);
      const contract = contractsByName.get(tool.name);
      const validate = ajv.compile(tool.inputSchema);
      for (const example of contract?.examples ?? [])
        expect(validate(example.input), `${tool.name}: ${example.title}`).toBe(
          true,
        );
    }
  });

  it("reduces at most the structurally oversized tools", async () => {
    const full = fullServer();
    registerCatalog(full);
    const tools = await listToolsThroughTransport(full);
    const reduced: string[] = [];
    for (const tool of tools) {
      const { presentation } = compactAdvertisedInputSchema(
        tool.inputSchema,
        COMPACT_INPUT_SCHEMA_BUDGET_BYTES,
      );
      if (presentation === "reduced") reduced.push(tool.name);
    }
    expect(reduced.sort()).toEqual([
      "build_reconstruction_obligation_ledger",
      "capture_browser_scenario",
      "compare_application_versions",
      "compare_web_captures",
      "evaluate_reconstruction_coverage",
      "project_managed_application_graph",
    ]);
    expect(tools.length).toBe(TOOL_CONTRACTS.length);
  });

  it("retains parameter types and avoids client-side reference expansion", async () => {
    const server = compactServer();
    registerCatalog(server);
    const tools = await listToolsThroughTransport(server);
    for (const tool of tools) {
      // Kimi Code 2.1.1 expands references and defaults description-only
      // properties to string. Inline schemas with explicit shallow types
      // avoid both conversions for the structurally oversized tools.
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain(
        '"$ref":',
      );
    }
    const comparison = tools.find(
      ({ name }) => name === "compare_managed_members",
    );
    expect(comparison?.inputSchema.properties).toMatchObject({
      left: {
        properties: {
          normalized_result: {
            type: ["null", "boolean", "object", "array", "number", "string"],
          },
        },
      },
    });
    const ledger = tools.find(
      ({ name }) => name === "build_reconstruction_obligation_ledger",
    );
    expect(ledger?.inputSchema.properties).toMatchObject({
      evidence_bundle: { type: "object" },
      reviewed_obligations: { type: "array" },
      manifest: { type: "object" },
    });
    const coverage = tools.find(
      ({ name }) => name === "evaluate_reconstruction_coverage",
    );
    expect(coverage?.inputSchema.properties).toMatchObject({
      coverage: { type: "object" },
      boundary_id: { type: "string" },
    });
  });

  it("parses the profile selection the server startup reads", () => {
    expect(parseMcpInputSchemaProfile("compact")).toEqual({
      ok: true,
      value: "compact",
    });
    expect(parseMcpInputSchemaProfile("surprise")).not.toHaveProperty("value");
  });
});

describe("MCP compact input schema canonical enforcement", () => {
  it("still rejects canonical-invalid arguments the compact advertisement accepts", async () => {
    const server = compactServer();
    const contract = TOOL_CONTRACTS.find(
      ({ name }) => name === "capture_process_scenario",
    );
    if (contract === undefined)
      throw new Error("Process capture contract was not registered");
    let handlerCalled = false;
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      async () => {
        handlerCalled = true;
        return {
          content: [{ type: "text" as const, text: "handler ran" }],
          isError: true,
        };
      },
    );
    const client = new Client({ name: "compact-validation", version: "0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const advertised = (await client.listTools()).tools.find(
        ({ name }) => name === contract.name,
      );
      if (advertised === undefined)
        throw new Error("Process capture tool was not advertised");
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      const validate = ajv.compile(advertised.inputSchema);
      const valid = { executable: "node", environment: { APP_MODE: "test" } };
      const reserved = {
        executable: "node",
        environment: { REA_PROCESS_RUN_ID: "caller-value" },
      };
      expect(validate(valid)).toBe(true);
      expect(processScenarioSchema.safeParse(valid).success).toBe(true);
      expect(processScenarioSchema.safeParse(reserved).success).toBe(false);
      const result = await client.callTool({
        name: contract.name,
        arguments: reserved,
      });
      expect(result.isError).toBe(true);
      expect(handlerCalled).toBe(false);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("compacts plain standard schemas that are not Zod instances", async () => {
    // Mirrors registerWebNetworkCaptureTool: a plain standard schema reusing
    // the advertised projection while owning its own permissive validator.
    const server = compactServer();
    const contract = TOOL_CONTRACTS.find(
      ({ name }) => name === "inspect_web_network_capture",
    );
    if (contract === undefined)
      throw new Error("Network capture contract was not registered");
    const registration = toolRegistrationOptions(contract);
    const inputSchema = {
      "~standard": {
        ...registration.inputSchema["~standard"],
        vendor: "rea-application",
        validate: (value: unknown) => ({ value }),
      },
    };
    server.registerTool(
      contract.name,
      { ...registration, inputSchema },
      async () => ({ content: [] }),
    );
    const tools = await listToolsThroughTransport(server);
    const advertised = tools.find(({ name }) => name === contract.name);
    if (advertised === undefined)
      throw new Error("Network capture tool was not advertised");
    expect(serializedBytes(advertised.inputSchema)).toBeLessThanOrEqual(
      COMPACT_INPUT_SCHEMA_BUDGET_BYTES,
    );
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    expect(ajv.validateSchema(advertised.inputSchema)).toBe(true);
  });
});
