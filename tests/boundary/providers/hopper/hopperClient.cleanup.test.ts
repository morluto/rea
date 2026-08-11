import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { projectAnalysisError } from "../../../../src/domain/errors.js";
import { ok } from "../../../../src/domain/result.js";
import type {
  BridgeLauncher,
  BridgeSession,
} from "../../../../src/hopper/BridgeLauncher.js";
import { HopperClient } from "../../../../src/hopper/HopperClient.js";
import { cleanupOwnedProcessGroup } from "../../../../src/process/ProcessOwnership.js";
import { spawnOwnedProviderProcess } from "../../../../src/process/ProviderProcess.js";

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
        ownsProcessLifetime: true,
        shutdownMode: "bridge-request" as const,
      }),
    );
  }
}

class OwnedFixtureLauncher implements BridgeLauncher {
  ownership:
    | {
        readonly runId: string;
        readonly leaderPid: number;
        readonly processGroupId: number;
      }
    | undefined;

  async launch(session: BridgeSession) {
    const started = await spawnOwnedProviderProcess({
      command: process.execPath,
      arguments: [
        fixturePath,
        session.socketPath,
        session.token,
        session.runId,
        "cleanup-required",
      ],
      runId: session.runId,
      expectedCommand: null,
    });
    this.ownership = started.ownership;
    return ok({
      process: started.process,
      ownsProcessLifetime: true as const,
      ownership: started.ownership,
      shutdownMode: "process-cleanup" as const,
      cleanup: () => cleanupOwnedProcessGroup(started.ownership),
    });
  }
}

class UnconfirmedFixtureLauncher implements BridgeLauncher {
  launch(session: BridgeSession) {
    return Promise.resolve(
      ok({
        process: spawn(
          process.execPath,
          [
            fixturePath,
            session.socketPath,
            session.token,
            session.runId,
            "unconfirmed",
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        ),
        ownsProcessLifetime: false,
        shutdownMode: "bridge-request" as const,
      }),
    );
  }
}

class UnconfirmedOwnedFixtureLauncher implements BridgeLauncher {
  launch(session: BridgeSession) {
    return Promise.resolve(
      ok({
        process: spawn(
          process.execPath,
          [
            fixturePath,
            session.socketPath,
            session.token,
            session.runId,
            "unconfirmed",
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        ),
        ownsProcessLifetime: true as const,
        shutdownMode: "bridge-request" as const,
      }),
    );
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

describe("HopperClient cleanup", () => {
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

  it("reports unconfirmed unowned document cleanup as a typed close failure", async () => {
    const client = new HopperClient({
      launcher: new UnconfirmedFixtureLauncher(),
      startupTimeoutMs: 1_000,
    });
    clients.push(client);
    expect((await client.start()).ok).toBe(true);

    const closed = await client.closeWithOutcome();

    expect(closed).toMatchObject({
      ok: false,
      error: {
        _tag: "ProviderAdapterError",
        cleanupIncomplete: true,
        cleanupResources: ["hopper-document"],
      },
    });
    if (!closed.ok)
      expect(projectAnalysisError(closed.error)).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          provider_id: "hopper",
          operation: "close_binary",
          cleanup: "incomplete",
          resources: ["hopper-document"],
        },
      });
  });

  it("does not treat an owned launcher exit as bridge document shutdown", async () => {
    const client = new HopperClient({
      launcher: new UnconfirmedOwnedFixtureLauncher(),
      startupTimeoutMs: 1_000,
    });
    clients.push(client);
    expect((await client.start()).ok).toBe(true);

    const closed = await client.closeWithOutcome();

    expect(closed).toMatchObject({
      ok: false,
      error: {
        _tag: "ProviderAdapterError",
        cleanupIncomplete: true,
        cleanupResources: ["hopper-document"],
      },
    });
  });

  it("kills only its owned Hopper group and emits sanitized shutdown coordinates", async () => {
    const unrelated = spawn(
      process.execPath,
      ["-e", "process.title = 'Hopper'; setInterval(() => undefined, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      unrelated.once("spawn", resolve);
      unrelated.once("error", reject);
    });
    const launcher = new OwnedFixtureLauncher();
    const diagnostics: unknown[] = [];
    const runId = "22222222-2222-4222-8222-222222222222";
    const client = new HopperClient({
      launcher,
      runId,
      startupTimeoutMs: 1_000,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    clients.push(client);

    try {
      await expect(client.start()).resolves.toMatchObject({ ok: true });
      await client.close();

      const unrelatedPid = unrelated.pid;
      if (unrelatedPid === undefined)
        throw new Error("Unrelated Hopper fixture has no PID");
      expect(() => process.kill(unrelatedPid, 0)).not.toThrow();
      expect(diagnostics).toContainEqual({
        type: "owned-shutdown",
        status: "verified-cleanup",
        launcher_pid: launcher.ownership?.leaderPid,
        process_group_id: launcher.ownership?.processGroupId,
        cleanup_signaled: true,
        reason: null,
      });
      expect(JSON.stringify(diagnostics)).not.toContain(runId);
    } finally {
      await stopUnrelatedFixture(unrelated);
    }
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
  });
});
const stopUnrelatedFixture = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGKILL");
  await exited;
};
