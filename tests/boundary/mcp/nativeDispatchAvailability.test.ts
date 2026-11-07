import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AnalysisClient,
  AnalysisProvider,
  CapabilityDescriptor,
} from "../../../src/application/AnalysisProvider.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import { AnalysisOutputError } from "../../../src/domain/analysisErrorCore.js";
import {
  inspectNativeDispatchMetadata,
  isAppleDispatchMetadataTarget,
} from "../../../src/domain/native/objcSwiftMetadata.js";
import { err, ok } from "../../../src/domain/result.js";
import type { ProviderRejectionCode } from "../../../src/domain/providerSelection.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { expandToolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { silentLogger } from "../../../src/logger.js";
import { NativeMacOSProvider } from "../../../src/native/NativeMacOSProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { NativeFixtureRunner } from "../../fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createSessionMcpHarness } from "./sessionMcpHarness.js";

const resources: Array<{ close(): Promise<unknown> }> = [];
let directory: string | undefined;

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const identity = {
  id: "fixture",
  name: "Fixture analysis provider",
  version: "1",
};
const dispatchMetadata = inspectNativeDispatchMetadata(
  [
    {
      address: "0x1000",
      name: "-[BuildViewController buildTapped:]",
    },
  ],
  1,
);
const symbolInventory = [
  { address: "0x1000", value: "-[BuildViewController buildTapped:]" },
];

type Operation = "inspect_native_dispatch_metadata" | "list_names";
type Scenario = {
  readonly name: string;
  readonly capabilities: readonly {
    readonly operation: Operation;
    readonly available: boolean;
    readonly reason?: string;
    readonly availabilityCode?: ProviderRejectionCode;
  }[];
  readonly directRuntimeFailure?: boolean;
  readonly unavailableReason?: "provider_unavailable" | "unsupported_host";
};

const directOnly: Scenario = {
  name: "direct metadata only",
  capabilities: [
    { operation: "inspect_native_dispatch_metadata", available: true },
  ],
};
const scenarios: readonly Scenario[] = [
  directOnly,
  {
    name: "symbol-only fallback",
    capabilities: [{ operation: "list_names", available: true }],
  },
  { name: "neither operation", capabilities: [] },
  {
    name: "direct operation unavailable with symbol fallback",
    capabilities: [
      {
        operation: "inspect_native_dispatch_metadata",
        available: false,
        reason: "Direct metadata inspection is unavailable.",
      },
      { operation: "list_names", available: true },
    ],
  },
  {
    name: "direct runtime failure with symbol fallback",
    capabilities: [
      { operation: "inspect_native_dispatch_metadata", available: true },
      { operation: "list_names", available: true },
    ],
    directRuntimeFailure: true,
  },
  {
    name: "direct host denial with usable symbol fallback",
    capabilities: [
      {
        operation: "inspect_native_dispatch_metadata",
        available: false,
        reason: "Direct metadata inspection requires another host.",
        availabilityCode: "unsupported_host",
      },
      { operation: "list_names", available: true },
    ],
  },
  {
    name: "unavailable direct operation without symbol fallback",
    capabilities: [
      {
        operation: "inspect_native_dispatch_metadata",
        available: false,
        reason: "Direct metadata inspection is unavailable.",
      },
    ],
    unavailableReason: "provider_unavailable",
  },
];

describe("native dispatch availability at the public MCP boundary", () => {
  it.each(scenarios)(
    "preserves $name capability semantics",
    async (scenario) => {
      directory = await createTestTempDirectory(
        "rea-native-dispatch-availability-",
      );
      const calls: Operation[] = [];
      const { mcp, first } = await createSessionMcpHarness(
        directory,
        () => provider(scenario, calls),
        resources,
      );
      const opened = await mcp.callTool({
        name: "open_binary",
        arguments: { path: first },
      });
      expect(opened.isError).not.toBe(true);

      try {
        const inventory = await readInventory(mcp);
        const availability = dispatchAvailability(inventory);
        const result = await mcp.callTool({
          name: "inspect_native_dispatch_metadata",
          arguments: { max_records: 10 },
        });
        assertExecution(scenario, result, calls);

        if (scenario.unavailableReason !== undefined) {
          expect(availability).toMatchObject({
            available: false,
            reason: scenario.unavailableReason,
            remediation: "Direct metadata inspection is unavailable.",
          });
        } else if (scenario === directOnly) {
          expect(availability).toMatchObject({
            available: true,
            reason: "available",
            remediation: null,
          });
        } else if (scenario.capabilities.length === 0) {
          expect(availability).toMatchObject({
            available: false,
            reason: "provider_missing",
          });
        } else {
          expect(availability).toMatchObject({
            available: true,
            reason: "available",
          });
        }
      } finally {
        const closed = await mcp.callTool({
          name: "close_binary",
          arguments: {},
        });
        expect(closed.isError).not.toBe(true);
      }
    },
  );

  it("keeps the binary reader refusal when the symbol fallback is unavailable", async () => {
    directory = await createTestTempDirectory("rea-native-dispatch-fallback-");
    const path = join(directory, "armv7");
    // A complete thin 32-bit armv7 MH_EXECUTE header with no load commands.
    const header = Buffer.alloc(28);
    header.writeUInt32LE(0xfeedface, 0);
    header.writeUInt32LE(12, 4);
    header.writeUInt32LE(9, 8);
    header.writeUInt32LE(2, 12);
    await writeFile(path, header);
    const calls: Operation[] = [];
    const mcp = await connectUnconfiguredSymbolFallback(calls);
    const opened = await mcp.callTool({
      name: "open_binary",
      arguments: { path },
    });
    expect(opened.isError).not.toBe(true);

    const result = await mcp.callTool({
      name: "inspect_native_dispatch_metadata",
      arguments: { max_records: 10 },
    });
    expect(parseMcpToolError(result).error).toMatchObject({
      code: "provider_unavailable",
      details: {
        operation: "list_names",
        rejections: [
          {
            provider_id: "fixture",
            origin: "availability",
            code: "not_configured",
          },
        ],
        diagnostics: {
          binary_metadata_failure: {
            code: "capability_unavailable",
            details: {
              provider_id: "native-macos",
              operation: "inspect_native_dispatch_metadata",
              reason: expect.stringMatching(/32-bit/u),
            },
          },
        },
      },
    });
    expect(calls).toEqual([]);
    const closed = await mcp.callTool({ name: "close_binary", arguments: {} });
    expect(closed.isError).not.toBe(true);
  });

  it("reports a target requirement before probing provider operations", async () => {
    directory = await createTestTempDirectory("rea-native-dispatch-no-target-");
    const calls: Operation[] = [];
    const { mcp } = await createSessionMcpHarness(
      directory,
      () => provider(directOnly, calls),
      resources,
    );
    const inventory = await readInventory(mcp);
    expect(inventory.result.open).toBe(false);
    expect(dispatchAvailability(inventory)).toMatchObject({
      available: false,
      reason: "target_required",
    });
    expect(calls).toEqual([]);
  });
});

const readInventory = async (mcp: Client) => {
  const result = await mcp.callTool({ name: "binary_session", arguments: {} });
  return toolContract("binary_session").outputSchema.parse(
    result.structuredContent,
  );
};

/**
 * Compose dispatch inspection with the real native reader and provider
 * registry: Mach-O targets open without a deep provider, and the only
 * `list_names` candidate is not configured. Calls to that candidate are recorded.
 */
const connectUnconfiguredSymbolFallback = async (
  calls: Operation[],
): Promise<Client> => {
  const symbols = provider(
    {
      name: "unconfigured symbol inventory",
      capabilities: [{ operation: "list_names", available: true }],
    },
    calls,
  );
  const session = composeBinarySession(
    new AnalysisProviderRegistry(
      [
        {
          ...symbols,
          resolveAnalysisProfile: () =>
            Promise.reject(new Error("Unavailable provider was resolved")),
          inspectAvailability: () => ({
            status: "unavailable",
            code: "not_configured",
            reason: "Fixture symbol provider is not configured.",
            diagnostics: {},
          }),
          inspectTargetSupport: () => ({
            status: "supported",
            code: null,
            reason: null,
            diagnostics: {},
          }),
        },
      ],
      "auto",
      isAppleDispatchMetadataTarget,
    ),
    // The real byte reader, with Darwin host support injected on any host.
    [new NativeMacOSProvider({}, new NativeFixtureRunner(), "darwin")],
  );
  const server = createServer(
    { kind: "session", session },
    { logger: silentLogger },
  );
  const mcp = new Client({ name: "native-dispatch-fallback", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(mcp, server, { close: () => session.close() });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return mcp;
};

const dispatchAvailability = (
  inventory: Awaited<ReturnType<typeof readInventory>>,
) =>
  expandToolAvailability(inventory.result.tool_availability).find(
    (entry) => entry.name === "inspect_native_dispatch_metadata",
  );

const assertExecution = (
  scenario: Scenario,
  result: CallToolResult,
  calls: readonly Operation[],
): void => {
  if (scenario.directRuntimeFailure) {
    expect(result.isError).toBe(true);
    expect(parseMcpToolError(result)).toMatchObject({
      error: { details: { operation: "inspect_native_dispatch_metadata" } },
    });
    expect(calls).toEqual(["inspect_native_dispatch_metadata"]);
    return;
  }
  if (
    scenario.capabilities.length === 0 ||
    scenario.unavailableReason !== undefined
  ) {
    expect(result.isError).toBe(true);
    expect(parseMcpToolError(result)).toMatchObject({
      error: { code: "capability_unavailable" },
    });
    expect(calls).toEqual([]);
    return;
  }
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    normalized_result: {
      result: {
        objc_dispatch_implementations: [
          {
            class_name: "BuildViewController",
            selector: "buildTapped:",
            implementation_address: "0x1000",
          },
        ],
      },
    },
  });
  if (
    scenario.capabilities.some(
      ({ operation, available }) =>
        operation === "inspect_native_dispatch_metadata" && available,
    )
  )
    expect(calls).toEqual(["inspect_native_dispatch_metadata"]);
  else expect(calls).toEqual(["list_names"]);
};

const provider = (scenario: Scenario, calls: Operation[]): AnalysisProvider => {
  const capabilities: CapabilityDescriptor[] = scenario.capabilities.map(
    (capability) => {
      const common = {
        provider: identity,
        operation: capability.operation,
        effects: {
          mutatesArtifact: false,
          launchesProcess: false,
          mayShowUi: false,
          mayAccessNetwork: false,
          mayWriteFilesystem: false,
          changesPermissions: false,
          requiresRoot: false,
        },
        limitations: [],
      };
      return capability.available
        ? { ...common, available: true as const, reason: null }
        : {
            ...common,
            available: false as const,
            reason: capability.reason ?? "Fixture capability is unavailable.",
            ...(capability.availabilityCode === undefined
              ? {}
              : { availabilityCode: capability.availabilityCode }),
          };
    },
  );
  return {
    identity: () => identity,
    capabilities: () => capabilities,
    createClient: (target, profile): AnalysisClient => ({
      execute: async (operation) => {
        if (operation === "health")
          return ok(createAnalysisExecution(null, identity));
        if (
          operation !== "inspect_native_dispatch_metadata" &&
          operation !== "list_names"
        )
          throw new Error(`Unexpected provider operation: ${operation}`);
        calls.push(operation);
        if (operation === "inspect_native_dispatch_metadata") {
          if (scenario.directRuntimeFailure)
            return err(
              new AnalysisOutputError(
                operation,
                "fixture direct metadata runtime failure",
              ),
            );
          return ok(
            createAnalysisExecution(
              {
                target_sha256: target.sha256,
                provider: identity,
                analysis_profile_digest: profile?.digest ?? null,
                result: dispatchMetadata,
              },
              identity,
              { subject: target },
            ),
          );
        }
        return ok(
          createAnalysisExecution(symbolInventory, identity, {
            subject: target,
            ...(profile === undefined ? {} : { analysisProfile: profile }),
          }),
        );
      },
      close: async () => ok(null),
    }),
  };
};
