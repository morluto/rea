import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { beforeAll, expect, it, vi } from "vitest";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../../../src/process/OwnedCommand.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import {
  cleanupOwnedProcessGroup,
  type ProcessCleanupResult,
} from "../../../src/process/ProcessOwnership.js";
import { prepareProcessOwnershipInspection } from "../../../src/process/ProcessOwnershipObservation.js";
import { waitForProviderProcessReady } from "../../fixtures/providerProcess.js";

const command = (script: string) => ({
  command: process.execPath,
  arguments: ["-e", script],
  runId: `rea-owned-command-test-${randomUUID()}`,
});

// Output/exit cases start with a prepared inspector; startup deadline cases
// below inject their own preparation so they remain independent of compiler speed.
beforeAll(() => prepareProcessOwnershipInspection());

it("includes ownership preparation in the command deadline before provider creation", async () => {
  let prepared = false;
  await expect(
    runOwnedCommand(
      command("process.exit(0)"),
      {
        timeoutMs: 20,
        diagnosticBytes: 1024,
      },
      {
        launcher: async (input) => {
          await delay(80, undefined, { signal: input.signal });
          prepared = true;
          throw new Error(
            "Slow preparation must be aborted before provider creation",
          );
        },
      },
    ),
  ).rejects.toMatchObject({ reason: "timeout", snapshot: null });
  expect(prepared).toBe(false);
});

it("passes cancellation into native ownership preparation before provider creation", async () => {
  const controller = new AbortController();
  await expect(
    runOwnedCommand(
      command("process.exit(0)"),
      { timeoutMs: 2000, diagnosticBytes: 1024 },
      {
        signal: controller.signal,
        launcher: async (input) => {
          expect(input.signal?.aborted).toBe(false);
          controller.abort();
          input.signal?.throwIfAborted();
          throw new Error("Cancelled preparation must not launch a provider");
        },
      },
    ),
  ).rejects.toMatchObject({ reason: "cancelled", snapshot: null });
});

it("bounds retained diagnostics across both streams during a real output burst", async () => {
  try {
    await runOwnedCommand(
      command(
        'process.stdout.write("a".repeat(256 * 1024)); process.stderr.write("b".repeat(256 * 1024))',
      ),
      { timeoutMs: 2_000, diagnosticBytes: 1024 },
    );
    throw new Error("An oversized producer must fail");
  } catch (cause: unknown) {
    if (!(cause instanceof OwnedCommandFailure)) throw cause;
    expect(cause.reason).toBe("output-limit");
    expect(cause.snapshot).not.toBeNull();
    expect(
      (cause.snapshot?.stdout.bytes ?? 0) + (cause.snapshot?.stderr.bytes ?? 0),
    ).toBeLessThanOrEqual(1024);
  }
});

it("collects a real owned command and verifies its exit before returning diagnostics", async () => {
  const result = await runOwnedCommand(
    command('process.stdout.write("observed-output")'),
    { timeoutMs: 2_000, diagnosticBytes: 1024 },
  );
  expect(result).toMatchObject({
    exitCode: 0,
    signal: null,
    stdout: { text: "observed-output", bytes: 15 },
  });
});

it("fails an accepted nonzero command when an output stream errors and cleans it up", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  class FakeProcess extends EventEmitter {
    readonly stdout = stdout;
    readonly stderr = stderr;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    readonly pid = 41234;
    kill(): boolean {
      return true;
    }
  }
  const child = new FakeProcess();
  const cleanup = vi.fn(async () => ({
    cleaned: true as const,
    signaled: false,
  }));
  const request = command("unused fake launcher command");

  const failure = runOwnedCommand(
    request,
    { timeoutMs: 2_000, diagnosticBytes: 1024, acceptNonZeroExit: true },
    {
      launcher: async () => {
        setImmediate(() => {
          stdout.write("partial output");
          stdout.destroy(new Error("fixture read failure"));
          stderr.end();
          child.exitCode = 7;
          child.emit("exit", 7, null);
          child.emit("close", 7, null);
        });
        return {
          process: child,
          ownership: {
            runId: request.runId,
            leaderPid: child.pid,
            processGroupId: child.pid,
          },
          cleanup,
        };
      },
    },
  );

  await expect(failure).rejects.toMatchObject({
    reason: "process",
    message: "stdout stream failed: fixture read failure",
    snapshot: { stdout: { text: "partial output" }, exitCode: 7 },
  });
  expect(cleanup).toHaveBeenCalledOnce();
});

it("cancels a real acquired process and independently releases it", async () => {
  const controller = new AbortController();
  let pid: number | undefined;
  const result = runOwnedCommand(
    command(
      'process.stdout.write("ready\\n"); setInterval(() => undefined, 1000)',
    ),
    { timeoutMs: 5_000, diagnosticBytes: 1024 },
    {
      signal: controller.signal,
      launcher: async (input) => {
        const process = await spawnOwnedProviderProcess(input);
        pid = process.process.pid;
        await waitForProviderProcessReady(process.process);
        setImmediate(() => controller.abort());
        return process;
      },
    },
  );
  await expect(result).rejects.toMatchObject({
    reason: "cancelled",
    cleanupFailure: null,
  });
  if (pid === undefined) throw new Error("Process was not acquired");
  const acquiredPid = pid;
  expect(() => process.kill(acquiredPid, 0)).toThrow();
});

it("returns a timeout for a running process after independent cleanup", async () => {
  await expect(
    runOwnedCommand(command("setInterval(() => undefined, 1000)"), {
      timeoutMs: 50,
      diagnosticBytes: 1024,
    }),
  ).rejects.toMatchObject({ reason: "timeout", cleanupFailure: null });
});

it.skipIf(process.platform === "win32").each(["cancelled", "timeout"] as const)(
  "retains the real per-member cleanup ledger after %s and settles after cooperative exit",
  async (reason) => {
    const childScript =
      'process.stdin.once("data", () => process.exit(0)); process.stdout.write("child-ready\\n")';
    const request = {
      ...command(`
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], {
          env: { ...process.env, REA_PROCESS_RUN_ID: "different-child-owner" },
          stdio: ["pipe", "inherit", "inherit"],
        });
        const release = () => child.stdin.end("release");
        process.stdin.once("data", release);
        const failsafe = setTimeout(release, 10000);
        child.once("exit", () => { clearTimeout(failsafe); process.stdin.destroy(); });
      `),
      stdin: "pipe" as const,
    };
    const controller = new AbortController();
    let launched:
      | Awaited<ReturnType<typeof spawnOwnedProviderProcess>>
      | undefined;
    let cleanup: ProcessCleanupResult | undefined;
    let failure: OwnedCommandFailure | undefined;
    try {
      await runOwnedCommand(
        request,
        { timeoutMs: 2000, diagnosticBytes: 1024 },
        {
          signal: controller.signal,
          launcher: async (input) => {
            const acquired = await spawnOwnedProviderProcess(input);
            launched = acquired;
            acquired.process.stdout?.on("data", (chunk: Buffer) => {
              if (
                reason === "cancelled" &&
                chunk.toString().includes("child-ready")
              )
                controller.abort();
            });
            return {
              ...acquired,
              cleanup: async () => {
                const observed = await cleanupOwnedProcessGroup(
                  acquired.ownership,
                );
                cleanup ??= observed;
                return observed;
              },
            };
          },
        },
      ).catch((cause: unknown) => {
        if (!(cause instanceof OwnedCommandFailure)) throw cause;
        failure = cause;
      });
      if (failure === undefined || launched === undefined)
        throw new Error(
          "The acquired command must retain its failed cleanup owner",
        );
      expect(failure.reason).toBe(reason);
      expect(failure.snapshot?.stdout.text).toContain("child-ready");
      expect(cleanup).toMatchObject({
        cleaned: false,
        failures: [expect.objectContaining({ reason: "run-token-mismatch" })],
      });
      expect(failure.cleanupResult).toEqual(cleanup);
      expect(failure.resources).toEqual([
        request.runId,
        `pid:${launched.ownership.leaderPid}`,
        `process-group:${launched.ownership.processGroupId}`,
      ]);
      // An unresolved member does not grant authority to signal the shared group.
      const acquiredPid = launched.ownership.leaderPid;
      expect(() => process.kill(acquiredPid, 0)).not.toThrow();
      if (cleanup?.cleaned === false) {
        for (const member of cleanup.failures ?? []) {
          expect(() => process.kill(member.pid, 0)).not.toThrow();
          expect(failure.cleanupFailure).toContain(String(member.pid));
        }
      }
    } finally {
      // Release through the fixture's acquired input channel, never by an unverified PID.
      launched?.process.stdin?.end("release");
      if (failure?.cleanupOwner !== undefined) {
        expect(await failure.cleanupOwner.waitForOutputClose(5000)).toBe(true);
        expect(await failure.cleanupOwner.stop()).toEqual({
          status: "verified-cleanup",
        });
      }
    }
  },
);

it("honors cancellation during cleanup after a successful command", async () => {
  const controller = new AbortController();
  await expect(
    runOwnedCommand(
      command("process.exit(0)"),
      { timeoutMs: 2_000, diagnosticBytes: 1024 },
      {
        signal: controller.signal,
        launcher: async (input) => {
          const launched = await spawnOwnedProviderProcess(input);
          return {
            ...launched,
            cleanup: async () => {
              const result = await cleanupOwnedProcessGroup(launched.ownership);
              controller.abort();
              return result;
            },
          };
        },
      },
    ),
  ).rejects.toMatchObject({ reason: "cancelled", cleanupFailure: null });
});

it("rejects oversized diagnostics even when the child exits immediately", async () => {
  await expect(
    runOwnedCommand(command('process.stdout.write("x".repeat(2048))'), {
      timeoutMs: 2_000,
      diagnosticBytes: 1024,
    }),
  ).rejects.toMatchObject({ reason: "output-limit", cleanupFailure: null });
});

it("preserves original command failure together with failed cleanup resource identities", async () => {
  const request = command("process.exit(2)");
  await expect(
    runOwnedCommand(
      request,
      { timeoutMs: 2_000, diagnosticBytes: 1024 },
      {
        launcher: async (input) => {
          const process = await spawnOwnedProviderProcess(input);
          return {
            ...process,
            cleanup: async () => ({
              cleaned: false as const,
              reason: "synthetic cleanup could not be confirmed",
            }),
          };
        },
      },
    ),
  ).rejects.toMatchObject({
    reason: "process",
    cleanupFailure: "synthetic cleanup could not be confirmed",
    resources: expect.arrayContaining([request.runId]),
    snapshot: { exitCode: 2 },
  });
});
