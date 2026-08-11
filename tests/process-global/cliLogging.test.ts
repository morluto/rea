import { afterEach, describe, expect, it } from "vitest";

import { logCliCommand } from "../../src/cliLogging.js";
import { silentLogger } from "../../src/logger.js";

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
});

describe("CLI operation status", () => {
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
