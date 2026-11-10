import { expect, it, vi } from "vitest";

import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { CapabilityScope } from "./CapabilityScope.js";

it("retains each failed cleanup while releasing successful peers across retries", async () => {
  const scope = new CapabilityScope("Controlled mixed capability cleanup");
  const synchronousFailure = new Error("Synchronous close refusal");
  const asynchronousFailure = new Error("Asynchronous close refusal");
  let allowSynchronous = false;
  let allowAsynchronous = false;
  const successful = vi.fn(async () => undefined);
  const synchronous = vi.fn(() => {
    if (!allowSynchronous) throw synchronousFailure;
    return Promise.resolve();
  });
  const asynchronous = vi.fn(async () => {
    if (!allowAsynchronous) throw asynchronousFailure;
  });
  const rejectedWithoutReason = vi.fn(() =>
    allowAsynchronous ? Promise.resolve() : Promise.reject(undefined),
  );
  scope.own("released-peer", {}, successful);
  scope.own("synchronous-owner", {}, synchronous);
  scope.own("asynchronous-owner", {}, asynchronous);
  scope.own("undefined-rejection-owner", {}, rejectedWithoutReason);
  try {
    const first: unknown = await scope.close().catch((cause: unknown) => cause);
    expect(first).toBeInstanceOf(AggregateError);
    if (!(first instanceof AggregateError))
      throw new Error("Expected all cleanup failures");
    expect(first.message).toBe("Controlled mixed capability cleanup");
    expect(first.errors).toEqual([
      synchronousFailure,
      asynchronousFailure,
      undefined,
    ]);
    for (const close of [
      successful,
      synchronous,
      asynchronous,
      rejectedWithoutReason,
    ])
      expect(close).toHaveBeenCalledTimes(1);
    expect(() => scope.own("late-owner", {}, successful)).toThrow(
      "after host shutdown",
    );

    allowAsynchronous = true;
    const second: unknown = await scope
      .close()
      .catch((cause: unknown) => cause);
    expect(second).toBeInstanceOf(AggregateError);
    if (!(second instanceof AggregateError))
      throw new Error("Expected the remaining owner failure");
    expect(second.errors).toEqual([synchronousFailure]);
    expect(successful).toHaveBeenCalledTimes(1);
    expect(synchronous).toHaveBeenCalledTimes(2);
    expect(asynchronous).toHaveBeenCalledTimes(2);
    expect(rejectedWithoutReason).toHaveBeenCalledTimes(2);

    allowSynchronous = true;
    await scope.close();
    await scope.close();
    expect(synchronous).toHaveBeenCalledTimes(3);
    expect(successful).toHaveBeenCalledTimes(1);
    expect(asynchronous).toHaveBeenCalledTimes(2);
    expect(rejectedWithoutReason).toHaveBeenCalledTimes(2);
  } finally {
    allowSynchronous = true;
    allowAsynchronous = true;
    await scope.close();
  }
});

it("joins concurrent shutdowns and seals ownership before asynchronous cleanup settles", async () => {
  const scope = new CapabilityScope();
  let acknowledge = () => {};
  const entered = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const close = vi.fn(async () => {
    acknowledge();
    await released;
  });
  scope.own("controlled-owner", {}, close);
  const first = scope.close();
  let second: Promise<void> | undefined;
  try {
    await awaitAcknowledgement(entered, first, "capability cleanup");
    second = scope.close();
    expect(second).toBe(first);
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => scope.own("later-owner", {}, async () => undefined)).toThrow(
      "after host shutdown",
    );
    release();
    await Promise.all([first, second]);
    expect(() =>
      scope.own("post-shutdown-owner", {}, async () => undefined),
    ).toThrow("after host shutdown");
    await scope.close();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await Promise.allSettled([
      first,
      ...(second === undefined ? [] : [second]),
    ]);
    await scope.close();
  }
});
