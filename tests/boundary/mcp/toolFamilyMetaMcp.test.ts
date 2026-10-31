import { expect, it } from "vitest";

import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { REA_MCP_META_KEY } from "../../../src/contracts/toolContractTypes.js";
import { TOOL_FAMILY_DEFINITIONS } from "../../../src/contracts/toolFamilies.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { silentLogger } from "../../../src/logger.js";

// Both profiles because compact presentation rebuilds the registration config
// in EvidenceMcpServerCore.registerTool, a separate path that must keep _meta.
it.each(["full", "compact"] as const)(
  "advertises each tool's selectable family in tools/list _meta (%s profile)",
  async (profile) => {
    const harness = await createApplicationMcpHarness({
      session: createTestBinarySession(() => {
        throw new Error("tools/list must not acquire a binary provider");
      }),
      serverOptions: {
        logger: silentLogger,
        environment: { ...process.env, REA_MCP_INPUT_SCHEMA_PROFILE: profile },
      },
      clientIdentity: { name: "tool-family-meta", version: "1" },
    });
    const tools = (await harness.client.listTools()).tools;
    expect(tools).toHaveLength(TOOL_CONTRACTS.length);
    const advertised = Object.fromEntries(
      tools.map((tool) => [tool.name, tool._meta?.[REA_MCP_META_KEY]]),
    );
    expect(advertised).toEqual(
      Object.fromEntries(
        TOOL_FAMILY_DEFINITIONS.flatMap(({ id, contracts }) =>
          contracts.map(({ name }) => [name, { family: id }]),
        ),
      ),
    );
  },
);
