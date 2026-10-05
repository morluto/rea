import { afterEach, describe, expect, it } from "vitest";

import { logCliCommand } from "../../src/cliLogging.js";
import { silentLogger } from "../../src/logger.js";

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
});

describe("CLI operation status", () => {
  it("treats a requested setup dry run and cancellation as successful outcomes", async () => {
    for (const status of ["planned", "cancelled"]) {
      process.exitCode = undefined;
      await logCliCommand(silentLogger, "setup", () =>
        Promise.resolve({ status }),
      );
      expect(process.exitCode).toBeUndefined();
    }
  });

  it("keeps unapproved setup applications unsuccessful", async () => {
    process.exitCode = undefined;
    await logCliCommand(silentLogger, "setup", () =>
      Promise.resolve({ status: "needs_confirmation" }),
    );
    expect(process.exitCode).toBe(1);
  });

  it("sets a nonzero process status without replacing structured output", async () => {
    const output = {
      error: "Analysis failed",
      category: "integrity_mismatch",
      message: "Artifact integrity check failed.",
      details: { logical_path: "main.js" },
    };

    await expect(
      logCliCommand(silentLogger, "inspect-artifact", () =>
        Promise.resolve(output),
      ),
    ).resolves.toBe(output);
    expect(process.exitCode).toBe(1);
  });
});
