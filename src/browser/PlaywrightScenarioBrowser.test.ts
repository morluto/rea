import { afterEach, expect, it, vi } from "vitest";
import type { Browser } from "playwright-core";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import {
  openPlaywrightScenarioBrowser,
  PlaywrightScenarioBrowserCleanupOwner,
} from "./PlaywrightScenarioBrowser.js";

afterEach(() => vi.unstubAllEnvs());

const deferred = <Value>() => {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

it("passes the selected environment to the actual browser launch boundary", async () => {
  vi.stubEnv("LANG", "ambient-language");
  const selected = {
    LANG: "selected-language",
    PATH: "/selected/bin",
    REA_PRIVATE_VALUE: "not-a-launch-setting",
  };
  let launchedEnvironment: unknown;
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: process.execPath },
    start_url: { url: "https://example.test" },
    actions: [
      { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
    ],
  });
  await expect(
    openPlaywrightScenarioBrowser(scenario, selected, {
      launcher: {
        connectOverCDP: async () => {
          throw new Error("Unexpected connection");
        },
        launchPersistentContext: async (_profile, options) => {
          launchedEnvironment = options?.env;
          throw new Error("launch boundary reached");
        },
      },
    }),
  ).rejects.toThrow("launch boundary reached");
  expect(launchedEnvironment).toEqual({
    LANG: "selected-language",
    PATH: "/selected/bin",
  });
});

it("keeps attached-target ownership until cancelled cleanup actually settles", async () => {
  const controller = new AbortController();
  const closeStarted = deferred<void>();
  const closeResult = deferred<void>();
  const settled: boolean[] = [];
  const cleanup = new PlaywrightScenarioBrowserCleanupOwner({
    closeBrowser: () => {
      closeStarted.resolve(undefined);
      return closeResult.promise;
    },
    removeProfile: undefined,
    onSettled: (browserClosed) => settled.push(browserClosed),
  });
  const cancelledClose = cleanup.close(undefined, controller.signal);
  await closeStarted.promise;
  controller.abort();
  await expect(cancelledClose).rejects.toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cleanup_failed",
    cleanupIncomplete: true,
    userCategory: "cancelled",
  });
  expect(settled).toEqual([]);

  closeResult.resolve(undefined);
  await cleanup.close();
  expect(settled).toEqual([true]);
});

it("keeps attached-target ownership after the cleanup response timeout", async () => {
  vi.useFakeTimers();
  try {
    const closeStarted = deferred<void>();
    const closeResult = deferred<void>();
    const settled: boolean[] = [];
    const cleanup = new PlaywrightScenarioBrowserCleanupOwner({
      closeBrowser: () => {
        closeStarted.resolve(undefined);
        return closeResult.promise;
      },
      removeProfile: undefined,
      onSettled: (browserClosed) => settled.push(browserClosed),
    });
    const timedOutClose = cleanup.close();
    const timeoutExpectation = expect(timedOutClose).rejects.toMatchObject({
      reason: "cleanup_failed",
      cleanup: { reason: expect.stringContaining("timed out") },
    });
    await closeStarted.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    await timeoutExpectation;
    expect(settled).toEqual([]);

    closeResult.resolve(undefined);
    await cleanup.close();
    expect(settled).toEqual([true]);
  } finally {
    vi.useRealTimers();
  }
});

it("does not configure a late attached connection after cancellation", async () => {
  const connection =
    deferred<Pick<Browser, "contexts" | "close" | "version">>();
  const connectionStarted = deferred<void>();
  const connectedBrowser = {
    close: vi.fn(async () => undefined),
    contexts: vi.fn(() => []),
    version: () => "fixture",
  };
  const controller = new AbortController();
  const launcher = {
    connectOverCDP: () => {
      connectionStarted.resolve(undefined);
      return connection.promise;
    },
    launchPersistentContext: async () => {
      throw new Error("Unexpected launch");
    },
  };
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page-1",
    },
    start_url: { url: "https://example.test" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  });
  const opening = openPlaywrightScenarioBrowser(
    scenario,
    {},
    {
      launcher,
      signal: controller.signal,
    },
  );
  await connectionStarted.promise;
  controller.abort();
  connection.resolve(connectedBrowser);

  await expect(opening).rejects.toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cancelled",
  });
  expect(connectedBrowser.contexts).not.toHaveBeenCalled();
  expect(connectedBrowser.close).toHaveBeenCalledOnce();
});

it("closes an attached connection when cancellation starts target discovery", async () => {
  const controller = new AbortController();
  const connectedBrowser = {
    close: vi.fn(async () => undefined),
    contexts: vi.fn(() => {
      controller.abort();
      return [];
    }),
    version: () => "fixture",
  };
  const launcher = {
    connectOverCDP: async () => connectedBrowser,
    launchPersistentContext: async () => {
      throw new Error("Unexpected launch");
    },
  };
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page-1",
    },
    start_url: { url: "https://example.test" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  });

  await expect(
    openPlaywrightScenarioBrowser(
      scenario,
      {},
      {
        launcher,
        signal: controller.signal,
      },
    ),
  ).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
  });
  expect(connectedBrowser.contexts).toHaveBeenCalledOnce();
  expect(connectedBrowser.close).toHaveBeenCalledOnce();
});

it("cancels same-target queued connection before acquiring a browser", async () => {
  const makeScenario = (targetId: string) =>
    browserScenarioSchema.parse({
      browser: {
        mode: "connect",
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: targetId,
      },
      start_url: { url: "https://example.test" },
      actions: [
        {
          step_id: "wait",
          action: "wait_for_timeout",
          duration_ms: 1,
        },
      ],
    });
  let rejectFirst: ((cause: Error) => void) | undefined;
  const firstConnection = new Promise<never>((_resolve, reject) => {
    rejectFirst = reject;
  });
  let resolveFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    resolveFirstStarted = resolve;
  });
  const endpoints: string[] = [];
  const connectOverCDP = vi.fn((endpoint: string) => {
    endpoints.push(endpoint);
    if (endpoints.length === 1) {
      resolveFirstStarted?.();
      return firstConnection;
    }
    return Promise.reject(new Error("connection failed"));
  });
  const launchPersistentContext = vi.fn(async () => {
    throw new Error("launch boundary reached");
  });
  const launcher = { connectOverCDP, launchPersistentContext };
  const environment = {};
  const first = openPlaywrightScenarioBrowser(
    makeScenario("page-1"),
    environment,
    { launcher },
  );
  await firstStarted;
  expect(connectOverCDP).toHaveBeenCalledTimes(1);

  const controller = new AbortController();
  const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
  const queued = openPlaywrightScenarioBrowser(
    makeScenario("page-1"),
    environment,
    { launcher, signal: controller.signal },
  );
  controller.abort();
  await expect(queued).rejects.toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cancelled",
  });
  expect(connectOverCDP).toHaveBeenCalledTimes(1);
  expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));

  await expect(
    openPlaywrightScenarioBrowser(makeScenario("page-2"), environment, {
      launcher,
    }),
  ).rejects.toThrow("connection failed");
  expect(connectOverCDP).toHaveBeenCalledTimes(2);

  const launch = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: process.execPath },
    start_url: { url: "https://example.test" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  });
  await expect(
    openPlaywrightScenarioBrowser(launch, environment, { launcher }),
  ).rejects.toThrow("launch boundary reached");
  expect(launchPersistentContext).toHaveBeenCalledTimes(1);

  if (rejectFirst === undefined)
    throw new Error("first connection did not begin");
  rejectFirst(new Error("first connection failed"));
  await expect(first).rejects.toThrow("first connection failed");
  await expect(
    openPlaywrightScenarioBrowser(makeScenario("page-1"), environment, {
      launcher,
    }),
  ).rejects.toThrow("connection failed");
  expect(connectOverCDP).toHaveBeenCalledTimes(3);
});
