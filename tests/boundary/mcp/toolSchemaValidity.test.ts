import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { emptyArraySchema } from "../../../src/domain/emptyArraySchema.js";
import { processScenarioSchema } from "../../../src/domain/process/processScenario.js";
import { GENERATED_MCP_TOOL_CATALOG } from "../../../src/generatedMcpToolCatalog.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

interface ToolSchemas {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown> | undefined;
  readonly annotations?: Record<string, unknown> | undefined;
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

function expectStrictInputSchemaParity(
  tools: readonly ToolSchemas[],
  ajv: Ajv2020,
): void {
  const advertised = new Map(tools.map((tool) => [tool.name, tool]));
  const names = [
    "inspect_managed_artifact",
    "inspect_managed_members",
    "inspect_managed_native_boundaries",
    "list_browser_targets",
    "open_binary",
    "close_binary",
    "binary_session",
    "find_changed_behavior",
    "build_call_path",
    "record_unknown",
    "update_unknown",
  ];
  for (const name of names) {
    const contract = TOOL_CONTRACTS.find(
      ({ name: toolName }) => toolName === name,
    );
    const tool = advertised.get(name);
    const example = contract?.examples[0];
    if (contract === undefined || tool === undefined || example === undefined)
      throw new Error(`${name} did not have an advertised example`);
    const malformed = { ...example.input, __unexpected_root_key__: true };
    expect(contract.inputSchema.safeParse(malformed).success, name).toBe(false);
    expect(ajv.compile(tool.inputSchema)(malformed), name).toBe(false);
  }
}

function expectKnownAuthorityHints(tools: readonly ToolSchemas[]): void {
  const advertised = new Map(tools.map((tool) => [tool.name, tool]));
  const expected = {
    read_bytes: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    annotate_native_function: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    unset_bookmark: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    open_binary: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    close_binary: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  } as const;

  for (const [name, annotations] of Object.entries(expected))
    expect(advertised.get(name), name).toMatchObject({ annotations });
}

function expectRecursivePropertyDescriptions(
  schema: unknown,
  path: string,
): void {
  if (!isRecord(schema)) return;
  if (isRecord(schema.properties)) {
    for (const [property, child] of Object.entries(schema.properties)) {
      expect(child, `${path}.${property}`).toMatchObject({
        description: expect.any(String),
      });
      expectRecursivePropertyDescriptions(child, `${path}.${property}`);
    }
  }

  for (const key of ["items", "additionalProperties"])
    if (schema[key] !== undefined)
      expectRecursivePropertyDescriptions(schema[key], path);
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const children = schema[key];
    if (Array.isArray(children))
      children.forEach((child: unknown, index: number) =>
        expectRecursivePropertyDescriptions(child, `${path}.${key}[${index}]`),
      );
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const advertiseAndEnforceProcessEnvironmentKeyConstraint =
  async (): Promise<void> => {
    const contract = TOOL_CONTRACTS.find(
      ({ name }) => name === "capture_process_scenario",
    );
    if (contract === undefined)
      throw new Error("Process capture contract was not registered");

    let handlerCalled = false;
    const server = new McpServer({ name: "process-schema", version: "0" });
    server.registerTool(
      contract.name,
      {
        title: contract.title,
        description: contract.description,
        inputSchema: processScenarioSchema.shape,
      },
      async () => {
        handlerCalled = true;
        return {
          content: [{ type: "text" as const, text: "handler ran" }],
          isError: true,
        };
      },
    );
    const client = new Client({ name: "process-schema", version: "0" });
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

      const validate = new Ajv2020({
        strict: false,
        validateFormats: false,
      }).compile(advertised.inputSchema);
      const valid = { executable: "node", environment: { APP_MODE: "test" } };
      const reserved = {
        executable: "node",
        environment: { REA_PROCESS_RUN_ID: "caller-value" },
      };
      const reservedWithTrailingNewline = {
        executable: "node",
        environment: { "REA_PROCESS_RUN_ID\n": "caller-value" },
      };
      expect(validate(valid)).toBe(true);
      expect(contract.inputSchema.safeParse(valid).success).toBe(true);
      expect(validate(reserved)).toBe(false);
      expect(contract.inputSchema.safeParse(reserved).success).toBe(false);
      expect(validate(reservedWithTrailingNewline)).toBe(true);
      expect(
        contract.inputSchema.safeParse(reservedWithTrailingNewline).success,
      ).toBe(true);

      const result = await client.callTool({
        name: contract.name,
        arguments: reserved,
      });
      expect(result.isError).toBe(true);
      expect(handlerCalled).toBe(false);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  };

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
      expectKnownAuthorityHints(tools);
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const catalogProjection = tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      }));
      expect(catalogProjection).toEqual(
        GENERATED_MCP_TOOL_CATALOG.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations,
        })),
      );
      for (const contract of TOOL_CONTRACTS) {
        const tool = byName.get(contract.name);
        expect(tool?.title?.trim(), contract.name).toBeTruthy();
        expect(tool?.description?.trim(), contract.name).toBeTruthy();
        expect(tool?.inputSchema.examples, contract.name).toEqual(
          contract.examples.map(({ input }) => input),
        );
        for (const example of contract.examples)
          expect(
            contract.inputSchema.safeParse(example.input).success,
            `${contract.name}: ${example.title}`,
          ).toBe(true);
        expectRecursivePropertyDescriptions(tool?.inputSchema, contract.name);
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("advertises the structural request requirements enforced at runtime", async () => {
    const server = new McpServer({ name: "schema-constraints", version: "0" });
    const client = new Client({ name: "schema-constraints", version: "0" });
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
      const advertised = new Map(tools.map((tool) => [tool.name, tool]));
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      const graphContract = TOOL_CONTRACTS.find(
        ({ name }) => name === "project_managed_application_graph",
      );
      const graphTool = advertised.get("project_managed_application_graph");
      if (graphContract === undefined || graphTool === undefined)
        throw new Error("Managed application graph tool was not advertised");
      expect(graphContract.inputSchema.safeParse({}).success).toBe(false);
      expect(ajv.compile(graphTool.inputSchema)({})).toBe(false);

      for (const contract of TOOL_CONTRACTS) {
        const validate = ajv.compile(
          advertised.get(contract.name)!.inputSchema,
        );
        for (const example of contract.examples)
          expect(
            validate(example.input),
            `${contract.name}: ${example.title}`,
          ).toBe(true);
      }

      expectStrictInputSchemaParity(tools, ajv);

      const nativeObservation = TOOL_CONTRACTS.find(
        ({ name }) => name === "observe_native_ui",
      );
      const nativeScenario = TOOL_CONTRACTS.find(
        ({ name }) => name === "capture_native_ui_scenario",
      );
      const nativeObservationTool = advertised.get("observe_native_ui");
      const nativeScenarioTool = advertised.get("capture_native_ui_scenario");
      if (
        nativeObservation === undefined ||
        nativeScenario === undefined ||
        nativeObservationTool === undefined ||
        nativeScenarioTool === undefined
      )
        throw new Error("Native UI tools were not registered");
      const target = { pid: 123, window_id: 456 };
      const scenario = {
        ...target,
        steps: [{ kind: "wait", milliseconds: 100 }],
      };
      const observationResult = nativeObservation.inputSchema.safeParse(target);
      const scenarioResult = nativeScenario.inputSchema.safeParse(scenario);
      expect(observationResult.success).toBe(true);
      expect(scenarioResult.success).toBe(true);
      expect(ajv.compile(nativeObservationTool.inputSchema)(target)).toBe(true);
      expect(ajv.compile(nativeScenarioTool.inputSchema)(scenario)).toBe(true);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});

it(
  "advertises and enforces the process-owned environment key constraint",
  advertiseAndEnforceProcessEnvironmentKeyConstraint,
);

describe("MCP process input JSON Schema", () => {
  it("advertises process strings without weakening terminal input", async () => {
    const server = new McpServer({
      name: "process-schema-validation",
      version: "0",
    });
    const client = new Client({
      name: "process-schema-validation",
      version: "0",
    });
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
      const processContract = TOOL_CONTRACTS.find(
        ({ name }) => name === "capture_process_scenario",
      );
      const processTool = (await client.listTools()).tools.find(
        ({ name }) => name === "capture_process_scenario",
      );
      if (processContract === undefined || processTool === undefined)
        throw new Error("Process scenario tool was not advertised");
      const validate = new Ajv2020({
        strict: false,
        validateFormats: false,
      }).compile(processTool.inputSchema);
      const base = { executable: "/usr/bin/true" };
      for (const input of [
        { ...base, executable: "/usr/bin/true\0" },
        { ...base, arguments: ["\0"] },
        { ...base, working_directory: "/tmp\0" },
        { ...base, environment: { KEY: "value\0" } },
        { ...base, filesystem_observation_paths: ["/tmp\0"] },
      ]) {
        expect(processContract.inputSchema.safeParse(input).success).toBe(
          false,
        );
        expect(validate(input)).toBe(false);
      }
      const terminalInput = {
        ...base,
        events: [{ type: "input", at_ms: 0, data: "\0" }],
      };
      expect(processContract.inputSchema.safeParse(terminalInput).success).toBe(
        true,
      );
      expect(validate(terminalInput)).toBe(true);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
