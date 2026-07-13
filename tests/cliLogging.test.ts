import { afterEach, describe, expect, it } from "vitest";

import { isCliOperationFailure, logCliCommand } from "../src/cliLogging.js";
import { silentLogger } from "../src/logger.js";

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
});

describe("CLI operation status", () => {
  it.each([
    ["typed error", { error: "Analysis failed", category: "timeout" }],
    ["unhealthy diagnostic", { healthy: false, checks: [] }],
    ["failed status", { status: "failed" }],
    ["confirmation requirement", { status: "needs_confirmation" }],
    ["human remediation", { status: "needs_human" }],
    ["unapplied plan", { status: "planned" }],
  ])("classifies %s as failure", (_label, value) => {
    expect(isCliOperationFailure(value)).toBe(true);
  });

  it.each([
    ["ready setup", { status: "ready" }],
    ["complete uninstall", { status: "complete" }],
    ["current version", { status: "current" }],
    ["completed upgrade", { status: "upgraded" }],
    ["healthy diagnostics", { healthy: true, checks: [] }],
    ["bounded evidence", { evidence: [{ truncated: true }] }],
  ])("keeps %s successful", (_label, value) => {
    expect(isCliOperationFailure(value)).toBe(false);
  });

  it("sets a nonzero process status without replacing structured output", async () => {
    const output = {
      error: "Analysis failed",
      category: "integrity_mismatch",
      message: "Artifact integrity check failed.",
      details: { logical_path: "main.js" },
    };

    await expect(
      logCliCommand(silentLogger, "inventory-artifact", () =>
        Promise.resolve(output),
      ),
    ).resolves.toBe(output);
    expect(process.exitCode).toBe(1);
  });
});
