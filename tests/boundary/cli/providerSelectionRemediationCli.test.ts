import { expect } from "vitest";

import { parseConfig } from "../../../src/config/parseConfig.js";
import { elf } from "../../../src/domain/binaryTarget.fixture.js";
import { IdaProvider } from "../../../src/ida/IdaProvider.js";
import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";

workspaceCliTest(
  "returns an unready IDA registration's repair for an explicit --provider selection",
  async ({ cli, workspace }) => {
    const registration = workspace.path("missing-ida.json");
    const target = await workspace.write("target.elf", elf(2, 1, 62));
    // The readiness owner is the oracle for the repair the caller receives.
    const config = parseConfig({ REA_IDA_MCP_CONFIG: registration });
    if (!config.ok) throw config.error;
    const ida = new IdaProvider(config.value, {}, () => {
      throw new Error("Readiness must not connect to IDA");
    });
    const owner = await ida.inspectAvailability();
    const released = await ida.closeOwnedResources();
    if (!released.ok) throw released.error;
    if (owner.status !== "unavailable")
      throw new Error("A missing registration must be unavailable");

    const result = await cli.run({
      arguments: ["decompile", target, "main", "--provider", "ida", "--json"],
      environment: {
        ...workspace.environment,
        REA_IDA_MCP_CONFIG: registration,
        REA_LOG_LEVEL: "silent",
      },
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.json).toMatchObject({
      remediation: { action: owner.remediation },
      details: {
        selection_reason: "provider_unavailable",
        requested_provider_id: "ida",
        rejections: expect.arrayContaining([
          expect.objectContaining({
            provider_id: "ida",
            origin: "availability",
            reason: owner.reason,
            remediation: owner.remediation,
          }),
        ]),
      },
    });
    expect(owner.remediation).toContain("REA_IDA_MCP_CONFIG");
  },
);
