import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { OFFICIAL_TOOL_CONTRACTS } from "../../../../src/contracts/toolContracts.js";
import { ok } from "../../../../src/domain/result.js";
import type {
  BridgeLauncher,
  BridgeSession,
} from "../../../../src/hopper/BridgeLauncher.js";
import { HopperClient } from "../../../../src/hopper/HopperClient.js";
import type { HopperDiagnostic } from "../../../../src/hopper/HopperDiagnostics.js";
import { providerCleanupFailure } from "../../../../src/hopper/HopperDiagnostics.js";

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
    requestTimeoutMs: 1_000,
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

describe("HopperClient protocol", () => {
  it("sanitizes unexpected owned-cleanup exceptions", () => {
    expect(
      providerCleanupFailure(
        new Error("secret-run-token 22222222-2222-4222-8222-222222222222"),
      ),
    ).toEqual({
      cleaned: false,
      reason: "owned provider cleanup failed",
    });
  });

  it("uses the caller-assigned provider run identity", async () => {
    const launcher = new FixtureLauncher();
    const client = new HopperClient({
      launcher,
      runId: "11111111-1111-4111-8111-111111111111",
      startupTimeoutMs: 1_000,
    });
    clients.push(client);

    expect((await client.start()).ok).toBe(true);
    expect(launcher.runIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("keeps the native socket path below macOS sockaddr_un limits", async () => {
    const launcher = new FixtureLauncher();
    const client = new HopperClient({ launcher, startupTimeoutMs: 1_000 });
    clients.push(client);
    const started = await client.start();
    expect(started.ok).toBe(true);
    expect(Buffer.byteLength(launcher.socketPaths[0] ?? "")).toBeLessThan(104);
  });

  it("serializes concurrent calls until the active Hopper reply arrives", async () => {
    const client = await startClient();
    const slow = client.callTool("echo", { label: "slow", delay: 30 });
    const fast = client.callTool("echo", { label: "fast", delay: 1 });
    let fastSettled = false;
    void fast.then(() => {
      fastSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fastSettled).toBe(false);
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
    expect(results).toHaveLength(36);
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
    ["wrong_event_id", "HopperProtocolError"],
    ["malformed_event", "HopperProtocolError"],
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
    const diagnostics: HopperDiagnostic[] = [];
    const client = new HopperClient({
      launcher: new FixtureLauncher(),
      requestTimeoutMs: 100,
      startupTimeoutMs: 1_000,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    clients.push(client);
    await expect(client.start()).resolves.toMatchObject({ ok: true });
    const result = await client.callTool("remote_error");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        _tag: "HopperRemoteError",
        diagnosticType: "bridge_exception",
      });
    expect(diagnostics).toContainEqual({
      type: "bridge-diagnostic",
      request_id: 2,
      code: -32001,
      category: "bridge_exception",
      message: "safe fake failure",
    });
  });
});
