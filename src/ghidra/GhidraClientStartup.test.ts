import type { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";

import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";
import { silentLogger } from "../logger.js";
import { PendingOperations } from "../process/PendingOperations.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import { completeGhidraStartupHandshake } from "./GhidraClientStartup.js";
import { GhidraWire } from "./GhidraClientWire.js";
import {
  bindGhidraSessionFailure,
  GHIDRA_STARTUP_DEADLINE_ELAPSED,
  type GhidraSessionError,
} from "./GhidraSessionError.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const startup = () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  const controller = new AbortController();
  const deadline = new ProviderStartupDeadline(250, controller.signal);
  const failure = bindGhidraSessionFailure(() => ({
    target_admission: { source: { size: 4096 } },
  }));
  const pending = new PendingOperations<
    number,
    Result<JsonValue, GhidraSessionError>
  >();
  const write = vi.fn(() => true);
  const wire = new GhidraWire({
    getSocket: () => ({ destroyed: false, write }) as unknown as Socket,
    getToken: () => "b".repeat(64),
    nextId: () => 1,
    pending,
    logger: silentLogger,
    failure,
    bridgeMaxRequestBytes: { maximumBytes: 8192, source: "setting" },
  });
  const parseSessionInfo = vi.fn(() =>
    err(failure("protocol", "Unexpected successful ping")),
  );
  const handshake = () =>
    completeGhidraStartupHandshake({
      deadline,
      startupTimeoutMs: deadline.timeoutMs,
      failure,
      request: (method, params, options) =>
        wire.request(method, params, options),
      parseSessionInfo,
    });
  return {
    clock,
    controller,
    deadline,
    pending,
    write,
    parseSessionInfo,
    handshake,
  };
};

it.each(["before ping", "while awaiting ping"] as const)(
  "retains the full startup budget and diagnostics when it expires %s before the abort callback",
  async (phase) => {
    const fixture = startup();
    try {
      fixture.clock.mockReturnValue(phase === "before ping" ? 351 : 349);
      const result = fixture.handshake();
      if (phase === "while awaiting ping") {
        fixture.clock.mockReturnValue(351);
        await vi.advanceTimersByTimeAsync(1);
      }
      // Exercise the wire timeout, not cancellation from the startup timer.
      expect(fixture.deadline.signal.aborted).toBe(false);
      expect(await result).toMatchObject({
        ok: false,
        error: {
          kind: "timeout",
          message: GHIDRA_STARTUP_DEADLINE_ELAPSED,
          timeoutMs: 250,
          elapsedMs: 251,
          diagnostics: { target_admission: { source: { size: 4096 } } },
        },
      });
      expect(fixture.write).toHaveBeenCalledTimes(
        phase === "before ping" ? 0 : 1,
      );
      expect(fixture.pending.has(1)).toBe(false);
      expect(fixture.parseSessionInfo).not.toHaveBeenCalled();
    } finally {
      fixture.deadline.dispose();
    }
  },
);

it("preserves caller cancellation during the startup ping", async () => {
  const fixture = startup();
  try {
    const result = fixture.handshake();
    const reason = { source: "caller" };
    fixture.controller.abort(reason);
    expect(await result).toMatchObject({
      ok: false,
      error: { kind: "cancelled", cancellation: { reason } },
    });
    expect(fixture.pending.has(1)).toBe(false);
    expect(fixture.parseSessionInfo).not.toHaveBeenCalled();
  } finally {
    fixture.deadline.dispose();
  }
});
