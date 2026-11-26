import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import {
  CommandCancellationScope,
  withCommandCancellation,
  type CommandCancellationHost,
} from "../../../src/cli/commandCancellation.js";
import { CallerAbort } from "../../../src/domain/analysisErrorCore.js";

it.each([
  ["SIGINT", 130, "interrupt"],
  ["SIGTERM", 143, "terminate"],
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
});
