import { getEventListeners } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HopperProtocolError } from "./HopperErrors.js";
import { ok } from "../domain/result.js";
import { HopperRequestQueue } from "./HopperRequestQueue.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HopperRequestQueue deadlines", () => {
  it("expires queued work but keeps an expired active request on the wire until its reply", async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const queue = new HopperRequestQueue(({ id }) => sent.push(id));
    const controller = new AbortController();
    const active = queue.run(
      1,
      "analyze_function",
      {},
      { timeoutMs: 25, signal: controller.signal },
    );
    const expired = queue.run(2, "set_comment", {}, { timeoutMs: 10 });
    const next = queue.run(3, "echo", {}, {});

    await vi.advanceTimersByTimeAsync(10);
    await expect(expired).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "HopperTimeoutError",
        requestId: 2,
        providerState: "not_started",
      },
    });
    expect(queue.hasQueued(2)).toBe(false);
    await vi.advanceTimersByTimeAsync(15);
    controller.abort("too late to change the timeout");
    await expect(active).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "HopperTimeoutError",
        timeoutMs: 25,
        operation: "analyze_function",
        requestId: 1,
        providerState: "busy",
      },
    });
    expect(sent).toEqual([1]);
    expect(queue.activity()).toMatchObject({
      callerState: "cancelled",
      queuedRequests: 1,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.accept(1, ok("late"))).toBe(true);
    expect(sent).toEqual([1, 3]);
    queue.accept(3, ok("next"));
    await expect(next).resolves.toEqual(ok("next"));
    expect(queue.activity()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans deadline and abort observers on success before the deadline", async () => {
    vi.useFakeTimers();
    const queue = new HopperRequestQueue(() => {});
    const controller = new AbortController();
    const pending = queue.run(
      1,
      "echo",
      {},
      { timeoutMs: 25, signal: controller.signal },
    );
    queue.accept(1, ok(42));
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    controller.abort();
    await expect(pending).resolves.toEqual(ok(42));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the exact active cancellation distinct from a later timeout", async () => {
    vi.useFakeTimers();
    const queue = new HopperRequestQueue(() => {});
    const controller = new AbortController();
    const pending = queue.run(
      1,
      "echo",
      {},
      { timeoutMs: 25, signal: controller.signal },
    );
    const reason = { source: "active caller" };
    controller.abort(reason);
    const result = await pending;
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("HopperCancelledError");
    expect(result.error.cause).toBe(reason);
    expect(queue.activity()?.callerState).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.accept(1, ok("late"))).toBe(true);
    expect(queue.activity()).toBeNull();
  });

  it("does not recreate timers when a progress observer cancels synchronously", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const queue = new HopperRequestQueue(send);
    const controller = new AbortController();
    const reason = { source: "progress" };
    const pending = queue.run(
      1,
      "echo",
      {},
      {
        timeoutMs: 100,
        signal: controller.signal,
        progress: {
          report: () => {
            controller.abort(reason);
            return Promise.resolve();
          },
        },
      },
    );
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { cause: reason },
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
    expect(queue.hasQueued(2)).toBe(false);
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
    const reason = { source: "waiting caller" };
    controller.abort(reason);
    const preAborted = queue.run(
      3,
      "pre-aborted",
      {},
      { timeoutMs: 100, signal: controller.signal },
    );
    for (const result of await Promise.all([queued, preAborted])) {
      if (result.ok) throw new Error("Expected cancellation");
      expect(result.error._tag).toBe("HopperCancelledError");
      expect(result.error.cause).toBe(reason);
    }
    expect(queue.hasQueued(2)).toBe(false);
    expect(queue.hasQueued(3)).toBe(false);
    expect(queue.activity()?.queuedRequests).toBe(0);
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

  it("expires zero deadlines without sending", async () => {
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
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("honors elapsed deadlines on reply and dequeue before their timers run", async () => {
  vi.useFakeTimers();
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const sent: number[] = [];
  const queue = new HopperRequestQueue(({ id }) => sent.push(id));
  const active = queue.run(1, "echo", {}, { timeoutMs: 10 });
  const queued = queue.run(2, "set_comment", {}, { timeoutMs: 10 });
  const next = queue.run(3, "echo", {}, {});
  clock.mockReturnValue(20);

  expect(queue.accept(1, ok("late"))).toBe(true);
  await expect(active).resolves.toMatchObject({
    ok: false,
    error: { _tag: "HopperTimeoutError", requestId: 1, providerState: "busy" },
  });
  expect(sent).toEqual([1, 3]);
  await expect(queued).resolves.toMatchObject({
    ok: false,
    error: {
      _tag: "HopperTimeoutError",
      operation: "set_comment",
      requestId: 2,
      providerState: "not_started",
    },
  });
  queue.accept(3, ok("next"));
  await expect(next).resolves.toEqual(ok("next"));
  expect(queue.activity()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
