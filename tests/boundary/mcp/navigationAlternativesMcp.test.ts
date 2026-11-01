import { describe, expect, it } from "vitest";

import { offeredOperationAlternatives } from "../../../src/application/OperationAlternatives.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { expandToolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { err, ok } from "../../../src/domain/result.js";
import { GhidraSessionError } from "../../../src/ghidra/GhidraSessionError.js";
import { silentLogger } from "../../../src/logger.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { connectGhidraMcp, ghidraFixtureResult } from "./ghidraMcpHarness.js";

type Client = Awaited<ReturnType<typeof connectGhidraMcp>>["mcp"];

const NAVIGATION = ["next_address", "prev_address"] as const;
const GHIDRA_ALTERNATIVES = [
  "inspect_native_instruction",
  "read_function_instructions",
  "procedure_assembly",
];
const GENERIC =
  "This analysis is unavailable for the current target. Choose another analysis or target.";

/** The owning formatter's remediation for exactly these offered tools. */
const remediationFor = (operation: string, offered: readonly string[]) =>
  offeredOperationAlternatives(operation, (alternative) =>
    offered.includes(alternative),
  )?.remediation;

const navigationRefusal = async (
  client: Client,
  name: (typeof NAVIGATION)[number],
) =>
  parseMcpToolError(
    await client.callTool({ name, arguments: { address: "0x401000" } }),
  ).error;

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
    // Explicitly unset so a developer's scoped catalog cannot leak in.
    {
      scope: "every family",
      environment: { REA_MCP_TOOL_FAMILIES: undefined },
    },
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
        for (const name of NAVIGATION)
          expect(await navigationRefusal(harness.mcp, name)).toEqual({
            code: "capability_unavailable",
            category: "unsupported_provider",
            message: GENERIC,
            retryable: false,
            remediation: {
              action: remediationFor(name, GHIDRA_ALTERNATIVES),
            },
            details: {
              provider_id: "ghidra",
              operation: name,
              reason: "operation is not declared by this provider",
              alternatives: GHIDRA_ALTERNATIVES,
            },
          });

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
              alternatives: GHIDRA_ALTERNATIVES,
            }),
          ]);
          for (const alternative of GHIDRA_ALTERNATIVES)
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
});

describe("address navigation refusal alternatives", () => {
  it("stop offering tools a provider failure made unavailable", async () => {
    let failAssembly = true;
    const harness = await connectGhidraMcp(
      "navigation-after-provider-failure",
      (operation, input) => {
        if (operation === "procedure_assembly" && failAssembly) {
          failAssembly = false;
          return Promise.resolve(
            err(new GhidraSessionError("protocol", "Malformed bridge reply")),
          );
        }
        return Promise.resolve(ok(ghidraFixtureResult(operation, input)));
      },
      { environment: { REA_MCP_TOOL_FAMILIES: undefined } },
    );
    const offeredInDiscovery = async () =>
      (await navigationAvailability(harness.mcp, "summary")).tools
        .filter(({ name }) => name === "next_address")
        .map((tool) =>
          "alternatives" in tool ? tool.alternatives : undefined,
        );
    try {
      const failed = await harness.mcp.callTool({
        name: "procedure_assembly",
        arguments: { procedure: "0x401000" },
      });
      expect(parseMcpToolError(failed).error.code).toBe("execution_failure");
      // The failure marks Ghidra's operations unavailable (assembly observed,
      // the others inferred), so neither discovery nor the refusal offers one.
      const generic = await navigationRefusal(harness.mcp, "next_address");
      expect(generic.remediation.action).toBe(GENERIC);
      expect(generic.details).not.toHaveProperty("alternatives");
      expect(await offeredInDiscovery()).toEqual([undefined]);

      // A later Ghidra success clears the inferred entries, while the
      // observed assembly failure stays until assembly itself succeeds.
      const listing = await harness.mcp.callTool({
        name: "read_function_instructions",
        arguments: { procedure: "0x401000" },
      });
      expect(listing.isError).not.toBe(true);
      const recovered = [
        "inspect_native_instruction",
        "read_function_instructions",
      ];
      const restored = await navigationRefusal(harness.mcp, "next_address");
      expect(restored.details?.alternatives).toEqual(recovered);
      expect(restored.remediation.action).toBe(
        remediationFor("next_address", recovered),
      );
      expect(await offeredInDiscovery()).toEqual([recovered]);

      const assembly = await harness.mcp.callTool({
        name: "procedure_assembly",
        arguments: { procedure: "0x401000" },
      });
      expect(assembly.isError).not.toBe(true);
      expect(
        (await navigationRefusal(harness.mcp, "next_address")).details
          ?.alternatives,
      ).toEqual(GHIDRA_ALTERNATIVES);
      expect(await offeredInDiscovery()).toEqual([GHIDRA_ALTERNATIVES]);
    } finally {
      await harness.close();
    }
  }, 30_000);

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
