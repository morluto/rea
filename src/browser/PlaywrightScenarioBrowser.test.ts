import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { afterEach, expect, it, vi, onTestFinished } from "vitest";
import {
  mkdir,
  writeFile,
  rm,
  access,
  lstat,
  realpath,
  symlink,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  SCENARIO_PROFILE_OWNER_FILE,
  SCENARIO_PROFILE_PREFIX,
  observeScenarioOwnerIdentity,
  writeScenarioProfileOwner,
} from "./ScenarioProfileReclamation.js";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
} from "playwright-core";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import {
  attachedScenarioLeaseKey,
  failBrowserScenarioOperation,
  openPlaywrightScenarioBrowser,
  PlaywrightScenarioBrowserCleanupOwner,
} from "./PlaywrightScenarioBrowser.js";

const hostPlatform = process.platform;

// lstat never follows a link, so the assertion cannot pass on a dangling link.
const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", { value: hostPlatform });
});

it("locks one attached browser for spellings that discover the same endpoint", () => {
  expect(attachedScenarioLeaseKey("http://127.0.0.1:9222", "page-1")).toBe(
    attachedScenarioLeaseKey("http://127.0.0.1:9222/", "page-1"),
  );
  expect(attachedScenarioLeaseKey("http://127.0.0.1:9222", "page-1")).not.toBe(
    attachedScenarioLeaseKey("http://127.0.0.1:9222", "page-2"),
  );
});

it("locks one attached browser across loopback spellings of one endpoint", () => {
  expect(attachedScenarioLeaseKey("http://127.0.0.1:9222", "page-1")).toBe(
    attachedScenarioLeaseKey("http://[::1]:9222", "page-1"),
  );
  expect(attachedScenarioLeaseKey("http://[::1]:9222", "page-1")).not.toBe(
    attachedScenarioLeaseKey("http://[::1]:9222", "page-2"),
  );
  expect(attachedScenarioLeaseKey("http://127.0.0.1:9222", "page-1")).not.toBe(
    attachedScenarioLeaseKey("http://127.0.0.1:9223", "page-1"),
  );
});

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

it("keeps Termux execution support when launching Chromium on Android", async () => {
  Object.defineProperty(process, "platform", { value: "android" });
  vi.stubEnv("PREFIX", "/data/data/com.termux/files/usr");
  const selected = { LANG: "selected-language", PREFIX: process.env.PREFIX };
  let launchOptions: Parameters<
    typeof import("playwright-core").chromium.launchPersistentContext
  >[1];
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
          launchOptions = options;
          throw new Error("launch boundary reached");
        },
      },
    }),
  ).rejects.toThrow("launch boundary reached");

  expect(launchOptions?.args).toEqual(["--no-sandbox", "--single-process"]);
  expect(launchOptions?.env).toEqual({
    LANG: "selected-language",
    LD_PRELOAD: "/data/data/com.termux/files/usr/lib/libtermux-exec.so",
    TERMUX_EXEC__PROC_SELF_EXE: process.execPath,
  });
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
    let timedOutFailure: unknown;
    void timedOutClose.catch((cause: unknown) => {
      timedOutFailure = cause;
    });
    const timeoutExpectation = expect(timedOutClose).rejects.toMatchObject({
      reason: "cleanup_failed",
      cleanup: { reason: expect.stringContaining("timed out") },
    });
    await closeStarted.promise;
    let responseSettled = false;
    void timedOutClose
      .finally(() => {
        responseSettled = true;
      })
      .catch(() => {});
    await vi.advanceTimersByTimeAsync(29_999);
    expect(responseSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await timeoutExpectation;
    expect(settled).toEqual([]);

    closeResult.resolve(undefined);
    await cleanup.close();
    expect(settled).toEqual([true]);
    expect(timedOutFailure).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
  } finally {
    vi.useRealTimers();
  }
});

it("does not configure a late attached connection after cancellation", async () => {
  const connection =
    deferred<Pick<Browser, "contexts" | "close" | "isConnected" | "version">>();
  const connectionStarted = deferred<void>();
  const connectedBrowser = {
    close: vi.fn(async () => undefined),
    contexts: vi.fn(() => []),
    isConnected: vi.fn(() => true),
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
    isConnected: vi.fn(() => true),
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

const attachedBrowserFixture = (
  callbacks: {
    readonly send?: (method: string, parameters?: unknown) => Promise<unknown>;
    readonly emulateMedia?: (
      options: Parameters<Page["emulateMedia"]>[0],
    ) => Promise<void>;
    readonly detach?: () => Promise<void>;
    readonly closeBrowser?: () => Promise<void>;
    readonly isTargetClosed?: () => boolean;
    readonly isBrowserConnected?: () => boolean;
  } = {},
) => {
  const discoverySession = {
    send: vi.fn(async () => ({ targetInfo: { targetId: "page-1" } })),
    detach: vi.fn(async () => undefined),
  } as unknown as CDPSession;
  const environmentSession = {
    send: vi.fn(callbacks.send ?? (async () => undefined)),
    detach: vi.fn(callbacks.detach ?? (async () => undefined)),
  } as unknown as CDPSession;
  const page = {
    emulateMedia: vi.fn(callbacks.emulateMedia ?? (async () => undefined)),
    isClosed: vi.fn(callbacks.isTargetClosed ?? (() => false)),
  } as unknown as Page;
  const context = {
    pages: () => [page],
    newCDPSession: vi
      .fn()
      .mockResolvedValueOnce(discoverySession)
      .mockResolvedValueOnce(environmentSession),
  } as unknown as BrowserContext;
  const browser = {
    close: vi.fn(callbacks.closeBrowser ?? (async () => undefined)),
    contexts: () => [context],
    isConnected: vi.fn(callbacks.isBrowserConnected ?? (() => true)),
    version: () => "fixture",
  } as unknown as Pick<
    Browser,
    "contexts" | "close" | "isConnected" | "version"
  >;
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page-1",
    },
    start_url: { url: "https://example.test" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  });
  return {
    browser,
    environmentSession,
    page,
    open: (signal?: AbortSignal) =>
      openPlaywrightScenarioBrowser(
        scenario,
        {},
        {
          launcher: {
            connectOverCDP: async () => browser,
            launchPersistentContext: async () => {
              throw new Error("Unexpected launch");
            },
          },
          signal,
        },
      ),
  };
};

it("restores its environment overrides before releasing an attached browser", async () => {
  const cleanupOrder: string[] = [];
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        method === "Emulation.setTimezoneOverride" &&
        (parameters as { timezoneId?: string }).timezoneId === ""
      )
        cleanupOrder.push("timezone");
      if (
        method === "Emulation.setLocaleOverride" &&
        (parameters as { locale?: string }).locale === ""
      )
        cleanupOrder.push("locale");
      if (method === "Emulation.clearDeviceMetricsOverride")
        cleanupOrder.push("device-metrics");
    },
    emulateMedia: async (options) => {
      if (options?.colorScheme === null) cleanupOrder.push("media");
    },
    detach: async () => {
      cleanupOrder.push("session");
    },
    closeBrowser: async () => {
      cleanupOrder.push("browser");
    },
  });
  const opened = await fixture.open();
  await opened.cleanup.close();

  expect(fixture.environmentSession.send).toHaveBeenCalledWith(
    "Emulation.setLocaleOverride",
    { locale: "en-US" },
  );
  expect(fixture.environmentSession.send).toHaveBeenCalledWith(
    "Emulation.setLocaleOverride",
    { locale: "" },
  );
  expect(fixture.environmentSession.send).toHaveBeenCalledWith(
    "Emulation.setTimezoneOverride",
    { timezoneId: "" },
  );
  expect(fixture.environmentSession.send).toHaveBeenCalledWith(
    "Emulation.clearDeviceMetricsOverride",
  );
  expect(fixture.page.emulateMedia).toHaveBeenLastCalledWith({
    colorScheme: null,
    reducedMotion: null,
  });
  expect(fixture.environmentSession.detach).toHaveBeenCalledOnce();
  expect(fixture.browser.close).toHaveBeenCalledOnce();
  expect(cleanupOrder).toEqual([
    "timezone",
    "locale",
    "device-metrics",
    "media",
    "session",
    "browser",
  ]);
});

it("retains attached environment ownership until a failed reset can be retried", async () => {
  let localeResetAttempts = 0;
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        method === "Emulation.setLocaleOverride" &&
        (parameters as { locale?: string }).locale === ""
      ) {
        localeResetAttempts += 1;
        if (localeResetAttempts === 1) throw new Error("reset interrupted");
      }
    },
  });
  const opened = await fixture.open();

  await expect(opened.cleanup.close()).rejects.toMatchObject({
    reason: "cleanup_failed",
    cleanup: { reason: "reset interrupted" },
  });
  expect(fixture.browser.close).not.toHaveBeenCalled();
  expect(fixture.environmentSession.detach).not.toHaveBeenCalled();

  await opened.cleanup.close();
  expect(localeResetAttempts).toBe(2);
  expect(fixture.environmentSession.detach).toHaveBeenCalledOnce();
  expect(fixture.browser.close).toHaveBeenCalledOnce();
});

it("does not clear an attached environment override it failed to acquire", async () => {
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        method === "Emulation.setLocaleOverride" &&
        (parameters as { locale?: string }).locale === "en-US"
      )
        throw new Error("caller already owns locale");
    },
  });

  await expect(fixture.open()).rejects.toThrow("caller already owns locale");
  expect(fixture.environmentSession.send).not.toHaveBeenCalledWith(
    "Emulation.setLocaleOverride",
    { locale: "" },
  );
  expect(fixture.environmentSession.send).toHaveBeenCalledWith(
    "Emulation.clearDeviceMetricsOverride",
  );
  expect(fixture.environmentSession.detach).toHaveBeenCalledOnce();
  expect(fixture.browser.close).toHaveBeenCalledOnce();
});

it("waits for a cancelled environment mutation before restoring it", async () => {
  const localeStarted = deferred<void>();
  const localeResult = deferred<void>();
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        method === "Emulation.setLocaleOverride" &&
        (parameters as { locale?: string }).locale === "en-US"
      ) {
        localeStarted.resolve(undefined);
        await localeResult.promise;
      }
    },
  });
  const controller = new AbortController();
  const opening = fixture.open(controller.signal);
  await localeStarted.promise;
  const cancelled = expect(opening).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
  });
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  expect(fixture.environmentSession.send).not.toHaveBeenCalledWith(
    "Emulation.setLocaleOverride",
    { locale: "" },
  );

  localeResult.resolve(undefined);
  await cancelled;
  expect(fixture.environmentSession.send).toHaveBeenCalledWith(
    "Emulation.setLocaleOverride",
    { locale: "" },
  );
  expect(fixture.environmentSession.detach).toHaveBeenCalledOnce();
  expect(fixture.browser.close).toHaveBeenCalledOnce();
});

it("releases cleanup ownership when the attached target is destroyed", async () => {
  let targetClosed = false;
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        targetClosed &&
        method === "Emulation.setTimezoneOverride" &&
        (parameters as { timezoneId?: string }).timezoneId === ""
      )
        throw new Error("Target closed");
    },
    isTargetClosed: () => targetClosed,
  });
  const opened = await fixture.open();
  targetClosed = true;

  await opened.cleanup.close();
  expect(fixture.browser.close).toHaveBeenCalledOnce();
});

it("releases cleanup ownership when the attached browser disconnects", async () => {
  let connected = true;
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        !connected &&
        method === "Emulation.setTimezoneOverride" &&
        (parameters as { timezoneId?: string }).timezoneId === ""
      )
        throw new Error("Browser disconnected");
    },
    isBrowserConnected: () => connected,
  });
  const opened = await fixture.open();
  connected = false;

  await opened.cleanup.close();
  expect(fixture.browser.close).not.toHaveBeenCalled();
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

it("serializes concurrent attach across loopback spellings of one browser", async () => {
  const makeScenario = (endpoint: string) =>
    browserScenarioSchema.parse({
      browser: { mode: "connect", cdp_endpoint: endpoint, target_id: "page-1" },
      start_url: { url: "https://example.test" },
      actions: [
        {
          step_id: "wait",
          action: "wait_for_timeout",
          duration_ms: 1,
        },
      ],
    });
  const firstConnection =
    deferred<Pick<Browser, "contexts" | "close" | "isConnected" | "version">>();
  let rejectFirstConnection: ((cause: Error) => void) | undefined;
  const failingConnection = new Promise<never>((_resolve, reject) => {
    rejectFirstConnection = reject;
  });
  const firstStarted = deferred<void>();
  const endpoints: string[] = [];
  const connectOverCDP = vi.fn((endpoint: string) => {
    endpoints.push(endpoint);
    if (endpoints.length === 1) {
      firstStarted.resolve(undefined);
      return firstConnection.promise;
    }
    return failingConnection;
  });
  const launcher = {
    connectOverCDP,
    launchPersistentContext: async () => {
      throw new Error("Unexpected launch");
    },
  };

  const first = openPlaywrightScenarioBrowser(
    makeScenario("http://127.0.0.1:9222"),
    {},
    { launcher },
  );
  await firstStarted.promise;

  const second = openPlaywrightScenarioBrowser(
    makeScenario("http://[::1]:9222"),
    {},
    { launcher },
  );
  const race = await Promise.race([
    second.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise((resolve) => setTimeout(() => resolve("queued"), 100)),
  ]);
  // The loopback spelling is the same browser, so the second attach must wait
  // for the lease instead of dialing in parallel and being rejected.
  expect(race).toBe("queued");
  expect(connectOverCDP).toHaveBeenCalledTimes(1);

  firstConnection.resolve({
    close: vi.fn(async () => undefined),
    contexts: vi.fn(() => []),
    isConnected: vi.fn(() => true),
    version: () => "fixture",
  });
  await expect(first).rejects.toThrow();
  if (rejectFirstConnection === undefined)
    throw new Error("second connection did not begin");
  rejectFirstConnection(new Error("second connection failed"));
  await expect(second).rejects.toThrow("second connection failed");
  expect(endpoints).toEqual(["http://127.0.0.1:9222", "http://[::1]:9222"]);
});

it("tracks only pending browser cleanup resources and resolves prior errors after exact recovery", async () => {
  const root = await createTestTempDirectory("rea-browser-cleanup-recovery-");
  const profile = join(root, "profile");
  await mkdir(profile);
  await writeFile(join(profile, "authored-data"), "profile control");
  let browserDenied = true;
  let profileDenied = true;
  let browserCloses = 0;
  const owner = new PlaywrightScenarioBrowserCleanupOwner({
    closeBrowser: async () => {
      browserCloses++;
      if (browserDenied) throw new Error("controlled transport close failure");
    },
    removeProfile: async () => {
      if (profileDenied) throw new Error("controlled profile removal failure");
      await rm(profile, { recursive: true });
    },
  });
  try {
    const first: unknown = await owner.close().catch((cause: unknown) => cause);
    expect(first).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["browser_transport", "browser_profile"],
    });
    browserDenied = false;
    const second: unknown = await owner
      .close()
      .catch((cause: unknown) => cause);
    expect(owner.browserClosed).toBe(true);
    for (const error of [first, second])
      expect(error).toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: ["browser_profile"],
      });
    await access(profile);
    profileDenied = false;
    await owner.close();
    await expect(access(profile)).rejects.toMatchObject({ code: "ENOENT" });
    for (const error of [first, second])
      expect(error).toMatchObject({
        cleanupIncomplete: false,
        cleanupResources: [],
      });
    expect(browserCloses).toBe(2);
  } finally {
    browserDenied = false;
    profileDenied = false;
    await owner.close();
  }
});

it("bounds an opening failure response while retaining the same late cleanup lease", async () => {
  vi.useFakeTimers();
  let acknowledge: () => void = () => {};
  const late = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const lease = new AnalysisCleanupLease(() => late, ["browser_profile"]);
  const reason = { caller: "cancelled opening" };
  const primary = new AnalysisCancelledError("capture_browser_scenario", {
    cause: reason,
  });
  try {
    const opening = failBrowserScenarioOperation(lease, primary).catch(
      (cause: unknown) => cause,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const failure = await opening;
    expect(failure).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["browser_profile"],
    });
    expect(lease.released).toBe(false);
    acknowledge();
    await lease.release();
    expect(failure).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
    if (!(failure instanceof AnalysisError))
      throw new Error("Expected typed cleanup failure");
    expect(projectAnalysisError(failure)).toMatchObject({ code: "cancelled" });
    expect(primary.cause).toBe(reason);
  } finally {
    acknowledge();
    await lease.release();
    vi.useRealTimers();
  }
});

it.skipIf(process.platform === "win32")(
  "reclaims a terminated run's profile and records this one before launching",
  async () => {
    const stale = join(
      await realpath(tmpdir()),
      `${SCENARIO_PROFILE_PREFIX}${randomUUID()}`,
    );
    await mkdir(stale, { recursive: true });
    const exited = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)"],
      {
        stdio: "ignore",
      },
    );
    const ownerPid = exited.pid;
    if (ownerPid === undefined) throw new Error("Expected a child process id");
    const observed = await observeScenarioOwnerIdentity(ownerPid);
    if (observed.state !== "readable")
      throw new Error("Expected a readable owner identity");
    exited.kill("SIGKILL");
    await once(exited, "exit");
    await writeScenarioProfileOwner(stale, {
      pid: ownerPid,
      observeIdentity: async () => observed,
    });
    // A killed browser leaves its published singleton links behind.
    await symlink(`testhost-${String(ownerPid)}`, join(stale, "SingletonLock"));
    onTestFinished(async () => {
      await rm(stale, { recursive: true, force: true });
    });

    const scenario = browserScenarioSchema.parse({
      browser: { mode: "launch", executable_path: process.execPath },
      start_url: { url: "https://example.test" },
      actions: [
        { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
      ],
    });
    let recorded = false;
    await expect(
      openPlaywrightScenarioBrowser(
        scenario,
        {},
        {
          launcher: {
            connectOverCDP: async () => {
              throw new Error("Unexpected connection");
            },
            launchPersistentContext: async (profilePath) => {
              recorded = await exists(
                join(profilePath, SCENARIO_PROFILE_OWNER_FILE),
              );
              throw new Error("launch boundary reached");
            },
          },
        },
      ),
    ).rejects.toThrow("launch boundary reached");

    expect(recorded).toBe(true);
    await expect(exists(stale)).resolves.toBe(false);
  },
);
