import { describe, expect, it } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { registerSessionStatusTool } from "../../../src/server/registerSessionStatusTool.js";
import { jsonObjectSchema } from "../../../src/domain/jsonValue.js";
import {
  scopedServer,
  sessionWithDirectOperations,
  withClient,
} from "../../support/mcp/sessionStatusMcp.js";
import type { SessionReport } from "../../support/mcp/sessionStatusMcp.js";

const callStatus = async (
  arguments_: Record<string, unknown>,
): Promise<SessionReport> => {
  const server = scopedServer(new Set(["session"]));
  registerSessionStatusTool({
    server,
    session: sessionWithDirectOperations(),
    contract: toolContract("binary_session"),
    startedAt: new Date().toISOString(),
    availabilityPolicy: () => ({ processCaptureEnabled: false }),
    // Marks every probed provider's tools unavailable while the session
    // family's composed `get_navigation_context` stays available: the mixed
    // inventory the scope parameter filters.
    androidAnalysisAvailability: async () => ({
      status: "unavailable",
      code: "runtime_missing",
      reason: "android runtime is unavailable",
      diagnostics: {},
    }),
  });
  let report: SessionReport | undefined;
  await withClient(server, async (client) => {
    const result = await client.callTool({
      name: "binary_session",
      arguments: arguments_,
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    report = jsonObjectSchema.parse(
      jsonObjectSchema.parse(result.structuredContent).result,
    ) as SessionReport;
  });
  if (report === undefined)
    throw new Error("binary_session returned no normalized result");
  return report;
};

describe("binary_session tool_availability_scope", () => {
  it("keeps every availability group by default and with an explicit all scope", async () => {
    const withoutScope = await callStatus({});
    const withAllScope = await callStatus({ tool_availability_scope: "all" });
    // Session lifecycle facts differ between instances; the scope parameter
    // must not change the availability inventory itself.
    expect(withoutScope.tool_availability).toEqual(
      withAllScope.tool_availability,
    );
    const groups = withoutScope.tool_availability?.groups ?? [];
    expect(
      groups.some((group) => group.available === true),
      "expected at least one available group",
    ).toBe(true);
    expect(
      groups.some((group) => group.available === false),
      "expected at least one unavailable group",
    ).toBe(true);
  });

  it("keeps only unavailable groups with tool_availability_scope unavailable", async () => {
    const report = await callStatus({ tool_availability_scope: "unavailable" });
    const groups = report.tool_availability?.groups ?? [];
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((group) => group.available === false)).toBe(true);
    expect(groups.flatMap(({ names }) => names)).not.toContain(
      "get_navigation_context",
    );
    // The filter removes groups, not the inventory's session-wide facts.
    expect("client_requirements" in (report.tool_availability ?? {})).toBe(
      true,
    );
  });
});
