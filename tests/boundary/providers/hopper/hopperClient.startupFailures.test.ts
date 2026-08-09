import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { projectAnalysisError } from "../../../../src/domain/errors.js";
import type { HopperStartupDiagnostic } from "../../../../src/domain/hopperStartupFailure.js";
import { ok } from "../../../../src/domain/result.js";
import type {
  BridgeLauncher,
  BridgeSession,
} from "../../../../src/hopper/BridgeLauncher.js";
import { HopperClient } from "../../../../src/hopper/HopperClient.js";
import { LINUX_PRIVATE_DISPLAY_DIAGNOSTIC_PREFIX } from "../../../../src/hopper/LinuxPrivateDisplayDiagnostic.js";

const fixturePath = fileURLToPath(
  new URL("../../../fixtures/fakeHopper.mjs", import.meta.url),
);

class FixtureLauncher implements BridgeLauncher {
  socketPaths: string[] = [];
  directories: string[] = [];
  runIds: string[] = [];
  processes: ChildProcess[] = [];

  constructor(readonly tokenOverride?: string) {}

  launch(session: BridgeSession) {
    this.socketPaths.push(session.socketPath);
    this.directories.push(session.directory);
    this.runIds.push(session.runId);
    const child = spawn(
      process.execPath,
      [
        fixturePath,
        session.socketPath,
        this.tokenOverride ?? session.token,
        session.runId,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    this.processes.push(child);
    return Promise.resolve(
      ok({
        process: child,
        ownsProcessLifetime: true as const,
        shutdownMode: "bridge-request" as const,
      }),
    );
  }
}

class SilentLauncher implements BridgeLauncher {
  launch() {
    return Promise.resolve(
      ok({
        process: spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          {
            stdio: ["ignore", "ignore", "pipe"],
          },
        ),
        ownsProcessLifetime: true as const,
        shutdownMode: "bridge-request" as const,
      }),
    );
  }
}

class CancelThenFixtureLauncher implements BridgeLauncher {
  #launches = 0;

  launch(session: BridgeSession) {
    this.#launches += 1;
    return this.#launches === 1
      ? new SilentLauncher().launch()
      : new FixtureLauncher().launch(session);
  }
}

class ExitingLauncher implements BridgeLauncher {
  constructor(readonly code: number) {}

  launch() {
    return Promise.resolve(
      ok({
        process: spawn(process.execPath, ["-e", `process.exit(${this.code})`], {
          stdio: ["ignore", "ignore", "pipe"],
        }),
        ownsProcessLifetime: true as const,
        shutdownMode: "bridge-request" as const,
      }),
    );
  }
}

class DiagnosticExitingLauncher implements BridgeLauncher {
  launch() {
    const diagnostic: HopperStartupDiagnostic = {
      schema_version: 1,
      component: "hopper_private_display",
      operation: "launch",
      status: "error",
      failure_code: "x11_socket_directory_unusable",
      reason: "socket_directory_read_only",
      socket_directory: "/tmp/.X11-unix",
      socket_directory_mode: "0777",
      mount_read_only: true,
      effective_socket_directory_mode: "0777",
      effective_mount_read_only: true,
      wsl: true,
      strategy: "direct",
      fallback_reason: null,
      xvfb_stderr_bytes: 100,
      xvfb_stderr_truncated: false,
    };
    const line = `${LINUX_PRIVATE_DISPLAY_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}\n`;
    return Promise.resolve(
      ok({
        process: spawn(
          process.execPath,
          [
            "-e",
            `process.stderr.write(${JSON.stringify(line)}, () => process.exit(80))`,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        ),
        ownsProcessLifetime: true as const,
        shutdownMode: "bridge-request" as const,
      }),
    );
  }
}

class LateSilentLauncher implements BridgeLauncher {
  readonly directories: string[] = [];
  readonly processes: ChildProcess[] = [];

  async launch(session: BridgeSession) {
    this.directories.push(session.directory);
    const launched = await new SilentLauncher().launch();
    if (launched.ok) this.processes.push(launched.value.process);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return launched;
  }
}

const clients: HopperClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("HopperClient startup failures", () => {
  it("cancels bridge startup without waiting for the startup timeout", async () => {
    const client = new HopperClient({
      launcher: new CancelThenFixtureLauncher(),
      // Keep the retry proof independent from scheduler pressure when the
      // complete boundary project is starting several child-process fixtures.
      startupTimeoutMs: 30_000,
    });
    clients.push(client);
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = client.callTool("echo", {}, { signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 10);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("HopperCancelledError");
    expect(Date.now() - startedAt).toBeLessThan(500);
    await expect(client.start()).resolves.toEqual({
      ok: true,
      value: { name: "REA Hopper bridge", version: "1.0.0" },
    });
    await expect(
      client.callTool("echo", { value: "retried" }),
    ).resolves.toEqual({
      ok: true,
      value: { value: "retried" },
    });
  });

  it("applies one deadline to launcher, socket, and health startup phases", async () => {
    const launcher = new LateSilentLauncher();
    const client = new HopperClient({ launcher, startupTimeoutMs: 500 });
    clients.push(client);

    const result = await client.start();

    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "HopperTimeoutError", timeoutMs: 500 },
    });
    expect(launcher.directories).toHaveLength(1);
    await expect(access(launcher.directories[0] ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const process = launcher.processes[0];
    expect(
      process !== undefined &&
        (process.exitCode !== null || process.signalCode !== null),
    ).toBe(true);
  });

  it.each([70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80])(
    "reports Linux adapter exit %i during bridge startup",
    async (exitCode) => {
      const client = new HopperClient({
        launcher: new ExitingLauncher(exitCode),
        startupTimeoutMs: 10_000,
      });
      clients.push(client);
      const result = await client.start();
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({
          _tag: "HopperProcessError",
          exitCode,
        });
    },
  );

  it("projects actionable CI remediation for Hopper UI, license, and lifecycle failures", async () => {
    const client = new HopperClient({
      launcher: new ExitingLauncher(75),
      startupTimeoutMs: 10_000,
    });
    clients.push(client);
    const result = await client.start();
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const projected = projectAnalysisError(result.error);
    expect(projected.message).toContain(
      "rea doctor --provider hopper --detail full --json",
    );
    expect(projected.message).toContain("UI or license prompt");
    expect(projected.message).toContain("close stale Hopper sessions");
    expect(projected.details).toMatchObject({
      failure_code: "hopper_exited_during_startup",
      exit_code: 75,
    });
  });

  it("preserves the bounded private-display diagnostic from an adapter exit", async () => {
    const client = new HopperClient({
      launcher: new DiagnosticExitingLauncher(),
      startupTimeoutMs: 10_000,
    });
    clients.push(client);
    const result = await client.start();
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "HopperProcessError",
        exitCode: 80,
        failureCode: "x11_socket_directory_unusable",
        diagnostic: {
          socket_directory: "/tmp/.X11-unix",
          socket_directory_mode: "0777",
          mount_read_only: true,
          wsl: true,
          strategy: "direct",
        },
      },
    });
  });

  it("allows a short-lived launcher to hand off bridge startup", async () => {
    const client = new HopperClient({
      launcher: new ExitingLauncher(0),
      startupTimeoutMs: 100,
    });
    clients.push(client);
    const result = await client.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("HopperTimeoutError");
  });
});
