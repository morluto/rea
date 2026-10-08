import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../../../src/process/OwnedCommand.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { waitForProviderProcessReady } from "../../fixtures/providerProcess.js";
import { hasWindowsNativeAuthority } from "../../../src/process/WindowsAuthority.js";

const ownedProcessAuthorityAvailable =
  process.platform !== "win32" || hasWindowsNativeAuthority("win32");

const command = (script: string) => ({
  command: process.execPath,
  arguments: ["-e", script],
  runId: `rea-owned-command-test-${randomUUID()}`,
});

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

it.skipIf(!ownedProcessAuthorityAvailable)(
  "bounds retained diagnostics across both streams during a real output burst",
  async () => {
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
        (cause.snapshot?.stdout.bytes ?? 0) +
          (cause.snapshot?.stderr.bytes ?? 0),
      ).toBeLessThanOrEqual(1024);
    }
  },
);

it.skipIf(!ownedProcessAuthorityAvailable)(
  "collects a real owned command and verifies its exit before returning diagnostics",
  async () => {
    const result = await runOwnedCommand(
      command('process.stdout.write("observed-output")'),
      { timeoutMs: 2_000, diagnosticBytes: 1024 },
    );
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      stdout: { text: "observed-output", bytes: 15 },
    });
  },
);

it.skipIf(!ownedProcessAuthorityAvailable)(
  "cancels a real acquired process and independently releases it",
  async () => {
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
  },
);

it.skipIf(!ownedProcessAuthorityAvailable)(
  "returns a timeout for a running process after independent cleanup",
  async () => {
    await expect(
      runOwnedCommand(command("setInterval(() => undefined, 1000)"), {
        timeoutMs: 50,
        diagnosticBytes: 1024,
      }),
    ).rejects.toMatchObject({ reason: "timeout", cleanupFailure: null });
  },
);

it.skipIf(!ownedProcessAuthorityAvailable)(
  "honors cancellation during cleanup after a successful command",
  async () => {
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
                const result = await cleanupOwnedProcessGroup(
                  launched.ownership,
                );
                controller.abort();
                return result;
              },
            };
          },
        },
      ),
    ).rejects.toMatchObject({ reason: "cancelled", cleanupFailure: null });
  },
);

it.skipIf(!ownedProcessAuthorityAvailable)(
  "rejects oversized diagnostics even when the child exits immediately",
  async () => {
    await expect(
      runOwnedCommand(command('process.stdout.write("x".repeat(2048))'), {
        timeoutMs: 2_000,
        diagnosticBytes: 1024,
      }),
    ).rejects.toMatchObject({ reason: "output-limit", cleanupFailure: null });
  },
);

it.skipIf(!ownedProcessAuthorityAvailable)(
  "preserves original command failure together with failed cleanup resource identities",
  async () => {
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
  },
);
