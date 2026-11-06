import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { parseConfig } from "../../../src/config/parseConfig.js";
import { IdaProvider } from "../../../src/ida/IdaProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createIdaTarget, RecordingIdaMcp } from "../../fixtures/idaMcp.js";
import { createTestMcp } from "../../support/mcp/mcpFixture.js";

const ATTACHED_IDA_NAVIGATION = [
  "procedure_pseudo_code",
  "procedure_assembly",
  "read_function_instructions",
  "analyze_function",
] as const;
const IDA_NETWORK_DISCOVERY = [
  ...ATTACHED_IDA_NAVIGATION,
  "list_procedures",
  "search_strings",
  "batch_decompile",
  "decompile_all",
  "trace_native_values",
  "inspect_native_api",
] as const;

type DiscoveryStatus = {
  readonly capabilities: readonly {
    readonly provider: { readonly id: string };
    readonly groups: readonly {
      readonly operations: readonly string[];
      readonly effects: readonly string[];
    }[];
  }[];
  readonly tool_availability: {
    readonly groups: readonly {
      readonly names: readonly string[];
      readonly effects: readonly string[];
      readonly annotations: readonly string[];
    }[];
  };
};

const unconfiguredHostTool = {
  setupGuidance: "Set REA_JADX_MCP_JAR to the fixture JAR.",
  inspectAvailability: async () => ({
    status: "unavailable" as const,
    code: "not_configured" as const,
    reason: "Host tools are outside the IDA discovery fixture.",
    remediation: "Configure the host tool for a separate test.",
    diagnostics: { source: "test_fixture" },
  }),
  close: async () => {},
  execute: async (): Promise<never> => {
    throw new Error("Host-tool execution is outside the IDA discovery fixture");
  },
};

it("advertises attached IDA UI and network effects in SDK and session discovery", async () => {
  const { root, target } = await createIdaTarget();
  const mcp = createTestMcp();
  let session: ReturnType<typeof createTestBinarySession> | undefined;
  try {
    const registration = join(root, "registration.json");
    await writeFile(
      registration,
      JSON.stringify({ command: "fixture", mode: "attached" }),
    );
    const config = parseConfig({ REA_IDA_MCP_CONFIG: registration });
    if (!config.ok) throw config.error;
    const producer = new RecordingIdaMcp(target);
    session = createTestBinarySession(
      new IdaProvider(config.value, {}, () => producer),
    );
    expect((await session.open(target.path)).ok).toBe(true);
    const server = createServer(
      { kind: "session", session },
      {
        environment: { REA_LOG_LEVEL: "silent" },
        androidAnalysis: unconfiguredHostTool,
        adbDeviceAnalysis: unconfiguredHostTool,
        apktoolAnalysis: unconfiguredHostTool,
      },
    );
    const client = await mcp.connect(server);
    const tools = (await client.listTools()).tools;

    for (const name of ATTACHED_IDA_NAVIGATION) {
      const response = await client.callTool({
        name,
        arguments: { procedure: "main" },
      });
      expect(response.isError, name).not.toBe(true);
    }

    const response = await client.callTool({
      name: "binary_session",
      arguments: { detail: "complete" },
    });
    expect(response.isError).not.toBe(true);
    const status = (
      response.structuredContent as unknown as { result: DiscoveryStatus }
    ).result;
    const ida = status.capabilities.find(
      ({ provider }) => provider.id === "ida",
    );
    expect(ida).toBeDefined();

    for (const name of ATTACHED_IDA_NAVIGATION) {
      const capability = ida?.groups.find(({ operations }) =>
        operations.includes(name),
      );
      expect(capability?.effects, name).toEqual(
        expect.arrayContaining(["may_show_ui", "may_access_network"]),
      );
      const availability = status.tool_availability.groups.find(({ names }) =>
        names.includes(name),
      );
      expect(availability?.effects, name).toEqual(
        expect.arrayContaining(["changesUiState", "accessesNetwork"]),
      );
      expect(availability?.annotations, name).toContain("open_world");
      const advertised = tools.find((tool) => tool.name === name);
      expect(advertised?.annotations?.openWorldHint, name).toBe(true);
    }
    for (const name of IDA_NETWORK_DISCOVERY) {
      const advertised = tools.find((tool) => tool.name === name);
      expect(advertised?.annotations?.openWorldHint, name).toBe(true);
      const availability = status.tool_availability.groups.find(({ names }) =>
        names.includes(name),
      );
      expect(availability?.effects, name).toContain("accessesNetwork");
    }
    for (const name of ["trace_native_ui_action", "inspect_address_context"]) {
      const advertised = tools.find((tool) => tool.name === name);
      expect(advertised?.annotations?.openWorldHint, name).toBe(true);
    }
    const addressContext = status.tool_availability.groups.find(({ names }) =>
      names.includes("inspect_address_context"),
    );
    expect(addressContext?.effects).toContain("accessesNetwork");
    expect(addressContext?.annotations).toContain("open_world");
    for (const name of [
      "open_binary",
      "open_bundle_resources",
      "close_binary",
      "reset_investigation",
      "start_rizin_debug_session",
      "close_rizin_debug_session",
      "close_gdb_session",
    ]) {
      const advertised = tools.find((tool) => tool.name === name);
      expect(advertised?.annotations?.openWorldHint, name).toBe(true);
      const availability = status.tool_availability.groups.find(({ names }) =>
        names.includes(name),
      );
      expect(availability?.effects, name).toContain("accessesNetwork");
      expect(availability?.annotations, name).toContain("open_world");
    }
  } finally {
    await mcp.close();
    await session?.close();
    await rm(root, { recursive: true, force: true });
  }
});
