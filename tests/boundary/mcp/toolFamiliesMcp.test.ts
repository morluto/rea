import type { Client } from "@modelcontextprotocol/client";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { expect, it, onTestFinished, vi } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { registerServiceTools } from "../../../src/server/serviceToolBindings.js";
import type { SessionStatusToolOptions } from "../../../src/server/sessionStatusTool.js";
import { silentLogger } from "../../../src/logger.js";
import { binaryTargetSummary } from "../../../src/application/binary/BinaryTargetSummary.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { jsonObjectSchema } from "../../../src/domain/jsonValue.js";
import { AnalysisProtocolError } from "../../../src/domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { ToolResultDelivery } from "../../../src/server/ToolResultDelivery.js";
import { createTestMcp } from "../../support/mcp/mcpFixture.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";

/** Bind `binary_session` the way production composition does. */
const registerSessionStatus = (options: SessionStatusToolOptions): void =>
  registerServiceTools(
    options.server,
    { sessionStatus: options },
    { logger: silentLogger },
  );

const scopedServer = (
  advertisedToolFamilies: ReadonlySet<string> | undefined,
): EvidenceMcpServer =>
  new EvidenceMcpServer(
    { name: "tool-families", version: "0" },
    { capabilities: {} },
    undefined,
    new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
    undefined,
    undefined,
    undefined,
    advertisedToolFamilies,
  );

const withClient = async (
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
const sessionWithDirectOperations = () => {
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

it.each([
  { scope: ["session"], probed: [] },
  { scope: ["session", "android", "adb"], probed: ["android", "adb"] },
  { scope: ["session", "artifact"], probed: ["evm"] },
])(
  "probes only advertised families for binary_session status ($scope)",
  async ({ scope, probed }) => {
    const server = scopedServer(new Set(scope));
    const calls: string[] = [];
    const probe = (name: string) => async () => {
      calls.push(name);
      return {
        status: "unavailable",
        code: "runtime_missing",
        reason: `${name} runtime is unavailable`,
        remediation: "Repair the fixture provider.",
        diagnostics: {},
      } as const;
    };
    registerSessionStatus({
      server,
      session: sessionWithDirectOperations(),
      startedAt: new Date().toISOString(),
      availabilityPolicy: () => ({ processCaptureEnabled: false }),
      androidAnalysisAvailability: probe("android"),
      adbAnalysisAvailability: probe("adb"),
      apktoolAnalysisAvailability: probe("apktool"),
      jebAnalysisAvailability: probe("jeb"),
      evmLimiterAvailability: probe("evm"),
    });
    await withClient(server, async (client) => {
      const result = await client.callTool({
        name: "binary_session",
        arguments: {},
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
    });
    expect(calls.sort()).toEqual([...probed].sort());
  },
);

it.each([
  { cleanup: false, unknown: false, sync: false },
  { cleanup: true, unknown: false, sync: false },
  { cleanup: true, unknown: true, sync: false },
  { cleanup: false, unknown: false, sync: true },
])(
  "joins sibling availability probes before returning a probe failure ($cleanup, $unknown, $sync)",
  async ({ cleanup, unknown, sync }) => {
    const server = scopedServer(
      new Set(["session", "android", "adb", "apktool"]),
    );
    let started!: () => void;
    let release!: () => void;
    const adbStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adbRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerSessionStatus({
      server,
      session: sessionWithDirectOperations(),
      startedAt: new Date().toISOString(),
      availabilityPolicy: () => ({ processCaptureEnabled: false }),
      androidAnalysisAvailability: async () => {
        if (sync)
          return {
            status: "available",
            code: null,
            reason: null,
            diagnostics: {},
          };
        await adbStarted;
        throw unknown
          ? new Error("controlled Android probe failure")
          : new AnalysisProtocolError("controlled Android probe failure");
      },
      ...(sync
        ? {
            apktoolAnalysisAvailability: () => {
              throw new AnalysisProtocolError(
                "controlled synchronous probe failure",
              );
            },
          }
        : {}),
      adbAnalysisAvailability: async () => {
        started();
        await adbRelease;
        if (cleanup)
          throw new ProviderCleanupError("adb", ["controlled ADB descriptor"], {
            reason: "controlled close failure",
          });
        return {
          status: "available",
          code: null,
          reason: null,
          diagnostics: {},
        };
      },
    });
    await withClient(server, async (client) => {
      let settled = false;
      const call = client
        .callTool({ name: "binary_session", arguments: {} })
        .then((result) => {
          settled = true;
          return result;
        });
      try {
        await awaitAcknowledgement(adbStarted, call, "ADB availability probe");
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        release();
        const result = await call;
        expect(parseMcpToolError(result).error).toMatchObject({
          code: cleanup ? "cleanup_incomplete" : "unreadable_output",
          category: "execution_failure",
          ...(cleanup
            ? {
                details: {
                  resources: ["controlled ADB descriptor"],
                  diagnostics: {
                    primary_error: {
                      code: unknown ? "execution_failure" : "unreadable_output",
                    },
                  },
                },
              }
            : {}),
        });
      } finally {
        started();
        release();
        await call;
      }
    });
  },
);

it("reports only advertised operations without erasing composed availability", async () => {
  // Navigation composes operations outside the advertised session family.
  const server = scopedServer(new Set(["session"]));
  registerSessionStatus({
    server,
    session: sessionWithDirectOperations(),
    startedAt: new Date().toISOString(),
    availabilityPolicy: () => ({ processCaptureEnabled: false }),
    androidAnalysisAvailability: async () => {
      throw new Error("Session-only status must not probe Android");
    },
  });
  await withClient(server, async (client) => {
    const result = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const report = toolContract("binary_session").outputSchema.parse(
      result.structuredContent,
    ).result;
    const reported = report.capabilities
      .flatMap((set) => set.groups.flatMap(({ operations }) => operations))
      .sort();
    expect(reported).toEqual(["get_navigation_context", "open_binary"]);
    const available = report.tool_availability.groups.find(({ names }) =>
      names.includes("get_navigation_context"),
    );
    expect(available).toMatchObject({
      available: true,
      reason: "available",
      default_mode_available: true,
    });
  });
});
