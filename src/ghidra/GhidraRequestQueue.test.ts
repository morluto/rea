import { describe, expect, it, vi } from "vitest";

import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { GhidraRequestOptions } from "./GhidraClientTypes.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { GhidraRequestQueue } from "./GhidraRequestQueue.js";
import { releaseOwnedCleanup } from "../../tests/support/cleanupRelease.js";
import { phaseGate } from "../../tests/support/lifecycleHarness.js";
import {
  bindGhidraSessionFailure,
  GhidraSessionError,
} from "./GhidraSessionError.js";

const failure = bindGhidraSessionFailure(() => ({
  target_path: "/tmp/queue-fixture",
}));

describe("Ghidra request queue failure settlement", () => {
  it.each([new TypeError("Decoder rejected"), "decoder rejected", null])(
    "preserves a rejected executor cause (%j) and drains the next request",
    async (cause) => {
      const executed: string[] = [];
      const queue = new GhidraRequestQueue(
        async (method) => {
          executed.push(method);
          if (method === "first") throw cause;
          return ok({ method });
        },
        failure,
        () => Promise.resolve(ok(null)),
      );
      const first = queue.run("first", {}, {});
      const second = queue.run("second", {}, {});
      const result = await first;
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "protocol",
          message: "Ghidra serial request execution rejected unexpectedly",
          diagnostics: { target_path: "/tmp/queue-fixture" },
        },
      });
      if (result.ok) throw new Error("Expected queue failure");
      expect(result.error.cause).toBe(cause);
      expect(result.error.diagnostics).toHaveProperty("failure_cause");
      await expect(second).resolves.toEqual(ok({ method: "second" }));
      expect(executed).toEqual(["first", "second"]);
    },
  );

  it("does not replace an executor's typed failure", async () => {
    const original = failure("timeout", "Request deadline elapsed");
    const queue = new GhidraRequestQueue(
      () => Promise.resolve(err(original)),
      failure,
      () => Promise.resolve(ok(null)),
    );
    const result = await queue.run("first", {}, {});
    expect(result).toEqual(err(original));
    if (!result.ok) expect(result.error).toBe(original);
  });
});

describe("Ghidra request queue cancellation", () => {
  it("preserves cancellation cleanup failures and rejects queued work", async () => {
    const controller = new AbortController();
    const cause = new Error("Runtime removal failed");
    const cleanupFailure = new ProviderCleanupError(
      "ghidra",
      ["/tmp/runtime"],
      { reason: cause.message },
      { cause },
    );
    let release: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new GhidraRequestQueue(
      async () => {
        await completed;
        return err(
          failure("cancelled", "Request cancelled", undefined, {
            cancellation: { reason: null },
          }),
        );
      },
      failure,
      () => Promise.resolve(err(cleanupFailure)),
    );
    const active = queue.run("active", {}, { signal: controller.signal });
    const queued = queue.run("queued", {}, {});
    controller.abort();
    release?.();
    const result = await active;
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "cancelled",
        message: "Request cancelled",
      },
    });
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error.cleanupFailure).toBe(cleanupFailure);
    expect(result.error.cancellation).toEqual({ reason: null });
    await expect(queued).resolves.toMatchObject({
      ok: false,
      error: { kind: "process" },
    });
  });

  it.each([
    {
      cause: new Error("Unexpected cleanup rejection"),
      diagnostic: { message: "Unexpected cleanup rejection" },
    },
    { cause: undefined, diagnostic: { type: "undefined" } },
  ])(
    "keeps cancellation primary when cleanup rejects with $diagnostic",
    async ({ cause, diagnostic }) => {
      const controller = new AbortController();
      const cancellationCause = new Error("Caller cancelled");
      const original = failure(
        "cancelled",
        "Request cancelled",
        cancellationCause,
        { cancellation: { reason: cancellationCause } },
      );
      let release: (() => void) | undefined;
      const completed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queue = new GhidraRequestQueue(
        async () => {
          await completed;
          return err(original);
        },
        failure,
        async () => {
          throw cause;
        },
      );
      const active = queue.run("active", {}, { signal: controller.signal });
      controller.abort();
      release?.();

      const result = await active;
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "cancelled",
          message: "Request cancelled",
          diagnostics: {
            unexpected_cleanup_rejection: diagnostic,
          },
        },
      });
      if (result.ok) throw new Error("Expected cancellation");
      expect(result.error.cause).toBe(cancellationCause);
      expect(result.error.cancellation?.reason).toBe(cancellationCause);
      expect(result.error.cleanupFailure).toMatchObject({
        cleanupIncomplete: true,
        cause,
      });
    },
  );
});

type ExecutionResult = Result<null, GhidraSessionError>;
type CleanupResult = Result<null, ProviderCleanupError>;
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

it.each(["success", "cancellation"] as const)(
  "joins a completed %s response with active cancellation cleanup",
  async (response) => {
    const execution = phaseGate<void, ExecutionResult>();
    const cleanup = phaseGate<void, CleanupResult>();
    const stop = vi.fn(() => cleanup.hold());
    const controller = new AbortController();
    const original = failure("cancelled", "Request cancelled");
    const queue = new GhidraRequestQueue(() => execution.hold(), failure, stop);
    let settled = false;
    const pending = queue
      .run("active", {}, { signal: controller.signal })
      .then((result) => {
        settled = true;
        return result;
      });
    const completed = response === "success" ? ok(null) : err(original);
    try {
      execution.release(completed);
      controller.abort(null);
      await cleanup.reached(pending, "active cancellation cleanup");
      await nextTurn();
      expect(settled).toBe(false);
      cleanup.release(ok(null));
      const result = await pending;
      if (result.ok) throw new Error("Expected active cancellation");
      if (response === "cancellation") expect(result.error).toBe(original);
      else
        expect(result.error).toMatchObject({
          kind: "cancelled",
          cancellation: { reason: null },
        });
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      execution.release(completed);
      cleanup.release(ok(null));
      await pending;
    }
  },
);

it.each([false, true])(
  "records the session close on a late remote failure (cleanup failed: %s)",
  async (cleanupFailed) => {
    const execution = phaseGate<void, ExecutionResult>();
    const original = new GhidraSessionError(
      "remote",
      "decompile limit reached",
      { remote_code: "decompile_timed_out" },
      { remoteCode: "decompile_timed_out" },
    );
    const controller = new AbortController();
    const reason = new Error("client deadline");
    const cleanupFailure = new ProviderCleanupError(
      "ghidra",
      ["owned session"],
      {
        reason: "Fixture cleanup needs retry",
      },
    );
    const queue = new GhidraRequestQueue(
      () => execution.hold(),
      failure,
      () => Promise.resolve(cleanupFailed ? err(cleanupFailure) : ok(null)),
    );
    const pending = queue.run("active", {}, { signal: controller.signal });
    controller.abort(reason);
    execution.release(err(original));
    const result = await pending;
    if (result.ok) throw new Error("Expected the remote failure");
    // The observed failure stays primary; only the session close is added.
    expect(result.error).toMatchObject({
      kind: "remote",
      remoteCode: "decompile_timed_out",
      message: "decompile limit reached",
      concurrentCancellation: { reason },
      diagnostics: {
        remote_code: "decompile_timed_out",
        session_closed_by_cancellation: true,
      },
    });
    expect(result.error.cleanupFailure).toBe(
      cleanupFailed ? cleanupFailure : undefined,
    );
    expect(result.error.cancellation).toBeUndefined();
    expect(original.concurrentCancellation).toBeUndefined();
  },
);

it("awaits active cancellation cleanup when execution rejects", async () => {
  const execution = phaseGate<void, ExecutionResult>();
  const cleanup = phaseGate<void, CleanupResult>();
  const cause = new Error("executor rejected");
  const cleanupFailure = new ProviderCleanupError(
    "ghidra",
    ["owned-runtime"],
    {},
  );
  const controller = new AbortController();
  const queue = new GhidraRequestQueue(
    () => execution.hold(),
    failure,
    () => cleanup.hold(),
  );
  let settled = false;
  const pending = queue
    .run("active", {}, { signal: controller.signal })
    .then((result) => {
      settled = true;
      return result;
    });
  controller.abort(null);
  execution.reject(cause);
  await nextTurn();
  expect(settled).toBe(false);
  cleanup.release(err(cleanupFailure));
  const result = await pending;
  if (result.ok) throw new Error("Expected execution failure");
  expect(result.error).toMatchObject({ kind: "protocol", cause });
  expect(result.error.cleanupFailure).toBe(cleanupFailure);
});

it("normalizes a synchronous executor rejection and drains the next request", async () => {
  const cause = new Error("synchronous execution rejected");
  const queue = new GhidraRequestQueue(
    (method) => {
      if (method === "first") throw cause;
      return Promise.resolve(ok(null));
    },
    failure,
    () => Promise.resolve(ok(null)),
  );
  const result: unknown = await queue
    .run("first", {}, {})
    .catch((failure: unknown) => failure);
  expect(result).toMatchObject({
    ok: false,
    error: { kind: "protocol", cause },
  });
  await expect(queue.run("second", {}, {})).resolves.toEqual(ok(null));
});

it.each(["return", "throw"] as const)(
  "captures cleanup rejection before execution can %s",
  async (stage) => {
    const execution = phaseGate<void, ExecutionResult>();
    const cleanup = phaseGate<void, CleanupResult>();
    const cause = new Error("early cleanup rejection");
    const original = failure("remote", "Observed operation failure");
    const controller = new AbortController();
    const queue = new GhidraRequestQueue(
      () => execution.hold(),
      failure,
      () => cleanup.hold(),
    );
    let settled = false;
    const pending = queue
      .run("active", {}, { signal: controller.signal })
      .then((result) => {
        settled = true;
        return result;
      });
    controller.abort(null);
    cleanup.reject(cause);
    await nextTurn();
    expect(settled).toBe(false);
    if (stage === "return") execution.release(err(original));
    else execution.reject(original);
    const result = await pending;
    if (result.ok) throw new Error("Expected operation and cleanup failure");
    expect(result.error.kind).toBe("remote");
    expect(result.error.cleanupFailure).toMatchObject({
      cleanupIncomplete: true,
      cause,
    });
  },
);

it("retains cleanup uncertainty when the cancellation cleanup callback throws synchronously", async () => {
  const execution = phaseGate<void, ExecutionResult>();
  const cause = new Error("synchronous cleanup rejection");
  const controller = new AbortController();
  const queue = new GhidraRequestQueue(
    () => execution.hold(),
    failure,
    () => {
      throw cause;
    },
  );
  const pending = queue.run("active", {}, { signal: controller.signal });
  controller.abort(null);
  execution.release(ok(null));
  const result = await pending;
  if (result.ok) throw new Error("Expected unconfirmed cancellation cleanup");
  expect(result.error).toMatchObject({
    kind: "cancelled",
    cancellation: { reason: null },
    cleanupFailure: { cleanupIncomplete: true, cause },
  });
});

it.each([
  { order: "execution-first", execution: "returned" },
  { order: "cancellation-first", execution: "returned" },
  { order: "execution-first", execution: "rejected" },
  { order: "cancellation-first", execution: "rejected" },
])(
  "tracks both cleanup owners through $execution execution and $order retry",
  async ({ order, execution }) => {
    const executionCleanup = new ProviderCleanupError(
      "ghidra",
      ["execution-owner"],
      {},
    );
    const cancellationCleanup = new ProviderCleanupError(
      "ghidra",
      ["cancellation-owner"],
      {},
    );
    const primary = new GhidraSessionError(
      "remote",
      "Operation failed",
      {},
      { cleanupFailure: executionCleanup },
    );
    const controller = new AbortController();
    const queue = new GhidraRequestQueue(
      () =>
        execution === "returned"
          ? Promise.resolve(err(primary))
          : Promise.reject(primary),
      failure,
      () => Promise.resolve(err(cancellationCleanup)),
    );
    const pending = queue.run("active", {}, { signal: controller.signal });
    controller.abort(null);
    const result = await pending;
    if (result.ok || result.error.cleanupFailure === undefined)
      throw new Error("Expected both cleanup owners");
    const aggregate = result.error.cleanupFailure;
    expect(aggregate.cleanupIncomplete).toBe(true);
    const [first, second] =
      order === "execution-first"
        ? [executionCleanup, cancellationCleanup]
        : [cancellationCleanup, executionCleanup];
    releaseOwnedCleanup(first);
    expect(aggregate.cleanupIncomplete).toBe(true);
    releaseOwnedCleanup(second);
    expect(aggregate.cleanupIncomplete).toBe(false);
  },
);

describe("Ghidra request queue interruptible cancellation", () => {
  const cancelledReply = (): GhidraSessionError =>
    new GhidraSessionError(
      "remote",
      "Ghidra decompilation was cancelled",
      {},
      { remoteCode: "decompile_cancelled" },
    );
  /** One interruptible queue whose first execution is held by the test. */
  const interruptibleQueue = (
    graceMs: number,
    source: "default" | "setting" = "setting",
  ) => {
    const execution = phaseGate<void, Result<JsonValue, GhidraSessionError>>();
    const cleanup = phaseGate<void, CleanupResult>();
    const executed: { method: string; options: GhidraRequestOptions }[] = [];
    const stop = vi.fn(() => cleanup.hold());
    const queue = new GhidraRequestQueue(
      (method, _parameters, options) => {
        executed.push({ method, options });
        return executed.length === 1
          ? execution.hold()
          : Promise.resolve(ok({ method }));
      },
      failure,
      stop,
      {
        interruptible: (method) => method === "decompile",
        grace: { graceMs, source },
      },
    );
    return { queue, execution, cleanup, executed, stop };
  };

  it.each([
    { reply: "cancelled", order: "cancel-first" },
    { reply: "success", order: "cancel-first" },
    { reply: "success", order: "reply-first" },
  ] as const)(
    "keeps the session and queued work when a $reply reply settles the interrupted request ($order)",
    async ({ reply, order }) => {
      const { queue, execution, executed, stop } = interruptibleQueue(60_000);
      const controller = new AbortController();
      const reason = new Error("caller stopped");
      const active = queue.run("decompile", {}, { signal: controller.signal });
      const queued = queue.run("queued", {}, {});
      const completed = reply === "success" ? ok(null) : err(cancelledReply());
      if (order === "reply-first") execution.release(completed);
      controller.abort(reason);
      // The request is asked to stop while its reply is still awaited.
      expect(executed[0]?.options.interrupt?.aborted).toBe(true);
      expect(executed[0]?.options.signal?.aborted).toBe(false);
      execution.release(completed);

      const result = await active;
      if (result.ok) throw new Error("Expected the cancellation");
      expect(result.error).toMatchObject({
        kind: "cancelled",
        cancellation: { reason },
      });
      expect(result.error.cleanupFailure).toBeUndefined();
      expect(result.error.concurrentCancellation).toBeUndefined();
      await expect(queued).resolves.toEqual(ok({ method: "queued" }));
      await expect(queue.run("later", {}, {})).resolves.toEqual(
        ok({ method: "later" }),
      );
      expect(stop).not.toHaveBeenCalled();
    },
  );

  it("keeps an unrelated bridge failure primary without recording a session close", async () => {
    const { queue, execution, stop } = interruptibleQueue(60_000);
    const controller = new AbortController();
    const original = new GhidraSessionError(
      "remote",
      "decompile limit reached",
      {},
      { remoteCode: "decompile_timed_out" },
    );
    const active = queue.run("decompile", {}, { signal: controller.signal });
    const queued = queue.run("queued", {}, {});
    controller.abort(null);
    execution.release(err(original));
    const result = await active;
    if (result.ok) throw new Error("Expected the remote failure");
    expect(result.error).toBe(original);
    await expect(queued).resolves.toEqual(ok({ method: "queued" }));
    expect(stop).not.toHaveBeenCalled();
  });

  it("closes the session when no reply settles within the grace period, then keeps it closed for a late reply", async () => {
    const { queue, execution, cleanup, executed, stop } = interruptibleQueue(5);
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    let settled = false;
    const active = queue
      .run("decompile", {}, { signal: controller.signal })
      .then((result) => {
        settled = true;
        return result;
      });
    const queued = queue.run("queued", {}, {});
    controller.abort(reason);
    await cleanup.reached(active, "active cancellation cleanup");
    // The fallback is the closure used before: the reply is abandoned with
    // the caller's reason and queued work fails with the session.
    expect(executed[0]?.options.signal?.aborted).toBe(true);
    expect(executed[0]?.options.signal?.reason).toBe(reason);
    await expect(queued).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "process",
        // The expired grace is the control that closed the session.
        message:
          "Ghidra session closed after active request cancellation: Ghidra did not answer the cancelled request within the cancel grace (REA_GHIDRA_CANCEL_GRACE_MS is 5 ms (source launch environment; default 2000, floor 100, maximum 60000); set in the environment that starts REA)",
      },
    });
    // A reply that arrives during the final cleanup does not revive the session.
    execution.release(err(cancelledReply()));
    await nextTurn();
    expect(settled).toBe(false);
    cleanup.release(ok(null));
    const result = await active;
    if (result.ok) throw new Error("Expected the cancellation");
    expect(result.error).toMatchObject({
      kind: "remote",
      remoteCode: "decompile_cancelled",
      concurrentCancellation: { reason },
      diagnostics: { session_closed_by_cancellation: true },
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(executed.map(({ method }) => method)).toEqual(["decompile"]);
  });

  it.each([
    { graceMs: 2_000, source: "default" },
    { graceMs: 150, source: "setting" },
    { graceMs: 45_000, source: "setting" },
  ] as const)(
    "defers the fallback for exactly the $graceMs ms grace ($source)",
    async ({ graceMs, source }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { queue, execution, cleanup, stop } = interruptibleQueue(
          graceMs,
          source,
        );
        const controller = new AbortController();
        const active = queue.run(
          "decompile",
          {},
          { signal: controller.signal },
        );
        const queued = queue.run("queued", {}, {});
        controller.abort(new Error("caller stopped"));
        await vi.advanceTimersByTimeAsync(graceMs - 1);
        expect(stop).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(stop).toHaveBeenCalledOnce();
        const refused = await queued;
        if (refused.ok) throw new Error("Expected the session close");
        expect(refused.error.message).toContain(
          `REA_GHIDRA_CANCEL_GRACE_MS is ${String(graceMs)} ms (source ${source === "setting" ? "launch environment" : "default"};`,
        );
        // The abandoned wire wait settles, then the forced close finishes.
        execution.release(err(failure("cancelled", "abandoned")));
        cleanup.release(ok(null));
        await expect(active).resolves.toMatchObject({ ok: false });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("closes the session when the interrupted request fails without a bridge reply", async () => {
    const { queue, execution, cleanup, stop } = interruptibleQueue(60_000);
    const controller = new AbortController();
    const original = failure("process", "Ghidra bridge socket closed");
    const cleanupFailure = new ProviderCleanupError(
      "ghidra",
      ["owned-runtime"],
      {},
    );
    const active = queue.run("decompile", {}, { signal: controller.signal });
    const queued = queue.run("queued", {}, {});
    controller.abort(null);
    execution.release(err(original));
    await cleanup.reached(active, "active cancellation cleanup");
    cleanup.release(err(cleanupFailure));
    const result = await active;
    if (result.ok) throw new Error("Expected the process failure");
    expect(result.error).toMatchObject({ kind: "process" });
    expect(result.error.cleanupFailure).toBe(cleanupFailure);
    await expect(queued).resolves.toMatchObject({
      ok: false,
      error: { kind: "process" },
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not interrupt the active request when a queued request is cancelled", async () => {
    const { queue, execution, executed, stop } = interruptibleQueue(60_000);
    const controller = new AbortController();
    const active = queue.run("decompile", {}, { signal: controller.signal });
    const queuedController = new AbortController();
    const queued = queue.run(
      "decompile",
      {},
      { signal: queuedController.signal },
    );
    queuedController.abort("queued caller stopped");
    await expect(queued).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "cancelled",
        cancellation: { reason: "queued caller stopped" },
      },
    });
    expect(executed[0]?.options.interrupt?.aborted).toBe(false);
    execution.release(ok(null));
    await expect(active).resolves.toEqual(ok(null));
    expect(executed).toHaveLength(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("closes the session at once for an operation that is not interruptible", async () => {
    const { queue, execution, cleanup, executed, stop } =
      interruptibleQueue(60_000);
    const controller = new AbortController();
    const active = queue.run("rename", {}, { signal: controller.signal });
    controller.abort(null);
    await cleanup.reached(active, "active cancellation cleanup");
    expect(executed[0]?.options.interrupt).toBeUndefined();
    expect(executed[0]?.options.signal).toBe(controller.signal);
    // A reply that raced the cancel does not keep the edit's session.
    execution.release(ok(null));
    cleanup.release(ok(null));
    await expect(active).resolves.toMatchObject({
      ok: false,
      error: { kind: "cancelled", cancellation: { reason: null } },
    });
    expect(stop).toHaveBeenCalledOnce();
  });
});
