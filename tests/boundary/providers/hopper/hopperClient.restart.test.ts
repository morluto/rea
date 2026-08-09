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

describe("HopperClient restart", () => {
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
