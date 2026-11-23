import { join } from "node:path";
import { expect, it } from "vitest";
import {
  TOOL_CONTRACT_GROUPS,
  toolContract,
} from "../../src/contracts/toolContracts.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";

it.each([
  { outputProfile: "off", scope: "session", runtimeTools: [] },
  {
    outputProfile: "compact",
    scope: "session,javascript-runtime",
    runtimeTools:
      TOOL_CONTRACT_GROUPS.JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS,
  },
] as const)(
  "keeps stdio discovery, status and calls in the same $scope scope with $outputProfile schemas",
  async ({ outputProfile, scope, runtimeTools }) => {
    const { client, call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: scope,
      ...(outputProfile === "compact"
        ? { REA_MCP_OUTPUT_SCHEMA_PROFILE: outputProfile }
        : {}),
    });
    const tools = (await client.listTools()).tools;
    const names = tools.map(({ name }) => name).sort();
    expect(names).toEqual(
      [...TOOL_CONTRACT_GROUPS.SESSION_TOOL_CONTRACTS, ...runtimeTools]
        .map(({ name }) => name)
        .sort(),
    );
    for (const tool of tools) {
      if (outputProfile === "off")
        expect(tool.outputSchema, tool.name).toBeUndefined();
      else expect(tool.outputSchema, tool.name).toBeDefined();
    }
    const reply = await call("binary_session", {});
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const status = toolContract("binary_session").outputSchema.parse(
      reply.structuredContent,
    ).result;
    expect(status.server_identity.catalog.counts.mcp_tools).toBe(names.length);
    expect(
      status.tool_availability.groups.flatMap(({ names }) => names).sort(),
    ).toEqual(names);
    await expect(
      call("inspect_native_exports", {
        path: join(process.cwd(), "disabled-target-is-never-read.elf"),
      }),
    ).rejects.toThrow(/disabled/u);
  },
);
