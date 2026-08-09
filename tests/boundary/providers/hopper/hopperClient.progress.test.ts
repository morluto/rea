import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ok } from "../../../../src/domain/result.js";
import type {
  BridgeLauncher,
  BridgeSession,
} from "../../../../src/hopper/BridgeLauncher.js";
import { HopperClient } from "../../../../src/hopper/HopperClient.js";

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

describe("HopperClient progress", () => {
  it("forwards correlated Python progress before the terminal response", async () => {
    const client = await startClient();
    const updates: Array<{
      readonly phase: string;
      readonly completed: number;
      readonly terminal?: boolean;
    }> = [];
    const result = await client.callTool(
      "echo",
      { value: "progress" },
      {
        progress: {
          report: (update) => {
            updates.push(update);
            return Promise.resolve();
          },
        },
      },
    );

    expect(result).toEqual({ ok: true, value: { value: "progress" } });
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "hopper_bridge",
          completed: 0,
        }),
        expect.objectContaining({
          phase: "hopper_bridge",
          completed: 1,
          terminal: true,
        }),
      ]),
    );
  });

  it("isolates synchronous progress observer failures from bridge responses", async () => {
    const client = await startClient();
    await expect(
      client.callTool(
        "echo",
        { value: "alive" },
        {
          progress: {
            report: () => {
              throw new Error("observer failed");
            },
          },
        },
      ),
    ).resolves.toEqual({ ok: true, value: { value: "alive" } });
  });

  it("projects a missing bridge API as typed capability unavailability", async () => {
    const client = await startClient();
    const result = await client.callTool("capability_unavailable");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        _tag: "AnalysisCapabilityUnavailableError",
        providerId: "hopper",
        operation: "capability_unavailable",
        reason: "fixture API is unavailable",
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

  it("retains timed-out bridge activity until the late reply releases the queue", async () => {
    const client = await startClient();
    const progress: string[] = [];
    const result = await client.callTool(
      "echo",
      { delay: 60 },
      {
        timeoutMs: 5,
        progress: {
          report: (update) => {
            progress.push(update.message);
            return Promise.resolve();
          },
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "HopperTimeoutError" },
    });
    expect(client.requestActivity()).toMatchObject({
      operation: "echo",
      callerState: "timed_out",
      timeoutMs: 5,
    });
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.stringContaining("started on Hopper's serial bridge"),
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(client.requestActivity()).toBeNull();
    await expect(client.callTool("echo", { alive: true })).resolves.toEqual({
      ok: true,
      value: { alive: true },
    });
  });
});
