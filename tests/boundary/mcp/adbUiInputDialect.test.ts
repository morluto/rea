import { Ajv2020 } from "ajv/dist/2020.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { expect } from "vitest";
import { mcpTest } from "../../support/mcp/mcpFixture.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { ADB_UI_TOOL_CONTRACTS } from "../../../src/contracts/adb/adbUiToolContracts.js";
import { advertisedInputDialectViolations } from "../../../src/contracts/advertisedDialect.js";
import { COMPACT_INPUT_SCHEMA_BUDGET_BYTES } from "../../../src/contracts/mcpSchemaPresentation.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

// Actual SDK registration/admission with sentinel handlers; no Android provider
// is started, and advertisement widening must never authorize invalid dispatch.
mcpTest.for(["compact"] as const)(
  "keeps UI schemas portable and canonical admission strict in %s",
  async (profile, { mcp }) => {
    const server = new EvidenceMcpServer(
      { name: "adb-ui-dialect", version: "0" },
      { capabilities: {} },
      undefined,
      createToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
      profile === "compact"
        ? { budgetBytes: COMPACT_INPUT_SCHEMA_BUDGET_BYTES }
        : undefined,
    );
    const dispatched: unknown[] = [];
    for (const contract of ADB_UI_TOOL_CONTRACTS)
      server.registerTool(
        contract.name,
        toolRegistrationOptions(contract),
        async (input) => {
          dispatched.push(input);
          return {
            content: [{ type: "text", text: "sentinel reached" }],
            isError: true,
          };
        },
      );
    const client = await mcp.connect(server, {
      name: "adb-ui-dialect",
      version: "0",
    });
    const { tools } = await client.listTools();
    const named = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`Missing named UI tool ${name}`);
      return tool;
    };
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    for (const contract of ADB_UI_TOOL_CONTRACTS) {
      const tool = named(contract.name);
      expect(advertisedInputDialectViolations(tool)).toEqual([]);
      expect(ajv.validateSchema(tool.inputSchema)).toBe(true);
      const accepts = ajv.compile(tool.inputSchema);
      for (const example of contract.examples)
        expect(accepts(example.input)).toBe(true);
    }
    const scope = { serial: "emulator-5554", package: "com.example.app" };
    const oversized = {
      ...scope,
      selector: { text: { value: "x".repeat(16385) } },
    };
    expect(
      ajv.compile(named("find_adb_ui_elements").inputSchema)(oversized),
    ).toBe(true);
    for (const request of [
      {
        name: "inspect_adb_ui",
        arguments: { ...scope, serial: "emulator\u00a05554" },
      },
      {
        name: "find_adb_ui_elements",
        arguments: { ...scope, selector: {}, snapshot_id: "not-a-uuid" },
      },
      { name: "find_adb_ui_elements", arguments: oversized },
      {
        name: "wait_for_adb_ui",
        arguments: { ...scope, selector: {}, timeout_ms: 30001 },
      },
    ]) {
      const result = await client.callTool(request, {
        toolDefinition: named(request.name),
      });
      expect(parseMcpToolError(result).error.code).toBe("invalid_request");
    }
    expect(dispatched).toEqual([]);
    await client.callTool(
      { name: "inspect_adb_ui", arguments: scope },
      { toolDefinition: named("inspect_adb_ui") },
    );
    expect(dispatched).toEqual([
      { ...scope, display_id: 0, max_nodes: 500, timeout_ms: 10000 },
    ]);
  },
);
