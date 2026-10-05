import { afterEach, describe, expect, it } from "vitest";

import { logCliCommand } from "../../src/cliLogging.js";
import { silentLogger } from "../../src/logger.js";
import { ArtifactOperationError } from "../../src/domain/artifactOperationError.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import { runSetup } from "../../src/application/Setup.js";
import { isSetupFailure } from "../../src/application/SetupTypes.js";
import {
  FakeSetupHost,
  options as setupOptions,
} from "../../src/application/Setup.fixture.js";

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
    const host = new FakeSetupHost();
    host.availableClients = [{ name: "cursor", configPath: "/cursor.json" }];
    const result = await runSetup(
      { ...setupOptions(false), clientIds: ["cursor"] },
      host,
    );
    expect(result.status).toBe("needs_confirmation");
    expect(isSetupFailure(result)).toBe(true);
    process.exitCode = undefined;
    await logCliCommand(
      silentLogger,
      "setup",
      () => Promise.resolve(result),
      isSetupFailure,
    );
    expect(process.exitCode).toBe(1);
  });

  it("sets a nonzero process status without replacing structured output", async () => {
    const output = {
      error: "Analysis failed",
      ...projectAnalysisError(
        new ArtifactOperationError("inspect_artifact", "integrity", {
          logicalPath: "main.js",
          declaredSha256: "a".repeat(64),
          calculatedSha256: "b".repeat(64),
          unpacked: false,
        }),
      ),
    };

    await expect(
      logCliCommand(silentLogger, "inspect-artifact", () =>
        Promise.resolve(output),
      ),
    ).resolves.toBe(output);
    expect(process.exitCode).toBe(1);
  });
});
