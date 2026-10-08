import { describe, expect, it } from "vitest";

import { ArtifactOperationError } from "./domain/artifactOperationError.js";
import { ConfigurationError } from "./domain/configurationErrors.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";

import { isCliOperationFailure, logCliCommand } from "./cliLogging.js";
import { silentLogger } from "./logger.js";
import { runSetup } from "./application/Setup.js";
import { isSetupFailure, type SetupResult } from "./application/SetupTypes.js";
import {
  FakeSetupHost,
  options as setupOptions,
} from "./application/Setup.fixture.js";
import { err } from "./domain/result.js";
import {
  isUpdateFailure,
  runUpdate,
  type UpdateHost,
} from "./application/Update.js";
import {
  isUninstallFailure,
  runUninstall,
  type UninstallHost,
} from "./application/Uninstall.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { isProcessCliFailure } from "./application/process/ProcessCli.js";

describe("CLI operation status classification", () => {
  it.each([
    [
      "projected error",
      projectAnalysisError(new ConfigurationError("invalid setting")),
    ],
    [
      "MCP-shaped projected error",
      {
        error: projectAnalysisError(new ConfigurationError("invalid setting")),
      },
    ],
    ["unhealthy diagnostic", { healthy: false, checks: [] }],
  ])("classifies %s as failure", (_label, value) => {
    expect(isCliOperationFailure(value)).toBe(true);
  });

  it.each([
    [
      "ordinary data with code",
      { code: "configuration_invalid", message: "source data" },
    ],
    [
      "evidence about an error",
      {
        result: projectAnalysisError(new ConfigurationError("source setting")),
      },
    ],
    ["requested dry run", { status: "planned" }],
    ["partial analysis", { status: "partial" }],
    ["unsupported facet with evidence", { status: "unsupported" }],
    ["cancelled setup", { status: "cancelled" }],
    ["ready setup", { status: "ready" }],
    ["complete uninstall", { status: "complete" }],
    ["current version", { status: "current" }],
    ["completed update", { status: "updated" }],
    ["healthy diagnostics", { healthy: true, checks: [] }],
    ["bounded evidence", { evidence: [{ truncated: true }] }],
  ])("keeps %s successful", (_label, value) => {
    expect(isCliOperationFailure(value)).toBe(false);
  });

  it("uses the process command's typed error output", () => {
    expect(
      isProcessCliFailure({
        error: "Process command failed",
        category: "invalid_input",
        message: "The capture input is invalid.",
      }),
    ).toBe(true);
    expect(isProcessCliFailure({ error: "data about an error" })).toBe(false);
  });
});

describe("CLI command outcome classification", () => {
  it("returns nonzero for the UpdateResult failure variant", async () => {
    const installation = {
      prefix: "/fixture",
      packageRoot: "/fixture/lib/node_modules/rea-agents",
    };
    const updateHost: UpdateHost = {
      installation: () => Promise.resolve(installation),
      latestVersion: () =>
        Promise.resolve(
          err({ kind: "unavailable", detail: "registry unavailable" }),
        ),
      installVersion: () => Promise.resolve(err("not called")),
      installedVersion: () => Promise.resolve(err("not called")),
      planMaintenance: () =>
        Promise.resolve({ status: "current", plannedActions: [] }),
    };
    const result = await runUpdate("3.2.1", updateHost);
    expect(result.status).toBe("failed");
    const previousExitCode = process.exitCode;
    const output = await logCliCommand(
      silentLogger,
      CLI_COMMANDS.update,
      async () => result,
      isUpdateFailure,
    );
    expect(output).toBe(result);
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
  });

  it.each(["needs_confirmation", "needs_human"] as const)(
    "returns nonzero for a real setup result with status %s",
    async (expectedStatus) => {
      const host = new FakeSetupHost();
      const setup: SetupResult =
        expectedStatus === "needs_human"
          ? await runSetup(
              { ...setupOptions(false), structured: false },
              host,
              () => Promise.resolve(true),
            )
          : await runSetup(
              { ...setupOptions(false), clientIds: ["cursor"] },
              Object.assign(host, {
                clients: [{ name: "cursor", configPath: "/cursor.json" }],
              }),
            );
      expect(setup.status).toBe(expectedStatus);
      const previousExitCode = process.exitCode;
      const output = await logCliCommand(
        silentLogger,
        CLI_COMMANDS.setup,
        async () => setup,
        isSetupFailure,
      );
      expect(output).toBe(setup);
      expect(process.exitCode).toBe(1);
      process.exitCode = previousExitCode;
    },
  );

  it("returns nonzero when the real uninstall outcome contains a failed action", async () => {
    const host: UninstallHost = {
      clients: () => Promise.resolve([]),
      removeClient: () =>
        Promise.resolve({ name: "client", status: "failed", detail: "write" }),
      removeSkill: () =>
        Promise.resolve({ name: "skill", status: "failed", detail: "write" }),
      purgeData: () => Promise.resolve([]),
    };
    const result = await runUninstall(false, host);
    expect(result.status).toBe("failed");
    const previousExitCode = process.exitCode;
    await logCliCommand(
      silentLogger,
      CLI_COMMANDS.uninstall,
      async () => result,
      isUninstallFailure,
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
  });
});

describe("CLI thrown analysis failures", () => {
  it("returns the shared projection with actionable failure coordinates", async () => {
    const previousExitCode = process.exitCode;
    try {
      const projected = await logCliCommand(
        silentLogger,
        "fixture",
        async () => {
          throw new ArtifactOperationError(
            "analyze_javascript_application",
            "integrity",
            {
              logicalPath: "src/main.js",
              declaredSha256: "a".repeat(64),
              calculatedSha256: "b".repeat(64),
              unpacked: true,
            },
          );
        },
      );
      expect(projected).toMatchObject({
        code: "artifact_integrity_mismatch",
        category: "integrity_mismatch",
        details: {
          logical_path: "src/main.js",
          declared_sha256: "a".repeat(64),
          calculated_sha256: "b".repeat(64),
        },
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
