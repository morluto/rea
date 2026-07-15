import { getEventListeners } from "node:events";
import { access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PendingOperations } from "../src/process/PendingOperations.js";
import { PrivateRuntimeRoot } from "../src/process/PrivateRuntimeRoot.js";
import { ProviderStartupDeadline } from "../src/process/ProviderDeadline.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type ProviderProcessDiagnostic,
} from "../src/process/ProviderProcess.js";
import {
  spawnProviderProcessFixture,
  stopProviderProcessFixture,
  waitForProviderProcessReady,
} from "./fixtures/providerProcess.js";

const processFixturePath = fileURLToPath(
  new URL("./fixtures/providerProcess.mjs", import.meta.url),
);

afterEach(() => {
  vi.useRealTimers();
});

describe("provider process lifecycle primitives", () => {
  it("allocates a private runtime root and removes it idempotently", async () => {
    const runtime = await PrivateRuntimeRoot.create({
      parent: tmpdir(),
      prefix: "rea-provider-test-",
    });
    expect((await stat(runtime.path)).mode & 0o777).toBe(0o700);

    const first = runtime.close();
    const second = runtime.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await expect(access(runtime.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("clears the startup timer and external cancellation listener", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const deadline = new ProviderStartupDeadline(1_000, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

    const waiting = deadline.wait(1_000);
    controller.abort();
    await expect(waiting).resolves.toBe("aborted");
    expect(deadline.cancelled).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    deadline.dispose();
  });

  it("uses one absolute startup deadline across interval waits", async () => {
    vi.useFakeTimers();
    const deadline = new ProviderStartupDeadline(100);
    const waiting = deadline.wait(1_000);

    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toBe("aborted");
    expect(deadline.timedOut).toBe(true);
    expect(deadline.remainingMs()).toBe(0);
    deadline.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reclassify an elapsed deadline as later cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const deadline = new ProviderStartupDeadline(50, controller.signal);

    await vi.advanceTimersByTimeAsync(50);
    controller.abort();

    expect(deadline.signal.reason).toMatchObject({ name: "TimeoutError" });
    expect(deadline.timedOut).toBe(true);
    expect(deadline.cancelled).toBe(false);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    deadline.dispose();
  });

  it("releases pending request timers and abort listeners on every outcome", async () => {
    vi.useFakeTimers();
    const operations = new PendingOperations<number, string>();
    const controller = new AbortController();
    const cancelled = operations.wait(1, {
      timeoutMs: 1_000,
      signal: controller.signal,
      timeoutValue: () => "timeout",
      cancelledValue: () => "cancelled",
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();
    await expect(cancelled).resolves.toBe("cancelled");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    const timedOut = operations.wait(2, {
      timeoutMs: 50,
      timeoutValue: () => "timeout",
      cancelledValue: () => "cancelled",
    });
    await vi.advanceTimersByTimeAsync(50);
    await expect(timedOut).resolves.toBe("timeout");

    const failed = operations.wait(3, {
      timeoutMs: 1_000,
      timeoutValue: () => "timeout",
      cancelledValue: () => "cancelled",
    });
    operations.failAll((key) => `failed:${String(key)}`);
    await expect(failed).resolves.toBe("failed:3");
    expect(operations.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("captures exact byte totals while bounding retained stdout and stderr", async () => {
    const child = spawnProviderProcessFixture("burst", 4_096);
    const diagnostics: ProviderProcessDiagnostic[] = [];
    const supervisor = new ProviderProcessSupervisor(
      { process: child, ownsProcessLifetime: true },
      {
        maxOutputBytesPerStream: 64,
        onDiagnostic: (event) => diagnostics.push(event),
      },
    );

    await expect(supervisor.waitForExit(2_000)).resolves.toBe(true);
    const snapshot = supervisor.snapshot();
    expect(snapshot).toMatchObject({
      stdout: { bytes: 4_096, retainedBytes: 64, truncated: true },
      stderr: { bytes: 4_096, retainedBytes: 64, truncated: true },
      exitCode: 23,
      signal: null,
    });
    expect(snapshot.stdout.text).toBe("o".repeat(64));
    expect(snapshot.stderr.text).toBe("e".repeat(64));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ type: "exit", code: 23 }),
    );
    await expect(supervisor.stop()).resolves.toEqual({
      status: "already-exited",
    });
  });

  it("shares double-stop and escalates a stubborn child from TERM to KILL", async () => {
    const child = spawnProviderProcessFixture("stubborn");
    const supervisor = new ProviderProcessSupervisor({
      process: child,
      ownsProcessLifetime: true,
    });
    await waitForProviderProcessReady(child);

    const first = supervisor.stop({ terminationGraceMs: 20, killGraceMs: 500 });
    const second = supervisor.stop({
      terminationGraceMs: 20,
      killGraceMs: 500,
    });
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ status: "killed" });
    expect(child.signalCode).toBe("SIGKILL");
    expect(getEventListeners(child, "exit")).toHaveLength(0);
    expect(getEventListeners(child, "close")).toHaveLength(0);
    expect(getEventListeners(child, "error")).toHaveLength(0);
  });

  it("honors verified group cleanup instead of direct process signaling", async () => {
    const child = spawnProviderProcessFixture("stubborn");
    await waitForProviderProcessReady(child);
    const cleanup = vi.fn(async () => {
      child.kill("SIGKILL");
      return { cleaned: true, signaled: true } as const;
    });
    const supervisor = new ProviderProcessSupervisor({
      process: child,
      ownsProcessLifetime: true,
      cleanup,
    });

    await expect(supervisor.stop({ killGraceMs: 500 })).resolves.toEqual({
      status: "verified-cleanup",
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("cleans an owned group even after its launcher leader has exited", async () => {
    const child = spawnProviderProcessFixture("exit", 0);
    const cleanup = vi.fn(
      async () => ({ cleaned: true, signaled: false }) as const,
    );
    const supervisor = new ProviderProcessSupervisor({
      process: child,
      ownsProcessLifetime: true,
      cleanup,
    });
    await expect(supervisor.waitForExit(2_000)).resolves.toBe(true);

    await expect(supervisor.stop()).resolves.toEqual({
      status: "verified-cleanup",
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reports incomplete cleanup when a verified callback leaves the child alive", async () => {
    const child = spawnProviderProcessFixture("stubborn");
    await waitForProviderProcessReady(child);
    const cleanup = vi.fn(
      async () => ({ cleaned: true, signaled: false }) as const,
    );
    const supervisor = new ProviderProcessSupervisor({
      process: child,
      ownsProcessLifetime: true,
      cleanup,
    });
    try {
      await expect(supervisor.stop({ killGraceMs: 20 })).resolves.toEqual({
        status: "incomplete",
        reason: "verified process-group cleanup did not stop the launcher",
      });
      expect(cleanup).toHaveBeenCalledTimes(2);
    } finally {
      await stopProviderProcessFixture(child);
    }
  });

  it("spawns an owned process group with exact identity coordinates", async () => {
    const runId = "provider-process-run";
    const spawned = await spawnOwnedProviderProcess({
      command: process.execPath,
      arguments: [processFixturePath, "graceful"],
      runId,
    });
    try {
      expect(spawned.ownership).toMatchObject({
        runId,
        leaderPid: spawned.process.pid,
        processGroupId: spawned.process.pid,
        expectedCommand: process.execPath,
        expectedParentPid: process.pid,
      });
      expect(spawned.process.stdout).not.toBeNull();
      expect(spawned.process.stderr).not.toBeNull();
    } finally {
      await stopProviderProcessFixture(spawned.process);
    }
  });

  it("allows interpreter launchers to rely on parent and run-token identity", async () => {
    const spawned = await spawnOwnedProviderProcess({
      command: process.execPath,
      arguments: [processFixturePath, "graceful"],
      runId: "provider-process-interpreter-run",
      expectedCommand: null,
    });
    try {
      expect(spawned.ownership).toMatchObject({
        expectedParentPid: process.pid,
        runId: "provider-process-interpreter-run",
      });
      expect(spawned.ownership).not.toHaveProperty("expectedCommand");
    } finally {
      await stopProviderProcessFixture(spawned.process);
    }
  });

  it("rejects deterministic spawn failures without producing a process", async () => {
    await expect(
      spawnOwnedProviderProcess({
        command: `${tmpdir()}/rea-provider-command-that-does-not-exist`,
        arguments: [],
        runId: "missing-provider",
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
