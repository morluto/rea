import { spawn } from "node:child_process";

import { expect, it, onTestFinished } from "vitest";

import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { ok } from "../../../../src/domain/result.js";
import type { BridgeLauncher } from "../../../../src/hopper/BridgeLauncher.js";
import { HopperClient } from "../../../../src/hopper/HopperClient.js";

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
            shutdownMode: "bridge-request" as const,
          }),
        );
      },
    };
    const client = new HopperClient({ launcher, startupTimeoutMs: 10_000 });
    onTestFinished(() => client.close());
    const result = await client.start();
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "HopperStartError" },
    });
    if (result.ok) throw new Error("Expected the launcher to fail");
    const projected = projectAnalysisError(result.error);
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
            shutdownMode: "bridge-request" as const,
          }),
        );
      },
    };
    const client = new HopperClient({ launcher, startupTimeoutMs: 10_000 });
    onTestFinished(() => client.close());
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
