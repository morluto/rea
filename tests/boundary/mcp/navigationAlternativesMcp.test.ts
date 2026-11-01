import { describe, expect, it } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { expandToolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { silentLogger } from "../../../src/logger.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { connectGhidraMcp } from "./ghidraMcpHarness.js";

type Client = Awaited<ReturnType<typeof connectGhidraMcp>>["mcp"];

const NAVIGATION = ["next_address", "prev_address"] as const;
const GENERIC =
  "This analysis is unavailable for the current target. Choose another analysis or target.";

const navigationAvailability = async (
  client: Client,
  detail: "summary" | "complete",
) => {
  const reply = await client.callTool({
    name: "binary_session",
    arguments: { detail },
  });
  const status = toolContract("binary_session").outputSchema.parse(
    reply.structuredContent,
  ).result;
  const groups = status.tool_availability.groups.filter((group) =>
    NAVIGATION.some((name) => group.names.includes(name)),
  );
  return {
    groups,
    tools: expandToolAvailability(status.tool_availability),
  };
};

describe("address navigation refusals", () => {
  it.each([
    { scope: "every family", environment: {} },
    {
      scope: "session and direct families",
      environment: { REA_MCP_TOOL_FAMILIES: "session,direct" },
    },
  ])(
    "name Ghidra's instruction observations and their scope ($scope)",
    async ({ environment }) => {
      const harness = await connectGhidraMcp(
        "navigation-alternatives",
        undefined,
        { environment },
      );
      try {
        const alternatives = [
          "inspect_native_instruction",
          "read_function_instructions",
          "procedure_assembly",
        ];
        for (const name of NAVIGATION) {
          const { error } = parseMcpToolError(
            await harness.mcp.callTool({
              name,
              arguments: { address: "0x401000" },
            }),
          );
          expect(error).toEqual({
            code: "capability_unavailable",
            category: "unsupported_provider",
            message: GENERIC,
            retryable: false,
            remediation: {
              action: `For instruction-level questions, the current provider offers inspect_native_instruction (the decoded instruction or data at one exact address, with its length and static flow), read_function_instructions (one analyzed procedure's instruction listing in address order) and procedure_assembly (one analyzed procedure's assembly text). None navigates arbitrary analyzed objects such as data or addresses outside a procedure, and neither listing order nor address plus length proves executed control flow. Running ${name} itself requires a provider that declares it.`,
            },
            details: {
              provider_id: "ghidra",
              operation: name,
              reason: "operation is not declared by this provider",
              alternatives,
            },
          });
        }

        // Follow the suggested next step on the same connection.
        const listing = parseEvidence(
          (
            await harness.mcp.callTool({
              name: "read_function_instructions",
              arguments: { procedure: "0x401000" },
            })
          ).structuredContent,
        );
        expect(listing.provider.id).toBe("ghidra");
        expect(harness.calls).toContain("read_function_instructions");

        // Discovery names the same relation once for both navigation tools.
        for (const detail of ["summary", "complete"] as const) {
          const { groups, tools } = await navigationAvailability(
            harness.mcp,
            detail,
          );
          expect(groups).toEqual([
            expect.objectContaining({
              names: [...NAVIGATION],
              available: false,
              reason: "provider_missing",
              remediation:
                "Install or configure a provider that declares this operation.",
              alternatives,
            }),
          ]);
          for (const alternative of alternatives)
            expect(tools).toContainEqual(
              expect.objectContaining({ name: alternative, available: true }),
            );
        }
      } finally {
        await harness.close();
      }
    },
    30_000,
  );

  it("keep generic advice when the provider offers no declared alternative", async () => {
    const [target] = await createBinarySessionTargets();
    const { client } = await createApplicationMcpHarness({
      session: createTestBinarySession(createCacheProvider([])),
      clientIdentity: { name: "navigation-without-alternatives", version: "1" },
      serverOptions: { environment: {}, logger: silentLogger },
    });
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: target },
    });
    expect(opened.isError).not.toBe(true);
    for (const name of NAVIGATION) {
      const { error } = parseMcpToolError(
        await client.callTool({ name, arguments: { address: "0x1000" } }),
      );
      expect(error).toEqual({
        code: "capability_unavailable",
        category: "unsupported_provider",
        message: GENERIC,
        retryable: false,
        remediation: { action: GENERIC },
        details: {
          provider_id: "fixture",
          operation: name,
          reason: "operation is not declared by this provider",
        },
      });
    }
    const { groups } = await navigationAvailability(client, "summary");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      available: false,
      reason: "provider_missing",
    });
    expect(groups[0]).not.toHaveProperty("alternatives");
    expect(groups[0]?.names).toEqual(expect.arrayContaining([...NAVIGATION]));
  });
});
