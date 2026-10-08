import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HopperCancelledError,
  HopperProtocolError,
} from "../domain/hopperErrors.js";
import { ok } from "../domain/result.js";
import { HopperRequestQueue } from "./HopperRequestQueue.js";

afterEach(() => vi.useRealTimers());

describe("HopperRequestQueue deadlines", () => {
  it("times out active callers while retaining the wire until the late reply", async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const queue = new HopperRequestQueue(({ id }) => sent.push(id));
    const result = vi.fn();
    const pending = queue
      .run(1, "analyze_function", {}, { timeoutMs: 25 })
      .then(result);
    const next = queue.run(2, "echo", {}, {});
    await vi.advanceTimersByTimeAsync(25);
    expect(result).toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({
        _tag: "HopperTimeoutError",
        timeoutMs: 25,
        operation: "analyze_function",
        requestId: 1,
        providerState: "busy",
      }),
    });
    expect(sent).toEqual([1]);
    expect(queue.activity()).toMatchObject({
      callerState: "cancelled",
      queuedRequests: 1,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.accept(1, ok("late"))).toBe(true);
    expect(sent).toEqual([1, 2]);
    queue.accept(2, ok("next"));
    await pending;
    await expect(next).resolves.toEqual(ok("next"));
    expect(result).toHaveBeenCalledTimes(1);
    expect(queue.activity()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires a queued request without transmitting it", async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const queue = new HopperRequestQueue(({ id }) => sent.push(id));
    const active = queue.run(1, "active", {}, {});
    const settled = vi.fn();
    const queued = queue.run(2, "queued", {}, { timeoutMs: 10 }).then(settled);
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          _tag: "HopperTimeoutError",
          requestId: 2,
        }),
      }),
    );
    expect(queue.hasQueued(2)).toBe(false);
    queue.accept(1, ok(null));
    await Promise.all([active, queued]);
    expect(sent).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans deadline and abort observers on success before the deadline", async () => {
    vi.useFakeTimers();
    const queue = new HopperRequestQueue(() => {});
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const settled = vi.fn();
    const pending = queue
      .run(1, "echo", {}, { timeoutMs: 25, signal: controller.signal })
      .then(settled);
    queue.accept(1, ok(42));
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(settled).toHaveBeenCalledExactlyOnceWith(ok(42));
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps explicit cancellation distinct from a later timeout", async () => {
    vi.useFakeTimers();
    const queue = new HopperRequestQueue(() => {});
    const controller = new AbortController();
    const pending = queue.run(
      1,
      "echo",
      {},
      { timeoutMs: 25, signal: controller.signal },
    );
    controller.abort();
    await expect(pending).resolves.toEqual({
      ok: false,
      error: new HopperCancelledError(),
    });
    expect(vi.getTimerCount()).toBe(0);
    queue.accept(1, ok(null));
    await vi.advanceTimersByTimeAsync(100);
    expect(queue.activity()).toBeNull();
  });

  it("does not recreate timers when a progress observer cancels synchronously", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const queue = new HopperRequestQueue(send);
    const controller = new AbortController();
    const pending = queue.run(
      1,
      "echo",
      {},
      {
        timeoutMs: 100,
        signal: controller.signal,
        progress: {
          report: () => {
            controller.abort();
            return Promise.resolve();
          },
        },
      },
    );
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { _tag: "HopperCancelledError" },
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(queue.activity()).toBeNull();
    const next = queue.run(2, "next", {}, {});
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { id: 2, method: "next", params: {} },
      expect.any(Function),
    );
    queue.accept(2, ok(null));
    await next;
  });

  it("cleans all deadlines on teardown, including after an active timeout", async () => {
    vi.useFakeTimers();
    const queue = new HopperRequestQueue(() => {});
    const result = vi.fn();
    const active = queue.run(1, "active", {}, { timeoutMs: 10 }).then(result);
    const queued = queue.run(2, "queued", {}, { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(10);
    const failure = new HopperProtocolError("closed");
    queue.failAll(failure);
    await active;
    await expect(queued).resolves.toEqual({ ok: false, error: failure });
    expect(result).toHaveBeenCalledTimes(1);
    expect(queue.activity()).toBeNull();
    expect(queue.queuedCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("HopperRequestQueue deadline admission and races", () => {
  it("removes queued cancelled work and honours cancellation before admission", async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const queue = new HopperRequestQueue(({ id }) => sent.push(id));
    const active = queue.run(1, "active", {}, {});
    const controller = new AbortController();
    const queued = queue.run(
      2,
      "queued",
      {},
      { timeoutMs: 100, signal: controller.signal },
    );
    controller.abort();
    await expect(queued).resolves.toMatchObject({
      ok: false,
      error: { _tag: "HopperCancelledError" },
    });
    await expect(
      queue.run(
        3,
        "pre-aborted",
        {},
        { timeoutMs: 100, signal: controller.signal },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { _tag: "HopperCancelledError" },
    });
    expect(queue.queuedCount()).toBe(0);
    queue.accept(1, ok(null));
    await active;
    expect(sent).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([NaN, Infinity, -1, 0.5, 2_147_483_648])(
    "rejects invalid deadline %s without sending",
    async (timeoutMs) => {
      vi.useFakeTimers();
      const send = vi.fn();
      const queue = new HopperRequestQueue(send);
      await expect(
        queue.run(1, "echo", {}, { timeoutMs }),
      ).resolves.toMatchObject({
        ok: false,
        error: { _tag: "HopperProtocolError" },
      });
      expect(send).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("expires zero deadlines without sending and settles only once if aborted afterward", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const queue = new HopperRequestQueue(send);
    await expect(
      queue.run(1, "echo", {}, { timeoutMs: 0 }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "HopperTimeoutError",
        timeoutMs: 0,
        providerState: "not_started",
      },
    });
    expect(send).not.toHaveBeenCalled();
    const controller = new AbortController();
    const settled = vi.fn();
    const pending = queue
      .run(2, "echo", {}, { timeoutMs: 10, signal: controller.signal })
      .then(settled);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    queue.accept(2, ok("late"));
    await pending;
    expect(settled).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ _tag: "HopperTimeoutError" }),
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
