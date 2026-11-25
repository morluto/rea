import { expect, it, vi } from "vitest";

import {
  OwnedWorkerRuntime,
  WorkerCleanupRegistry,
} from "./OwnedWorkerRuntime.js";

it("retries one host's retained runtime without failing another host", async () => {
  const first = new WorkerCleanupRegistry();
  const second = new WorkerCleanupRegistry();
  let fail = true;
  const stuck = new OwnedWorkerRuntime({
    rootPrefix: "rea-worker-host-",
    cleanupRegistry: first,
    retryCleanup: async () => {
      if (fail) throw new Error("host still owns its worker");
    },
  });
  stuck.retainForCleanup();
  try {
    await expect(second.retry()).resolves.toBeUndefined();
    await expect(first.retry()).rejects.toThrow("host still owns its worker");
  } finally {
    fail = false;
    await stuck.close();
  }
});

it("retries all retained owners, preserves exact causes, and skips only the selected owner", async () => {
  const registry = new WorkerCleanupRegistry();
  const firstCause = new Error("first owner still owns its worker");
  const secondCause = new Error("second owner still owns its worker");
  const first = {
    retryRetainedCleanup: vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(firstCause),
  };
  const second = {
    retryRetainedCleanup: vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(secondCause),
  };
  const skipped = { retryRetainedCleanup: vi.fn(async () => {}) };
  for (const owner of [first, skipped, second]) registry.add(owner);

  const failure: unknown = await registry
    .retry(skipped)
    .catch((cause: unknown) => cause);
  if (!(failure instanceof AggregateError))
    throw new Error("Expected both failed cleanup causes");
  expect(failure.errors).toHaveLength(2);
  expect(failure.errors[0]).toBe(firstCause);
  expect(failure.errors[1]).toBe(secondCause);

  second.retryRetainedCleanup.mockImplementation(async () => {
    registry.delete(second);
  });
  await expect(registry.retry(skipped)).rejects.toBe(firstCause);
  expect(registry.has(first)).toBe(true);
  expect(registry.has(second)).toBe(false);

  first.retryRetainedCleanup.mockImplementation(async () => {
    registry.delete(first);
  });
  await registry.retry(skipped);
  expect(first.retryRetainedCleanup).toHaveBeenCalledTimes(3);
  expect(second.retryRetainedCleanup).toHaveBeenCalledTimes(2);
  expect(skipped.retryRetainedCleanup).not.toHaveBeenCalled();
  expect(registry.has(first)).toBe(false);
  expect(registry.has(skipped)).toBe(true);
});
