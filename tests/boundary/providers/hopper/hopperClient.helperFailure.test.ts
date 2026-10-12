import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { AnalysisError } from "../../../../src/domain/analysisErrorBase.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { ok } from "../../../../src/domain/result.js";
import type {
  BridgeLauncher,
  BridgeSession,
} from "../../../../src/hopper/BridgeLauncher.js";
import { HopperApplicationLauncher } from "../../../../src/hopper/BridgeLauncher.js";
import { HopperClient } from "../../../../src/hopper/HopperClient.js";
import { HopperFixtureLauncher } from "./hopperClient.fixture.js";

// Failure assertions keep the external document unknown. Teardown then publishes
// this run's authenticated bridge so normal cleanup can release its runtime/lease.
const trackFailedHelperClient = (
  launcher: BridgeLauncher,
  startupTimeoutMs = 10_000,
): HopperClient => {
  let session: BridgeSession | undefined;
  let external = false;
  const client = new HopperClient({
    launcher: {
      async launch(input, options) {
        session = input;
        const launched = await launcher.launch(input, options);
        external =
          launched.ok &&
          launched.value.providerLifetime === "external-application";
        return launched;
      },
    },
    startupTimeoutMs,
  });
  onTestFinished(async () => {
    const fixture = new HopperFixtureLauncher();
    const published =
      external && session !== undefined
        ? await fixture.launch(session)
        : undefined;
    try {
      const closed = await client.close();
      if (!closed.ok) throw closed.error;
      if (published !== undefined) {
        expect(fixture.requests.map((request) => request.method)).toEqual([
          "health",
          "shutdown_document",
        ]);
      }
      if (session !== undefined)
        await expect(access(session.directory)).rejects.toMatchObject({
          code: "ENOENT",
        });
    } finally {
      if (published?.ok) {
        const cleaned = await published.value.cleanup();
        expect(cleaned.cleaned).toBe(true);
      }
    }
  });
  return client;
};

const projectPrimaryStartupFailure = (error: AnalysisError) => {
  if (!error.cleanupIncomplete) return projectAnalysisError(error);
  expect(projectAnalysisError(error).code).toBe("cleanup_incomplete");
  const cause = error.cause;
  if (!(cause instanceof AggregateError))
    throw new Error("Cleanup failure did not retain its aggregate causes");
  const primary = cause.cause;
  if (!(primary instanceof AnalysisError))
    throw new Error("Cleanup failure lost its typed startup cause");
  return projectAnalysisError(primary);
};

it("does not equate an owned native helper exit with an external GUI exit", async () => {
  const directory = await createTestTempDirectory("rea-hopper-helper-failure-");
  const targetPath = join(directory, "target");
  await writeFile(targetPath, "fixture target");
  const launcher = new HopperApplicationLauncher({
    environment: {},
    launcherPath: process.execPath,
    targetPath,
    targetKind: "executable",
    loaderArgs: [
      "-e",
      'process.stderr.write("Hopper has not been found.\\n", () => process.exit(3))',
      "--",
    ],
    bridgeScriptPath: "/rea/hopper_bridge.py",
    launchMode: "native",
  });
  const client = trackFailedHelperClient(launcher);
  const result = await client.start();
  expect(result).toMatchObject({
    ok: false,
    error: {
      cleanupIncomplete: true,
      cause: { cause: { _tag: "HopperStartError" } },
    },
  });
  if (result.ok) throw new Error("Expected the native helper to fail");
  expect(projectPrimaryStartupFailure(result.error)).toMatchObject({
    details: {
      provider_state: "unknown",
      launcher: { exit_code: 3 },
    },
  });
  expect(client.operationHealth()).toMatchObject({
    state: "unknown",
    exitCode: null,
  });
});

it.each(["exit", "signal", "exit75"] as const)(
  "reports a failed non-owning launcher %s without waiting for bridge timeout or inventing a GUI exit",
  async (termination) => {
    let token = "";
    const launcher: BridgeLauncher = {
      launch(session) {
        token = session.token;
        const stdout = `API_KEY=local-evidence-kept ${token}\n`;
        const stderr = `Hopper has not been found. Spotlight is unavailable. ${token}\n`;
        const stop =
          termination === "signal"
            ? 'process.kill(process.pid, "SIGTERM")'
            : `process.exit(${termination === "exit75" ? 75 : 1})`;
        return Promise.resolve(
          ok({
            process: spawn(
              process.execPath,
              [
                "-e",
                `process.stdout.write(${JSON.stringify(stdout)}, () => process.stderr.write(${JSON.stringify(stderr)}, () => ${stop}));`,
              ],
              { stdio: ["ignore", "pipe", "pipe"] },
            ),
            ownsProcessLifetime: false as const,
            providerLifetime: "external-application" as const,
            shutdownMode: "bridge-request" as const,
          }),
        );
      },
    };
    const client = trackFailedHelperClient(launcher);
    const result = await client.start();
    expect(result).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        cause: { cause: { _tag: "HopperStartError" } },
      },
    });
    if (result.ok) throw new Error("Expected the launcher to fail");
    const projected = projectPrimaryStartupFailure(result.error);
    expect(projected).toMatchObject({
      code: "provider_unavailable",
      details: {
        stage: "launch",
        launcher: {
          exit_code:
            termination === "signal" ? null : termination === "exit75" ? 75 : 1,
          signal: termination === "signal" ? "SIGTERM" : null,
          stdout: {
            text: expect.stringContaining("API_KEY=local-evidence-kept"),
          },
          stderr: { text: expect.stringContaining("Spotlight is unavailable") },
        },
      },
    });
    expect(JSON.stringify(projected).includes(token)).toBe(false);
    expect(client.operationHealth()).toMatchObject({
      state: "unknown",
      stage: "launch",
      exitCode: null,
    });
  },
);

it.each([0, 1])(
  "reports owned process exit %s before bridge readiness as an observed exit",
  async (code) => {
    const launcher: BridgeLauncher = {
      launch() {
        return Promise.resolve(
          ok({
            process: spawn(process.execPath, ["-e", `process.exit(${code})`], {
              stdio: ["ignore", "pipe", "pipe"],
            }),
            ownsProcessLifetime: true as const,
            providerLifetime: "launcher-process" as const,
            shutdownMode: "bridge-request" as const,
          }),
        );
      },
    };
    const client = trackFailedHelperClient(launcher);
    const result = await client.start();
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "HopperProcessError", exitCode: code, stage: "launch" },
    });
    expect(client.operationHealth()).toMatchObject({
      state: "exited",
      exitCode: code,
    });
  },
);

it("preserves a successful helper's diagnostics when bridge readiness is never observed", async () => {
  let token = "";
  const launcher: BridgeLauncher = {
    launch(session) {
      token = session.token;
      return Promise.resolve(
        ok({
          process: spawn(
            process.execPath,
            [
              "-e",
              `process.stdout.write(${JSON.stringify("source=local-evidence ")} + ${JSON.stringify(session.token)}); process.stderr.write("loader callback pending");`,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          ),
          ownsProcessLifetime: false as const,
          providerLifetime: "external-application" as const,
          shutdownMode: "bridge-request" as const,
        }),
      );
    },
  };
  const client = trackFailedHelperClient(launcher, 1500);
  const result = await client.start();
  if (result.ok)
    throw new Error("Expected missing bridge readiness to time out");
  const projected = projectPrimaryStartupFailure(result.error);
  expect(projected).toMatchObject({
    code: "provider_timeout",
    details: {
      stage: "startup",
      launcher: {
        exit_code: 0,
        output_closed: true,
        stdout: { text: expect.stringContaining("source=local-evidence") },
        stderr: { text: "loader callback pending" },
      },
    },
  });
  expect(projected.message).toContain("bridge readiness");
  expect(projected.message).not.toContain("before it started");
  expect(JSON.stringify(projected)).not.toContain(token);
});
