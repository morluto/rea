import { spawn, type ChildProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { OFFICIAL_TOOL_CONTRACTS } from "../src/contracts/toolContracts.js";
import type { HopperStartupDiagnostic } from "../src/domain/hopperStartupFailure.js";
import { ok } from "../src/domain/result.js";
import type {
  BridgeLauncher,
  BridgeSession,
} from "../src/hopper/BridgeLauncher.js";
import { HopperClient } from "../src/hopper/HopperClient.js";
import { LINUX_PRIVATE_DISPLAY_DIAGNOSTIC_PREFIX } from "../src/hopper/LinuxPrivateDisplayDiagnostic.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/fakeHopper.mjs", import.meta.url),
);

class FixtureLauncher implements BridgeLauncher {
  socketPaths: string[] = [];
  directories: string[] = [];
  processes: ChildProcess[] = [];

  constructor(readonly tokenOverride?: string) {}

  launch(session: BridgeSession) {
    this.socketPaths.push(session.socketPath);
    this.directories.push(session.directory);
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
        ownsProcessLifetime: true,
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
        ownsProcessLifetime: true,
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
        ownsProcessLifetime: true,
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
        ownsProcessLifetime: true,
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
const startClient = async () => {
  const client = new HopperClient({
    launcher: new FixtureLauncher(),
    requestTimeoutMs: 100,
    startupTimeoutMs: 1_000,
  });
  clients.push(client);
  await expect(client.start()).resolves.toEqual({
    ok: true,
    value: { name: "REA Hopper bridge", version: "1.0.0" },
  });
  return client;
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("HopperClient", () => {
  it("keeps the native socket path below macOS sockaddr_un limits", async () => {
    const launcher = new FixtureLauncher();
    const client = new HopperClient({ launcher, startupTimeoutMs: 1_000 });
    clients.push(client);
    const started = await client.start();
    expect(started.ok).toBe(true);
    expect(Buffer.byteLength(launcher.socketPaths[0] ?? "")).toBeLessThan(104);
  });

  it("parses fragmented health and correlates concurrent responses", async () => {
    const client = await startClient();
    const slow = client.callTool("echo", { label: "slow", delay: 30 });
    const fast = client.callTool("echo", { label: "fast", delay: 1 });
    await expect(Promise.all([slow, fast])).resolves.toEqual([
      { ok: true, value: { label: "slow", delay: 30 } },
      { ok: true, value: { label: "fast", delay: 1 } },
    ]);
  });

  it("routes every established operation through the authenticated bridge", async () => {
    const client = await startClient();
    const results = await Promise.all(
      OFFICIAL_TOOL_CONTRACTS.map(({ name }) => client.callTool(name, {})),
    );
    expect(results).toHaveLength(33);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("rejects a bridge session with the wrong capability token", async () => {
    const client = new HopperClient({
      launcher: new FixtureLauncher("wrong-token"),
      startupTimeoutMs: 1_000,
    });
    clients.push(client);
    const result = await client.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("HopperRemoteError");
  });

  it.each([
    ["malformed", "HopperProtocolError"],
    ["wrong_id", "HopperProtocolError"],
    ["remote_error", "HopperRemoteError"],
    ["hang", "HopperTimeoutError"],
    ["exit", "HopperProcessError"],
  ])("projects %s as %s", async (method, expectedTag) => {
    const client = await startClient();
    const result = await client.callTool(method);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe(expectedTag);
  });

  it("preserves a sanitized bridge exception diagnostic", async () => {
    const client = await startClient();
    const result = await client.callTool("remote_error");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        _tag: "HopperRemoteError",
        diagnosticType: "bridge_exception",
      });
  });

  it("cancels and ignores late responses without corrupting the session", async () => {
    const client = await startClient();
    const controller = new AbortController();
    const pending = client.callTool("hang", {}, { signal: controller.signal });
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok)
      expect(cancelled.error._tag).toBe("HopperCancelledError");

    const timedOut = await client.callTool(
      "echo",
      { delay: 30 },
      { timeoutMs: 5 },
    );
    expect(timedOut.ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(client.callTool("echo", { value: "alive" })).resolves.toEqual({
      ok: true,
      value: { value: "alive" },
    });
  });

  it("cancels bridge startup without waiting for the startup timeout", async () => {
    const client = new HopperClient({
      launcher: new CancelThenFixtureLauncher(),
      startupTimeoutMs: 10_000,
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
    const client = new HopperClient({ launcher, startupTimeoutMs: 20 });
    clients.push(client);

    const result = await client.start();

    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "HopperTimeoutError", timeoutMs: 20 },
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

  it("ignores more than 1,024 late responses without corrupting the session", async () => {
    const client = await startClient();
    const timedOut = await Promise.all(
      Array.from({ length: 1_025 }, (_, index) =>
        client.callTool("echo", { index, delay: 150 }, { timeoutMs: 5 }),
      ),
    );
    expect(timedOut.every((result) => !result.ok)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(client.callTool("echo", { value: "alive" })).resolves.toEqual({
      ok: true,
      value: { value: "alive" },
    });
  });

  it("makes concurrent close callers await the same shutdown", async () => {
    const client = await startClient();
    let firstSettled = false;
    const first = client.close().then(() => {
      firstSettled = true;
    });
    await client.close();
    expect(firstSettled).toBe(true);
    await first;
  });

  it("makes sequential double-close leave no runtime or process listeners", async () => {
    const launcher = new FixtureLauncher();
    const client = new HopperClient({ launcher, startupTimeoutMs: 1_000 });
    clients.push(client);
    await expect(client.start()).resolves.toMatchObject({ ok: true });

    await client.close();
    await client.close();

    const directory = launcher.directories[0] ?? "";
    const child = launcher.processes[0];
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(child).toBeDefined();
    if (child === undefined)
      throw new Error("Fixture process was not captured");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(getEventListeners(child, "exit")).toHaveLength(0);
    expect(getEventListeners(child, "close")).toHaveLength(0);
    expect(getEventListeners(child, "error")).toHaveLength(0);
    expect(child.stderr).not.toBeNull();
    if (child.stderr === null) throw new Error("Fixture stderr is unavailable");
    expect(getEventListeners(child.stderr, "data")).toHaveLength(0);
  });

  it("does not finish startup after an immediate close", async () => {
    const client = new HopperClient({
      launcher: new FixtureLauncher(),
      startupTimeoutMs: 1_000,
    });
    clients.push(client);

    const starting = client.start();
    await client.close();

    const result = await starting;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("HopperCancelledError");
  });

  it("starts a fresh session after close completes", async () => {
    const client = await startClient();
    await client.close();

    await expect(client.start()).resolves.toEqual({
      ok: true,
      value: { name: "REA Hopper bridge", version: "1.0.0" },
    });
  });

  it("serializes a restart requested while close is in progress", async () => {
    const client = await startClient();
    const closing = client.close();
    const restarting = client.start();

    await closing;
    await expect(restarting).resolves.toEqual({
      ok: true,
      value: { name: "REA Hopper bridge", version: "1.0.0" },
    });
    await expect(client.callTool("echo", { value: "fresh" })).resolves.toEqual({
      ok: true,
      value: { value: "fresh" },
    });
  });
});
