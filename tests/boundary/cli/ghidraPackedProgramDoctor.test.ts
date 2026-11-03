import { join } from "node:path";
import { expect } from "vitest";

import { GHIDRA_PACKED_PROGRAM_RECOVERY } from "../../../src/config/ghidraExistingProject.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "explains how to import a packed Ghidra program before selecting a project",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-packed-project-doctor-");
    const result = await cli.run({
      arguments: ["--json", "doctor", "--provider", "ghidra"],
      environment: { REA_GHIDRA_PROJECT_PATH: join(root, "program.gzf") },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      healthy: false,
      scope_checks: expect.arrayContaining([
        expect.objectContaining({
          name: "runtime-configuration:REA_GHIDRA_PROJECT_PATH",
          ok: false,
          classification: "config_drift",
          detail: `REA_GHIDRA_PROJECT_PATH: ${GHIDRA_PACKED_PROGRAM_RECOVERY}`,
        }),
      ]),
    });
    for (const required of [
      "analyzeHeadless",
      "-import",
      "-noanalysis",
      ".gpr",
      "REA_GHIDRA_PROGRAM_NAME",
    ])
      expect(GHIDRA_PACKED_PROGRAM_RECOVERY).toContain(required);
  },
);
