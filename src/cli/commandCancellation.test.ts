import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { CallerAbort } from "../domain/analysisErrorCore.js";
import {
  CommandCancellationScope,
  withCommandCancellation,
  type CommandCancellationHost,
} from "./commandCancellation.js";

const host = (): EventEmitter & CommandCancellationHost =>
  new EventEmitter() as EventEmitter & CommandCancellationHost;

describe("CommandCancellationScope SIGBREAK", () => {
  it("aborts on SIGBREAK with exit status 149 and releases all listeners", () => {
    const signals = host();
    const scope = new CommandCancellationScope(signals);

    expect(scope.signal.aborted).toBe(false);
    signals.emit("SIGBREAK");

    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBeInstanceOf(CallerAbort);
    expect((scope.signal.reason as CallerAbort).kind).toBe("break");
    expect(scope.signal.reason.message).toBe(
      "The caller interrupted this operation (SIGBREAK)",
    );
    expect(scope.exitStatus).toBe(149);
    expect(signals.exitCode).toBeUndefined();

    scope.finish();
    expect(signals.exitCode).toBe(149);

    scope.close();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGBREAK")).toBe(0);
  });

  it("keeps the first signal's exit status when SIGBREAK follows SIGINT", () => {
    const signals = host();
    const scope = new CommandCancellationScope(signals);

    signals.emit("SIGINT");
    signals.emit("SIGBREAK");

    expect(scope.exitStatus).toBe(130);
    expect((scope.signal.reason as CallerAbort).kind).toBe("interrupt");
    scope.close();
  });

  it("keeps SIGBREAK from aborting after close", () => {
    const signals = host();
    const scope = new CommandCancellationScope(signals);
    scope.close();

    signals.emit("SIGBREAK");

    expect(scope.signal.aborted).toBe(false);
    expect(scope.exitStatus).toBeUndefined();
  });
});

describe("withCommandCancellation SIGBREAK", () => {
  it("aborts a pending operation and publishes exit status 149", async () => {
    const signals = host();
    const outcome = withCommandCancellation(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      signals,
    );
    signals.emit("SIGBREAK");

    const reason = await outcome.catch((error: unknown) => error);
    expect(reason).toBeInstanceOf(CallerAbort);
    expect((reason as CallerAbort).kind).toBe("break");
    expect(signals.exitCode).toBe(149);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGBREAK")).toBe(0);
  });

  it("still aborts on SIGINT and SIGTERM with their exit statuses", async () => {
    for (const [signalName, status, kind] of [
      ["SIGINT", 130, "interrupt"],
      ["SIGTERM", 143, "terminate"],
    ] as const) {
      const signals = host();
      const outcome = withCommandCancellation(
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
        signals,
      );
      signals.emit(signalName);

      const reason = await outcome.catch((error: unknown) => error);
      expect((reason as CallerAbort).kind).toBe(kind);
      expect(signals.exitCode).toBe(status);
      expect(signals.listenerCount(signalName)).toBe(0);
    }
  });
});
