import { expect } from "vitest";
import { z } from "zod";
import {
  expandProviderCapabilities,
  providerCapabilitySet,
} from "../../src/contracts/toolOutputSchemaPrimitives.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "advertises temporary Mach-O operand writes through the capabilities CLI",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: ["capabilities", "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const status = z
      .object({ capabilities: z.array(providerCapabilitySet) })
      .parse(result.json);
    expect(expandProviderCapabilities(status.capabilities)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "inspect_macho",
          effects: {
            mutates_artifact: false,
            launches_process: true,
            may_show_ui: false,
            may_access_network: false,
            may_write_filesystem: true,
            changes_permissions: false,
            requires_root: false,
          },
        }),
      ]),
    );
  },
);
