import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  CommandCancellationScope,
  commandCancellationStatus,
  withCommandCancellation,
  type CommandCancellationHost,
} from "../../../src/cli/commandCancellation.js";
import { createCliShell } from "../../../src/cli/cliShell.js";
import { registerCliCommand } from "../../../src/cli/commandRegistry.js";
import { logCliCommand } from "../../../src/cliLogging.js";
import {
  CallerAbort,
  cancelledBy,
} from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { silentLogger } from "../../../src/logger.js";
import { serveInProcessCli } from "../../support/cli/serveInProcessCli.js";

it.each([
  ["SIGINT", 130, "interrupt"],
  ["SIGTERM", 143, "terminate"],
  ["SIGBREAK", 149, "break"],
] as const)(
  "awaits cleanup after %s and removes its listeners",
  async (event, expectedExit, expectedKind) => {
    const events = new EventEmitter();
    const host: CommandCancellationHost = {
      on: events.on.bind(events),
      off: events.off.bind(events),
    };
    let cleaned = false;
    let reason: unknown;
    const operation = withCommandCancellation(async (signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      reason = signal.reason;
      cleaned = true;
      return "cancelled after cleanup";
    }, host);
    expect(host.exitCode).toBeUndefined();
    events.emit(event);
    expect(await operation).toBe("cancelled after cleanup");
    expect(cleaned).toBe(true);
    // The adapter names its caller; a platform AbortError shape is kept.
    expect(reason).toBeInstanceOf(CallerAbort);
    expect(reason).toMatchObject({ kind: expectedKind, name: "AbortError" });
    expect(host.exitCode).toBe(expectedExit);
    expect(events.listenerCount("SIGINT")).toBe(0);
    expect(events.listenerCount("SIGTERM")).toBe(0);
    expect(events.listenerCount("SIGBREAK")).toBe(0);
  },
);

it("leaves the exit code alone on success and removes listeners when execution throws", async () => {
  const events = new EventEmitter();
  const host: CommandCancellationHost = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    exitCode: 0,
  };
  expect(await withCommandCancellation(async () => "success", host)).toBe(
    "success",
  );
  expect(host.exitCode).toBe(0);
  await expect(
    withCommandCancellation(async () => {
      throw new Error("fixture failure");
    }, host),
  ).rejects.toThrow("fixture failure");
  expect(events.listenerCount("SIGINT")).toBe(0);
  expect(events.listenerCount("SIGTERM")).toBe(0);
  expect(events.listenerCount("SIGBREAK")).toBe(0);
});

it("retains signals after operation settlement until its resource close succeeds", () => {
  const events = new EventEmitter();
  const host: CommandCancellationHost = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    exitCode: 0,
  };
  const scope = new CommandCancellationScope(host);
  scope.finish();
  expect(host.exitCode).toBe(0);
  expect(events.listenerCount("SIGINT")).toBe(1);
  events.emit("SIGTERM");
  expect(scope.exitStatus).toBe(143);
  expect(host.exitCode).toBe(143);
  events.emit("SIGINT");
  expect(scope.exitStatus).toBe(143);
  expect(scope.signal.reason).toMatchObject({ kind: "terminate" });
  scope.close();
  scope.close();
  expect(events.listenerCount("SIGINT")).toBe(0);
  expect(events.listenerCount("SIGTERM")).toBe(0);
  expect(events.listenerCount("SIGBREAK")).toBe(0);
});

it("attests the cancellation status on returned and thrown outcomes", async () => {
  const events = new EventEmitter();
  const host: CommandCancellationHost = {
    on: events.on.bind(events),
    off: events.off.bind(events),
  };
  const returned = withCommandCancellation(async (signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return { cancelled: true };
  }, host);
  events.emit("SIGBREAK");
  expect(commandCancellationStatus(await returned)).toBe(149);

  const failure = new Error("fixture failure");
  const thrown = withCommandCancellation(async (signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    throw failure;
  }, host);
  events.emit("SIGTERM");
  await expect(thrown).rejects.toBe(failure);
  expect(commandCancellationStatus(failure)).toBe(143);
});

it("derives the status from a cancellation cause and ignores other outcomes", () => {
  expect(
    commandCancellationStatus(
      cancelledBy(
        "fixture",
        AbortSignal.abort(CallerAbort.forProcessSignal("SIGBREAK")),
      ),
    ),
  ).toBe(149);
  expect(
    commandCancellationStatus(
      cancelledBy(
        "fixture",
        AbortSignal.abort(CallerAbort.forProcessSignal("SIGINT")),
      ),
    ),
  ).toBe(130);
  expect(commandCancellationStatus(new Error("unrelated"))).toBeUndefined();
  expect(commandCancellationStatus({ ok: true })).toBeUndefined();
  expect(commandCancellationStatus(undefined)).toBeUndefined();
});

it("keeps the cancellation exit status when a command reports the cancelled error", async () => {
  const events = new EventEmitter();
  const host: CommandCancellationHost = {
    on: events.on.bind(events),
    off: events.off.bind(events),
  };
  const shell = createCliShell({
    selectedEnvironment: {},
    registrations: [
      {
        module: {},
        registration: {
          analysis: false,
          load: async () => ({}),
          register: (_module, { cli }) => {
            registerCliCommand(cli, "fixture", {
              options: z.object({}),
              run: () =>
                withCommandCancellation(
                  (signal) =>
                    logCliCommand(silentLogger, "fixture", async () => {
                      await new Promise<void>((resolve) =>
                        signal.addEventListener("abort", () => resolve(), {
                          once: true,
                        }),
                      );
                      return {
                        error: "Analysis failed",
                        ...projectAnalysisError(cancelledBy("fixture", signal)),
                      };
                    }),
                  host,
                ),
            });
          },
        },
      },
    ],
  });
  const served = serveInProcessCli(shell, [
    "fixture",
    "--format",
    "csv",
    "--filter-output",
    "rows",
    "--columns",
    "a",
    "--full-output",
  ]);
  // Let the command reach its abort wait before delivering the signal.
  await new Promise<void>((resolve) => setImmediate(resolve));
  events.emit("SIGBREAK");
  const reply = await served;
  expect(reply.exitCode).toBe(149);
});
