import type { Client } from "@modelcontextprotocol/client";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { onTestFinished, vi } from "vitest";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { ToolResultDelivery } from "../../../src/server/ToolResultDelivery.js";
import { jsonObjectSchema } from "../../../src/domain/jsonValue.js";
import { binaryTargetSummary } from "../../../src/application/binary/BinaryTargetSummary.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestMcp } from "./mcpFixture.js";

/** Shared shape of the binary_session normalized result used by status tests. */
export interface SessionReport {
  readonly capabilities?: readonly {
    readonly groups: readonly { readonly operations: readonly string[] }[];
  }[];
  readonly tool_availability?: {
    readonly groups: readonly {
      readonly names: readonly string[];
      readonly available: boolean;
      readonly reason: string | null;
      readonly default_mode_available?: boolean;
    }[];
  };
}

export const scopedServer = (
  advertisedToolFamilies: ReadonlySet<string> | undefined,
): EvidenceMcpServer =>
  new EvidenceMcpServer(
    { name: "tool-families", version: "0" },
    { capabilities: {} },
    undefined,
    new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
    undefined,
    "full",
    undefined,
    advertisedToolFamilies,
  );

export const registerCatalog = (server: EvidenceMcpServer): void => {
  for (const contract of TOOL_CONTRACTS)
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      async () => ({ content: [] }),
    );
};

export const withClient = async (
  server: EvidenceMcpServer,
  use: (client: Client) => Promise<void>,
): Promise<void> => {
  const mcp = createTestMcp();
  try {
    const client = await mcp.connect(server, {
      name: "tool-families",
      version: "0",
    });
    await use(client);
  } finally {
    await mcp.close();
  }
};

/** Preserve owner-produced lifecycle facts while varying the route under test. */
export const sessionWithDirectOperations = () => {
  const session = createTestBinarySession(() => {
    throw new Error("Status projection must not acquire a provider");
  });
  const status = session.status.bind(session);
  const projected = vi
    .spyOn(session, "status")
    .mockImplementation(async (options) => ({
      ...jsonObjectSchema.parse(await status(options)),
      open: true,
      ...binaryTargetSummary({
        path: "/fixture/tool-family-target",
        kind: "executable",
        format: "mach-o",
        architecture: "x86_64",
        availableArchitectures: ["x86_64"],
        sha256: "a".repeat(64),
      }),
      capabilities: [
        {
          provider: { id: "probe", name: "Probe", version: "1" },
          shared_limitations: [],
          groups: [
            {
              operations: [
                "open_binary",
                "get_navigation_context",
                "current_document",
                "current_address",
                "resolve_containing_procedure",
                "inspect_macho",
              ],
              effects: ["mutates_artifact"],
              limitations: [],
              available: true,
              reason: null,
              availability_code: null,
            },
          ],
        },
      ],
    }));
  onTestFinished(async () => {
    projected.mockRestore();
    const disposed = await session.dispose();
    if (!disposed.ok) throw disposed.error;
  });
  return session;
};
