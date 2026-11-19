import { expect, it } from "vitest";

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

it("retries every independent retained owner and keeps only exact failures pending", async () => {
  const registry = new WorkerCleanupRegistry();
  const physical = new Error("first owner still owns its worker");
  let failing = true;
  const calls: string[] = [];
  const first = {
    retryRetainedCleanup: async () => {
      calls.push("first");
      if (failing) throw physical;
      registry.delete(first);
    },
  };
  const second = {
    retryRetainedCleanup: async () => {
      calls.push("second");
      registry.delete(second);
    },
  };
  registry.add(first);
  registry.add(second);
  await expect(registry.retry()).rejects.toBe(physical);
  expect(calls).toEqual(["first", "second"]);
  expect(registry.has(first)).toBe(true);
  expect(registry.has(second)).toBe(false);
  failing = false;
  await registry.retry();
  expect(calls).toEqual(["first", "second", "first"]);
  expect(registry.has(first)).toBe(false);
});

it("retains every failed cleanup cause and skips only the caller-selected owner", async () => {
  const registry = new WorkerCleanupRegistry();
  const causes = [
    new Error("first exact cleanup"),
    new Error("second exact cleanup"),
  ];
  const skipped = {
    retryRetainedCleanup: async () => {
      throw new Error("must not retry selected owner");
    },
  };
  const owners = causes.map((cause) => ({
    retryRetainedCleanup: async () => {
      throw cause;
    },
  }));
  registry.add(skipped);
  for (const owner of owners) registry.add(owner);
  const failure = await registry.retry(skipped).catch((cause) => cause);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toEqual(causes);
  expect(registry.has(skipped)).toBe(true);
  for (const owner of owners) expect(registry.has(owner)).toBe(true);
});
