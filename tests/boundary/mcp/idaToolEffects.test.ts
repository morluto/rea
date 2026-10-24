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
      { environment: { REA_LOG_LEVEL: "silent" } },
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
      arguments: {},
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
  } finally {
    await mcp.close();
    await session?.close();
    await rm(root, { recursive: true, force: true });
  }
});
