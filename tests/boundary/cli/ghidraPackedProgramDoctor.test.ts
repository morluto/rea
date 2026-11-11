import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

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
    const report = z
      .object({
        healthy: z.boolean(),
        scope_checks: z.array(
          z.object({
            name: z.string(),
            ok: z.boolean().optional(),
            classification: z.string().optional(),
            detail: z.string().optional(),
          }),
        ),
      })
      .parse(result.json);
    expect(report.healthy).toBe(false);
    const check = report.scope_checks.find(
      ({ name }) => name === "runtime-configuration:REA_GHIDRA_PROJECT_PATH",
    );
    expect(check).toMatchObject({ ok: false, classification: "config_drift" });
    for (const fact of [
      "REA_GHIDRA_PROJECT_PATH",
      ".gzf",
      ".gpr",
      "analyzeHeadless",
      "-import",
      "-noanalysis",
      "REA_GHIDRA_PROGRAM_NAME",
    ])
      expect(check?.detail).toContain(fact);
  },
);
