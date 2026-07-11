import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { OFFICIAL_TOOL_CONTRACTS } from "../src/contracts/toolContracts.js";
import { ok } from "../src/domain/result.js";
import type {
  BridgeLauncher,
  BridgeSession,
} from "../src/hopper/BridgeLauncher.js";
import { HopperClient } from "../src/hopper/HopperClient.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/fakeHopper.mjs", import.meta.url),
);

class FixtureLauncher implements BridgeLauncher {
  socketPaths: string[] = [];

  constructor(readonly tokenOverride?: string) {}

  launch(session: BridgeSession) {
    this.socketPaths.push(session.socketPath);
    return Promise.resolve(
      ok({
        process: spawn(
          process.execPath,
          [
            fixturePath,
            session.socketPath,
            this.tokenOverride ?? session.token,
          ],
          {
            stdio: ["ignore", "ignore", "pipe"],
          },
        ),
        ownsProcessLifetime: true,
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
    value: { name: "betterBinaryMCP Hopper bridge", version: "1.0.0" },
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
    expect(results).toHaveLength(31);
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
});
