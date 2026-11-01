import { describe, expect, it } from "vitest";

import {
  TOOL_CONTRACTS,
  toolContract,
} from "../../../src/contracts/toolContracts.js";
import { TOOL_FAMILY_DEFINITIONS } from "../../../src/contracts/toolFamilies.js";
import { registerSessionStatusTool } from "../../../src/server/registerSessionStatusTool.js";
import { jsonObjectSchema } from "../../../src/domain/jsonValue.js";
import {
  registerCatalog,
  scopedServer,
  sessionWithDirectOperations,
  withClient,
} from "../../support/mcp/sessionStatusMcp.js";
import type { SessionReport } from "../../support/mcp/sessionStatusMcp.js";

const familyTools = (...ids: readonly string[]): readonly string[] =>
  TOOL_FAMILY_DEFINITIONS.filter(({ id }) => ids.includes(id)).flatMap(
    ({ contracts }) => contracts.map(({ name }) => name),
  );

describe("MCP tool family advertising", () => {
  it("advertises every catalog tool when no scope is set", async () => {
    const server = scopedServer(undefined);
    registerCatalog(server);
    await withClient(server, async (client) => {
      expect(
        (await client.listTools()).tools.map(({ name }) => name).sort(),
      ).toEqual(TOOL_CONTRACTS.map(({ name }) => name).sort());
    });
  });

  it("advertises only the scoped families", async () => {
    const server = scopedServer(new Set(["session", "javascript-runtime"]));
    registerCatalog(server);
    await withClient(server, async (client) => {
      const advertised = (await client.listTools()).tools
        .map(({ name }) => name)
        .sort();
      expect(advertised).toEqual(
        [...familyTools("session", "javascript-runtime")].sort(),
      );
      expect(advertised).not.toContain("inspect_macho");
    });
  });

  it("fails calls to out-of-scope tools with the disabled-tool error", async () => {
    const server = scopedServer(new Set(["session"]));
    registerCatalog(server);
    await withClient(server, async (client) => {
      await expect(
        client.callTool({ name: "list_frida_devices" }),
      ).rejects.toThrow(/disabled/u);
    });
  });

  it("reflects the scope in availability reports", () => {
    const server = scopedServer(new Set(["session"]));
    registerCatalog(server);
    // Status reporting must not advertise a tool the registration disables.
    expect(server.advertisesTool("open_binary")).toBe(true);
    expect(server.advertisesTool("analyze_javascript_application")).toBe(false);
    expect(server.advertisesTool("inspect_macho")).toBe(false);
  });

  it("advertises every tool in availability reports when no scope is set", () => {
    const server = scopedServer(undefined);
    registerCatalog(server);
    for (const { name } of TOOL_CONTRACTS)
      expect(server.advertisesTool(name)).toBe(true);
  });

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
          diagnostics: {},
        } as const;
      };
      registerSessionStatusTool({
        server,
        session: sessionWithDirectOperations(),
        contract: toolContract("binary_session"),
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

  it("reports only advertised operations without erasing composed availability", async () => {
    // `session` advertises `get_navigation_context`, while `direct` owns the
    // operations its default mode composes.
    const server = scopedServer(new Set(["session"]));
    registerSessionStatusTool({
      server,
      session: sessionWithDirectOperations(),
      contract: toolContract("binary_session"),
      startedAt: new Date().toISOString(),
      availabilityPolicy: () => ({ processCaptureEnabled: false }),
      androidAnalysisAvailability: async () => ({
        status: "unavailable",
        code: "runtime_missing",
        reason: "android runtime is unavailable",
        diagnostics: {},
      }),
    });
    let content: Record<string, unknown> | undefined;
    await withClient(server, async (client) => {
      const result = await client.callTool({
        name: "binary_session",
        arguments: {},
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      content = jsonObjectSchema.parse(
        jsonObjectSchema.parse(result.structuredContent).result,
      );
    });

    const report = content as SessionReport | undefined;
    // The public report must follow the scope of `tools/list`.
    const reported = report?.capabilities
      ?.flatMap((set) => set.groups.flatMap(({ operations }) => operations))
      .sort();
    expect(reported).toEqual(["get_navigation_context", "open_binary"]);
    // Availability was built from the complete provider facts: the composed
    // tool needs operations the public report hides.
    const available = report?.tool_availability?.groups.find(({ names }) =>
      names.includes("get_navigation_context"),
    );
    expect(available).toMatchObject({
      available: true,
      reason: "available",
      default_mode_available: true,
    });
  });
});
