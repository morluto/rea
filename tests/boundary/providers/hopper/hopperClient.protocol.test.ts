import { describe, expect, it, onTestFinished, vi } from "vitest";

import { HOPPER_PROVIDER_TOOL_CONTRACTS } from "../../../../src/hopper/HopperProvider.js";
import { HopperClient } from "../../../../src/hopper/HopperClient.js";
import type { HopperDiagnostic } from "../../../../src/hopper/HopperDiagnostics.js";
import { providerCleanupFailure } from "../../../../src/hopper/HopperDiagnostics.js";

import {
  HopperFixtureLauncher as FixtureLauncher,
  startHopperFixtureClient as startClient,
} from "./hopperClient.fixture.js";

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
    onTestFinished(() => client.close());

    expect((await client.start()).ok).toBe(true);
    expect(launcher.runIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("keeps the native socket path below macOS sockaddr_un limits", async () => {
    const launcher = new FixtureLauncher();
    const client = new HopperClient({ launcher, startupTimeoutMs: 1_000 });
    onTestFinished(() => client.close());
    const started = await client.start();
    expect(started.ok).toBe(true);
    expect(Buffer.byteLength(launcher.socketPaths[0] ?? "")).toBeLessThan(104);
  });

  it("serializes concurrent calls until the active Hopper reply arrives", async () => {
    const launcher = new FixtureLauncher();
    const client = await startClient(launcher);
    const slow = client.callTool("echo", { label: "slow", gate: "serial" });
    const request = await launcher.waitForRequest("echo", "serial");
    const fast = client.callTool("echo", { label: "fast" });
    let fastSettled = false;
    void fast.then(() => {
      fastSettled = true;
    });
    await vi.waitFor(() =>
      expect(client.requestActivity()).toMatchObject({
        operation: "echo",
        queuedRequests: 1,
      }),
    );
    expect(fastSettled).toBe(false);
    expect(launcher.requests.filter(({ method }) => method === "echo")).toEqual(
      [request],
    );
    await launcher.release(request);
    await expect(Promise.all([slow, fast])).resolves.toEqual([
      { ok: true, value: { label: "slow", gate: "serial" } },
      { ok: true, value: { label: "fast" } },
    ]);
  });

  it("routes every established operation through the authenticated bridge", async () => {
    const client = await startClient();
    const results = await Promise.all(
      HOPPER_PROVIDER_TOOL_CONTRACTS.map(({ name }) =>
        client.callTool(name, {}),
      ),
    );
    expect(results).toHaveLength(HOPPER_PROVIDER_TOOL_CONTRACTS.length);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("rejects a bridge session with the wrong capability token", async () => {
    const client = new HopperClient({
      launcher: new FixtureLauncher("wrong-token"),
      startupTimeoutMs: 1_000,
    });
    onTestFinished(() => client.close());
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
    ["exit", "HopperProcessError"],
  ])("projects %s as %s", async (method, expectedTag) => {
    const launcher = new FixtureLauncher();
    const client = await startClient(launcher);
    const result = await client.callTool(method);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe(expectedTag);
      if (result.error._tag === "HopperRemoteError")
        expect(result.error).toMatchObject({
          operation: method,
          requestId: (await launcher.waitForRequest(method)).id,
        });
    }
  });

  it("preserves a sanitized bridge exception diagnostic", async () => {
    const launcher = new FixtureLauncher();
    const diagnostics: HopperDiagnostic[] = [];
    const client = new HopperClient({
      launcher,
      startupTimeoutMs: 1_000,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    onTestFinished(() => client.close());
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
      request_id: (await launcher.waitForRequest("remote_error")).id,
      code: -32001,
      category: "bridge_exception",
      message: "safe fake failure",
    });
  });
});
