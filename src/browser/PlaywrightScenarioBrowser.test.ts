import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCleanupLease } from "../resources/AnalysisCleanupLease.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdir, writeFile, rm, access, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { phaseGate } from "../../tests/support/lifecycleHarness.js";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
} from "playwright-core";

import { DEFAULT_CDP_COMMAND_TIMEOUT_MS } from "../domain/browserDeadline.js";
import { browserScenarioSchema } from "../domain/browserScenario.js";
import { PLAYWRIGHT_CLEANUP_CONFIRMATION_TIMEOUT_MS } from "./PlaywrightExecutionBoundary.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  attachedScenarioLeaseKey,
  failBrowserScenarioOperation,
  openPlaywrightScenarioBrowser,
  PlaywrightScenarioBrowserCleanupOwner,
} from "./PlaywrightScenarioBrowser.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("locks one attached browser for spellings that discover the same endpoint", () => {
  expect(attachedScenarioLeaseKey("http://127.0.0.1:9222", "page-1")).toBe(
    attachedScenarioLeaseKey("http://127.0.0.1:9222/", "page-1"),
  );
  expect(attachedScenarioLeaseKey("http://127.0.0.1:9222", "page-1")).not.toBe(
    attachedScenarioLeaseKey("http://127.0.0.1:9222", "page-2"),
  );
  expect(attachedScenarioLeaseKey("http://127.0.0.1:9222", "page-1")).not.toBe(
    attachedScenarioLeaseKey("http://127.0.0.1:9223", "page-1"),
  );
});

it.each([
  { platform: "win32", systemRootKey: "SYSTEMROOT" },
  { platform: "linux", systemRootKey: "SystemRoot" },
] as const)(
  "passes the selected environment to the $platform browser launch boundary",
  async ({ platform, systemRootKey }) => {
    vi.stubEnv("LANG", "ambient-language");
    const selected = snapshotEnvironment(
      {
        LANG: "selected-language",
        PATH: "/selected/bin",
        SystemRoot: "C:/WINDOWS",
        REA_PRIVATE_VALUE: "not-a-launch-setting",
      },
      platform,
    );
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
        platform,
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
    ).rejects.toMatchObject({
      diagnostics: { startup_error: "launch boundary reached" },
    });
    expect(launchedEnvironment).toEqual({
      LANG: "selected-language",
      PATH: "/selected/bin",
      [systemRootKey]: "C:/WINDOWS",
    });
  },
);

it.skipIf(process.platform === "win32")(
  "passes the caller-selected symlink-parent executable to the launch boundary",
  async () => {
    const root = await createTestTempDirectory("rea-browser-caller-path-");
    try {
      await mkdir(join(root, "real/inner"), { recursive: true });
      await symlink(join(root, "real/inner"), join(root, "link"));
      const selected = absoluteCallerPath("link/../browser", { cwd: root });
      let launchedExecutable: string | undefined;
      const scenario = browserScenarioSchema.parse({
        browser: { mode: "launch", executable_path: selected },
        start_url: { url: "https://example.test" },
        actions: [
          { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
        ],
      });

      await expect(
        openPlaywrightScenarioBrowser(
          scenario,
          {},
          {
            launcher: {
              connectOverCDP: async () => {
                throw new Error("Unexpected connection");
              },
              launchPersistentContext: async (_profile, options) => {
                launchedExecutable = options?.executablePath;
                throw new Error("fake launch boundary reached");
              },
            },
          },
        ),
      ).rejects.toMatchObject({
        diagnostics: { startup_error: "fake launch boundary reached" },
      });

      expect(launchedExecutable).toBe(selected);
      expect(selected).toBe(`${root}/link/../browser`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("keeps Termux execution support when launching Chromium on Android", async () => {
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
      platform: "android",
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
  ).rejects.toMatchObject({
    diagnostics: { startup_error: "launch boundary reached" },
  });

  expect(launchOptions?.chromiumSandbox).toBe(false);
  expect(launchOptions?.args).toEqual(["--single-process"]);
  expect(launchOptions?.env).toEqual({
    LANG: "selected-language",
    LD_PRELOAD: "/data/data/com.termux/files/usr/lib/libtermux-exec.so",
    TERMUX_EXEC__PROC_SELF_EXE: process.execPath,
  });
});

const launchScenario = browserScenarioSchema.parse({
  browser: { mode: "launch", executable_path: process.execPath },
  start_url: { url: "https://example.test" },
  actions: [{ step_id: "settle", action: "wait_for_timeout", duration_ms: 1 }],
});

it("does not launch a browser for an already-cancelled opening", async () => {
  const controller = new AbortController();
  const reason = { caller: "cancelled before browser acquisition" };
  controller.abort(reason);
  const launch = vi.fn(async () => {
    throw new Error("unexpected launch after cancellation");
  });
  await expect(
    openPlaywrightScenarioBrowser(
      launchScenario,
      {},
      {
        signal: controller.signal,
        launcher: {
          launchPersistentContext: launch,
          connectOverCDP: async () => {
            throw new Error("Unexpected connection");
          },
        },
      },
    ),
  ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
  expect(launch).not.toHaveBeenCalled();
});

it.each([false, true])(
  "admits a late launch only while its caller is active (cancelled: %s)",
  async (cancelled) => {
    const controller = new AbortController();
    const reason = { caller: "cancelled during browser launch" };
    const launch = phaseGate<void, BrowserContext>();
    let profile = "";
    const close = vi.fn(async () => undefined);
    const newPage = vi.fn(async () => ({}) as Page);
    const opening = openPlaywrightScenarioBrowser(
      launchScenario,
      {},
      {
        signal: controller.signal,
        launcher: {
          launchPersistentContext: (directory) => {
            profile = directory;
            return launch.hold();
          },
          connectOverCDP: async () => {
            throw new Error("Unexpected connection");
          },
        },
      },
    ).then(
      (value) => ({ ok: true as const, value }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    const context = {
      close,
      browser: () => ({}) as Browser,
      pages: () => [],
      newPage,
    } as unknown as BrowserContext;
    try {
      await launch.reached(opening, "browser launch");
      if (cancelled) controller.abort(reason);
      launch.release(context);
      const result = await opening;
      if (result.ok) {
        try {
          expect(cancelled).toBe(false);
          expect(newPage).toHaveBeenCalledOnce();
          expect(close).not.toHaveBeenCalled();
          expect(result.value.profilePath).toBe(profile);
        } finally {
          await result.value.cleanup.close();
        }
      } else {
        expect(cancelled).toBe(true);
        expect(result.cause).toMatchObject({ reason: "cancelled" });
        if (!(result.cause instanceof AnalysisError))
          throw new Error("Expected typed cancellation");
        expect(result.cause.cause).toBe(reason);
        expect(newPage).not.toHaveBeenCalled();
      }
      expect(close).toHaveBeenCalledOnce();
      await expect(access(profile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      controller.abort(reason);
      launch.release(context);
      const outcome = await opening;
      if (outcome.ok) await outcome.value.cleanup.close();
    }
  },
);

it.each([
  { environment: {}, sandbox: true },
  { environment: { REA_BROWSER_NO_SANDBOX: "false" }, sandbox: true },
  { environment: { REA_BROWSER_NO_SANDBOX: "1" }, sandbox: true },
  { environment: { REA_BROWSER_NO_SANDBOX: "true" }, sandbox: false },
])(
  "launches Chromium with sandbox $sandbox for $environment",
  async ({ environment, sandbox }) => {
    let launchOptions: Parameters<
      typeof import("playwright-core").chromium.launchPersistentContext
    >[1];

    await expect(
      openPlaywrightScenarioBrowser(launchScenario, environment, {
        platform: "linux",
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
    ).rejects.toMatchObject({
      diagnostics: { startup_error: "launch boundary reached" },
      // Chromium's startup log, not REA, says whether the sandbox caused it.
      remediationAction: sandbox
        ? expect.stringContaining("REA_BROWSER_NO_SANDBOX=true")
        : "Review the selected executable and startup diagnostics, then correct the launch configuration before retrying.",
    });

    expect(launchOptions?.chromiumSandbox).toBe(sandbox);
    expect(launchOptions?.args).toEqual([]);
    expect(launchOptions?.env).toEqual({});
  },
);

it("waits for bounded event finalization and owned browser teardown", async () => {
  vi.useFakeTimers();
  try {
    const closeBrowser = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    );
    const removeProfile = vi.fn(async () => undefined);
    const cleanup = new PlaywrightScenarioBrowserCleanupOwner({
      closeBrowser,
      removeProfile,
    });
    const finished = cleanup
      .close(() => new Promise<void>((resolve) => setTimeout(resolve, 4_500)))
      .then(
        () => ({ ok: true }),
        (cause: unknown) => ({ ok: false, cause }),
      );
    await vi.advanceTimersByTimeAsync(4_500);
    expect(removeProfile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await finished).toEqual({ ok: true });
    expect(cleanup.browserClosed).toBe(true);
    expect(closeBrowser).toHaveBeenCalledOnce();
    expect(removeProfile).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps attached-target ownership after the cleanup response timeout", async () => {
  vi.useFakeTimers();
  try {
    const browserClose = phaseGate();
    const settled: boolean[] = [];
    const cleanup = new PlaywrightScenarioBrowserCleanupOwner({
      closeBrowser: async (disconnectAtBoundary) => {
        const closed = browserClose.hold();
        await disconnectAtBoundary(() => closed);
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
    await browserClose.reached(timedOutClose, "browser close");
    let responseSettled = false;
    void timedOutClose
      .finally(() => {
        responseSettled = true;
      })
      .catch(() => {});
    await vi.advanceTimersByTimeAsync(
      PLAYWRIGHT_CLEANUP_CONFIRMATION_TIMEOUT_MS - 1,
    );
    expect(responseSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await timeoutExpectation;
    expect(settled).toEqual([]);

    browserClose.release();
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
  const connection = phaseGate<
    void,
    Pick<Browser, "contexts" | "close" | "isConnected" | "version">
  >();
  const connectedBrowser = {
    close: vi.fn(async () => undefined),
    contexts: vi.fn(() => []),
    isConnected: vi.fn(() => true),
    version: () => "fixture",
  };
  const controller = new AbortController();
  const launcher = {
    connectOverCDP: () => connection.hold(),
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
  try {
    await connection.reached(opening, "CDP connection");
    controller.abort();
    connection.release(connectedBrowser);

    await expect(opening).rejects.toMatchObject({
      _tag: "BrowserObservationError",
      reason: "cancelled",
    });
    expect(connectedBrowser.contexts).not.toHaveBeenCalled();
    expect(connectedBrowser.close).toHaveBeenCalledOnce();
  } finally {
    controller.abort();
    connection.release(connectedBrowser);
    const opened = await opening.catch(() => undefined);
    await opened?.cleanup.close();
  }
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
    // Chromium acknowledges an Emulation command with an empty result object.
    send: vi.fn(
      async (method: string, parameters?: unknown) =>
        (await callbacks.send?.(method, parameters)) ?? {},
    ),
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
        method === "Emulation.setFocusEmulationEnabled" &&
        (parameters as { enabled?: boolean }).enabled === false
      )
        cleanupOrder.push("focus");
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
    undefined,
  );
  expect(fixture.page.emulateMedia).toHaveBeenLastCalledWith({
    colorScheme: null,
    reducedMotion: null,
  });
  expect(fixture.environmentSession.detach).toHaveBeenCalledOnce();
  expect(fixture.browser.close).toHaveBeenCalledOnce();
  expect(cleanupOrder).toEqual([
    "focus",
    "timezone",
    "locale",
    "device-metrics",
    "media",
    "session",
    "browser",
  ]);
});

it("checks a late stop after attached restoration and before transport disconnect", async () => {
  const restoration = phaseGate();
  const order: string[] = [];
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        method === "Emulation.setTimezoneOverride" &&
        (parameters as { timezoneId?: string }).timezoneId === ""
      ) {
        order.push("restore-started");
        await restoration.hold();
        order.push("restore-finished");
      }
    },
    closeBrowser: async () => {
      order.push("browser-disconnected");
    },
  });
  const opened = await fixture.open();
  let revision = 0;
  const release = opened.cleanup.release(undefined, {
    get revision() {
      return revision;
    },
    async run() {
      order.push(`gate:${revision}`);
    },
  });

  try {
    await restoration.reached(release, "browser restoration");
    revision += 1;
    restoration.release();
    await release;
  } finally {
    restoration.release();
    await release.catch(() => undefined);
  }

  expect(order).toEqual([
    "restore-started",
    "restore-finished",
    "gate:1",
    "browser-disconnected",
  ]);
});

it.each(["locale", "focus"] as const)(
  "retains a failed %s reset for cleanup retry",
  async (mutation) => {
    let resetAttempts = 0;
    const fixture = attachedBrowserFixture({
      send: async (method, parameters) => {
        if (
          (mutation === "locale" &&
            method === "Emulation.setLocaleOverride" &&
            (parameters as { locale?: string }).locale === "") ||
          (mutation === "focus" &&
            method === "Emulation.setFocusEmulationEnabled" &&
            (parameters as { enabled?: boolean }).enabled === false)
        ) {
          resetAttempts += 1;
          if (resetAttempts === 1) throw new Error("reset interrupted");
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
    expect(resetAttempts).toBe(2);
    expect(fixture.environmentSession.detach).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  },
);

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
    undefined,
  );
  expect(fixture.environmentSession.detach).toHaveBeenCalledOnce();
  expect(fixture.browser.close).toHaveBeenCalledOnce();
});

it("restores an attached environment override whose success reply is malformed", async () => {
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        method === "Emulation.setLocaleOverride" &&
        (parameters as { locale?: string }).locale === "en-US"
      )
        return "applied";
      return undefined;
    },
  });

  await expect(fixture.open()).rejects.toMatchObject({
    reason: "protocol_error",
  });
  expect(fixture.environmentSession.send).toHaveBeenCalledWith(
    "Emulation.setLocaleOverride",
    { locale: "" },
  );
  expect(fixture.environmentSession.detach).toHaveBeenCalledOnce();
});

it("waits for a cancelled environment mutation before restoring it", async () => {
  const localeMutation = phaseGate();
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        method === "Emulation.setLocaleOverride" &&
        (parameters as { locale?: string }).locale === "en-US"
      ) {
        await localeMutation.hold();
      }
    },
  });
  const controller = new AbortController();
  const opening = fixture.open(controller.signal);
  try {
    await localeMutation.reached(opening, "locale mutation");
    const cancelled = expect(opening).rejects.toMatchObject({
      _tag: "AnalysisCancelledError",
    });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.environmentSession.send).not.toHaveBeenCalledWith(
      "Emulation.setLocaleOverride",
      { locale: "" },
    );

    localeMutation.release();
    await cancelled;
    expect(fixture.environmentSession.send).toHaveBeenCalledWith(
      "Emulation.setLocaleOverride",
      { locale: "" },
    );
    expect(fixture.environmentSession.detach).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  } finally {
    controller.abort();
    localeMutation.release();
    const opened = await opening.catch(() => undefined);
    await opened?.cleanup.close();
  }
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
  const firstConnection = phaseGate<void, never>();
  const endpoints: string[] = [];
  const connectOverCDP = vi.fn((endpoint: string) => {
    endpoints.push(endpoint);
    if (endpoints.length === 1) return firstConnection.hold();
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
  await firstConnection.reached(first, "first CDP connection");
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
  ).rejects.toMatchObject({
    diagnostics: { startup_error: "launch boundary reached" },
  });
  expect(launchPersistentContext).toHaveBeenCalledTimes(1);

  firstConnection.reject(new Error("first connection failed"));
  await expect(first).rejects.toThrow("first connection failed");
  await expect(
    openPlaywrightScenarioBrowser(makeScenario("page-1"), environment, {
      launcher,
    }),
  ).rejects.toThrow("connection failed");
  expect(connectOverCDP).toHaveBeenCalledTimes(3);
});

it("serializes concurrent attach across loopback spellings of one browser", async () => {
  const open = (endpoint: string) =>
    openPlaywrightScenarioBrowser(
      browserScenarioSchema.parse({
        browser: {
          mode: "connect",
          cdp_endpoint: endpoint,
          target_id: "page-1",
        },
        start_url: { url: "https://example.test" },
        actions: scenarioActions,
      }),
      {},
      { launcher },
    );
  const firstConnection = phaseGate<
    void,
    Pick<Browser, "contexts" | "close" | "isConnected" | "version">
  >();
  const firstClose = phaseGate();
  const secondFailure = new Error("second connection failed");
  const order: string[] = [];
  const launcher = {
    connectOverCDP: async (endpoint: string) => {
      order.push(endpoint);
      if (endpoint === "http://127.0.0.1:9222") return firstConnection.hold();
      throw secondFailure;
    },
    launchPersistentContext: async () => {
      throw new Error("Unexpected launch");
    },
  };

  const first = open("http://127.0.0.1:9222");
  await firstConnection.reached(first, "first CDP connection");
  const outcomes = Promise.allSettled([first, open("http://[::1]:9222")]);

  firstConnection.release({
    close: async () => {
      await firstClose.hold();
      order.push("first transport closed");
    },
    contexts: () => [],
    isConnected: () => true,
    version: () => "fixture",
  });
  try {
    await firstClose.reached(first, "first transport close");
  } finally {
    firstClose.release();
  }

  expect(await outcomes).toMatchObject([
    {
      status: "rejected",
      reason: { _tag: "BrowserObservationError", reason: "target_not_found" },
    },
    { status: "rejected", reason: secondFailure },
  ]);
  expect(order).toEqual([
    "http://127.0.0.1:9222",
    "first transport closed",
    "http://[::1]:9222",
  ]);
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
    closeBrowser: async (disconnectAtBoundary) => {
      browserCloses++;
      await disconnectAtBoundary(async () => {
        if (browserDenied)
          throw new Error("controlled transport close failure");
      });
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

it("rechecks the browser release gate after finalization changes its revision", async () => {
  const eventFinalization = phaseGate();
  const releaseGate = phaseGate();
  const closeBrowser = vi.fn(
    async (
      disconnectAtBoundary: (disconnect: () => Promise<void>) => Promise<void>,
    ) => disconnectAtBoundary(async () => undefined),
  );
  const owner = new PlaywrightScenarioBrowserCleanupOwner({
    closeBrowser,
    removeProfile: undefined,
  });
  let revision = 0;
  const gateRuns: number[] = [];
  const release = owner.release(
    async () => {
      await eventFinalization.hold();
    },
    {
      get revision() {
        return revision;
      },
      async run() {
        gateRuns.push(revision);
        if (gateRuns.length === 1) await releaseGate.hold();
      },
    },
  );

  try {
    await eventFinalization.reached(release, "browser event finalization");
    eventFinalization.release();
    await releaseGate.reached(release, "browser release gate");
    revision += 1;
    releaseGate.release();
    await release;
  } finally {
    eventFinalization.release();
    releaseGate.release();
    await release.catch(() => undefined);
  }

  expect(gateRuns).toEqual([0, 1]);
  expect(closeBrowser).toHaveBeenCalledTimes(1);
  expect(owner.browserClosed).toBe(true);
});

it("runs the latest stop gate after attached restoration and before disconnect", async () => {
  const restoration = phaseGate();
  const gateRevisions: number[] = [];
  let revision = 0;
  let disconnected = false;
  const owner = new PlaywrightScenarioBrowserCleanupOwner({
    closeBrowser: async (disconnectAtBoundary) => {
      await restoration.hold();
      await disconnectAtBoundary(async () => {
        disconnected = true;
      });
    },
    removeProfile: undefined,
  });
  const release = owner.release(undefined, {
    get revision() {
      return revision;
    },
    async run() {
      gateRevisions.push(revision);
    },
  });

  try {
    await restoration.reached(release, "browser restoration");
    revision += 1;
    restoration.release();
    await release;
  } finally {
    restoration.release();
    await release.catch(() => undefined);
  }

  expect(gateRevisions).toEqual([1]);
  expect(disconnected).toBe(true);
  expect(owner.browserClosed).toBe(true);
});

it.each([false, true])(
  "retains a failed release gate when its revision changes: %s",
  async (changeRevision) => {
    let transportClosed = false;
    const closeBrowser = vi.fn(
      async (
        disconnectAtBoundary: (
          disconnect: () => Promise<void>,
        ) => Promise<void>,
      ) =>
        disconnectAtBoundary(async () => {
          transportClosed = true;
        }),
    );
    const owner = new PlaywrightScenarioBrowserCleanupOwner({
      closeBrowser,
      removeProfile: undefined,
    });
    const failure = new Error("navigation stop was not confirmed");
    const gateRun = phaseGate();
    let revision = 0;
    let failGate = true;
    const gate = {
      get revision() {
        return revision;
      },
      async run() {
        if (failGate) {
          failGate = false;
          await gateRun.hold();
          throw failure;
        }
      },
    };

    const release = owner.release(undefined, gate).then(
      () => ({ ok: true as const }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    try {
      await gateRun.reached(release, "browser release gate");
      if (changeRevision) revision += 1;
      gateRun.release();
      await expect(release).resolves.toEqual({ ok: false, cause: failure });
      expect(closeBrowser).toHaveBeenCalledTimes(1);
      expect(transportClosed).toBe(false);
      expect(owner.browserClosed).toBe(false);
      expect(owner.cleanupResources).toContain("browser_transport");

      await owner.release(undefined, gate);
      expect(closeBrowser).toHaveBeenCalledTimes(2);
      expect(transportClosed).toBe(true);
      expect(owner.browserClosed).toBe(true);
    } finally {
      gateRun.release();
      try {
        await release;
      } finally {
        await owner.close();
      }
    }
  },
);

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

const scenarioActions = [
  { step_id: "settle", action: "wait_for_timeout" as const, duration_ms: 1 },
];

it("applies command_timeout_ms to launch startup", async () => {
  let timeout: number | undefined;
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: process.execPath },
    start_url: { url: "https://example.test" },
    command_timeout_ms: 4_321,
    actions: scenarioActions,
  });
  await expect(
    openPlaywrightScenarioBrowser(
      scenario,
      {},
      {
        launcher: {
          connectOverCDP: async () => {
            throw new Error("Unexpected connection");
          },
          launchPersistentContext: async (_profile, options) => {
            timeout = options?.timeout;
            throw new Error("launch boundary reached");
          },
        },
      },
    ),
  ).rejects.toMatchObject({
    diagnostics: { startup_error: "launch boundary reached" },
  });
  expect(timeout).toBe(4_321);
});

it("uses the default command deadline for an omitted launch timeout", async () => {
  let timeout: number | undefined;
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: process.execPath },
    start_url: { url: "https://example.test" },
    actions: scenarioActions,
  });
  await expect(
    openPlaywrightScenarioBrowser(
      scenario,
      {},
      {
        launcher: {
          connectOverCDP: async () => {
            throw new Error("Unexpected connection");
          },
          launchPersistentContext: async (_profile, options) => {
            timeout = options?.timeout;
            throw new Error("launch boundary reached");
          },
        },
      },
    ),
  ).rejects.toMatchObject({
    diagnostics: { startup_error: "launch boundary reached" },
  });
  expect(timeout).toBe(DEFAULT_CDP_COMMAND_TIMEOUT_MS);
});

it("applies command_timeout_ms to the primary connect handshake when service workers are allowed", async () => {
  let timeout: number | undefined;
  const started = performance.now();
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "primary-handshake",
    },
    start_url: { url: "https://example.test" },
    environment: { service_workers: "allow" },
    command_timeout_ms: 50,
    actions: scenarioActions,
  });
  const opening = openPlaywrightScenarioBrowser(
    scenario,
    {},
    {
      launcher: {
        connectOverCDP: async (_endpoint, options) => {
          timeout = options?.timeout;
          return new Promise(() => undefined);
        },
        launchPersistentContext: async () => {
          throw new Error("Unexpected launch");
        },
      },
    },
  );
  const failure = await opening.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(failure).toMatchObject({
    reason: "timeout",
    userMessage: expect.stringContaining("50 ms command_timeout_ms"),
    remediationAction: expect.stringContaining("capture-browser-scenario JSON"),
    diagnostics: { phase: "handshake", command_timeout_ms: 50 },
  });
  expect(
    (failure as { remediationAction?: string }).remediationAction,
  ).not.toContain("--command-timeout-ms");
  expect(timeout).toBe(50);
  // The fake ignores Playwright's timeout; only REA's own 50 ms deadline can
  // stop the handshake before the default it would otherwise wait for.
  expect(performance.now() - started).toBeLessThan(
    DEFAULT_CDP_COMMAND_TIMEOUT_MS,
  );
});

it("applies command_timeout_ms to primary target lookup when service workers are allowed", async () => {
  const started = performance.now();
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "primary-target-info",
    },
    start_url: { url: "https://example.test" },
    environment: { service_workers: "allow" },
    command_timeout_ms: 50,
    actions: scenarioActions,
  });
  const browser = {
    close: async () => undefined,
    contexts: () => [
      {
        pages: () => [{} as Page],
        newCDPSession: async () =>
          ({
            send: () => new Promise(() => undefined),
            detach: async () => undefined,
          }) as unknown as CDPSession,
      } as unknown as BrowserContext,
    ],
    isConnected: () => true,
    version: () => "fixture",
  };
  await expect(
    openPlaywrightScenarioBrowser(
      scenario,
      {},
      {
        launcher: {
          connectOverCDP: async (_endpoint, options) => {
            expect(options?.timeout).toBe(50);
            return browser;
          },
          launchPersistentContext: async () => {
            throw new Error("Unexpected launch");
          },
        },
      },
    ),
  ).rejects.toMatchObject({
    reason: "timeout",
    userMessage: expect.stringContaining("Target.getTargetInfo"),
  });
  // A lookup bounded by the default instead of command_timeout_ms ends later.
  expect(performance.now() - started).toBeLessThan(
    DEFAULT_CDP_COMMAND_TIMEOUT_MS,
  );
});

it("closes a context that launches after its deadline before removing the profile", async () => {
  const order: string[] = [];
  let profilePath = "";
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: process.execPath },
    start_url: { url: "https://example.test" },
    command_timeout_ms: 40,
    actions: scenarioActions,
  });
  const failure = await openPlaywrightScenarioBrowser(
    scenario,
    {},
    {
      launcher: {
        connectOverCDP: async () => {
          throw new Error("Unexpected connection");
        },
        launchPersistentContext: async (profile) => {
          profilePath = profile;
          await new Promise((resolve) => setTimeout(resolve, 80));
          order.push("launched");
          return {
            close: async () => {
              order.push("close");
            },
          } as unknown as BrowserContext;
        },
      },
    },
  ).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(failure).toMatchObject({
    reason: "timeout",
    userMessage: expect.stringContaining(
      "Browser launch and persistent-context startup",
    ),
    diagnostics: { phase: "launch", command_timeout_ms: 40 },
  });
  expect(
    (failure as { remediationAction?: string }).remediationAction,
  ).not.toContain("--command-timeout-ms");
  expect(order).toEqual(["launched", "close"]);
  await expect(access(profilePath)).rejects.toThrow();
});

it("closes a browser that connects after its deadline without waiting to report the timeout", async () => {
  vi.useFakeTimers();
  const handshake = phaseGate();
  const closed = vi.fn(async () => undefined);
  const leases: AnalysisCleanupLease[] = [];
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "late-connect-target",
    },
    start_url: { url: "https://example.test" },
    environment: { service_workers: "allow" },
    command_timeout_ms: 40,
    actions: scenarioActions,
  });
  let settled = false;
  const opening = openPlaywrightScenarioBrowser(
    scenario,
    {},
    {
      retainCleanup: (lease) => leases.push(lease),
      launcher: {
        connectOverCDP: async () => {
          await handshake.hold();
          return {
            close: closed,
            contexts: () => [],
            isConnected: () => true,
            version: () => "late-connect",
          };
        },
        launchPersistentContext: async () => {
          throw new Error("Unexpected launch");
        },
      },
    },
  )
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    await handshake.reached(opening, "late CDP handshake");
    await vi.advanceTimersByTimeAsync(40);
    expect(settled).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    expect(await opening).toMatchObject({ reason: "timeout" });
    expect(leases).toHaveLength(1);
    expect(leases[0]?.released).toBe(false);
    handshake.release();
    await leases[0]!.release();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(leases[0]?.released).toBe(true);
  } finally {
    handshake.release();
    try {
      await opening;
      await Promise.all(leases.map((lease) => lease.release()));
    } finally {
      vi.useRealTimers();
    }
  }
});

it.each(["media", "focus"] as const)(
  "restores a late %s mutation after its deadline",
  async (mutation) => {
    let restored = false;
    const scenario = browserScenarioSchema.parse({
      browser: {
        mode: "connect",
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "late-environment-target",
      },
      start_url: { url: "https://example.test" },
      environment: { service_workers: "allow" },
      command_timeout_ms: 40,
      actions: scenarioActions,
    });
    const discoverySession = {
      send: vi.fn(async () => ({
        targetInfo: { targetId: "late-environment-target" },
      })),
      detach: vi.fn(async () => undefined),
    } as unknown as CDPSession;
    const environmentSession = {
      send: vi.fn(
        async (method: string, parameters?: { enabled?: boolean }) => {
          if (method !== "Emulation.setFocusEmulationEnabled") return {};
          if (parameters?.enabled === false) {
            if (mutation === "focus") restored = true;
          } else if (mutation === "focus")
            await new Promise((resolve) => setTimeout(resolve, 80));
          return {};
        },
      ),
      detach: vi.fn(async () => undefined),
    } as unknown as CDPSession;
    const page = {
      emulateMedia: vi.fn(async (options: { colorScheme?: string | null }) => {
        if (options.colorScheme === null) {
          if (mutation === "media") restored = true;
          return;
        }
        if (mutation === "media")
          await new Promise((resolve) => setTimeout(resolve, 80));
      }),
      isClosed: vi.fn(() => false),
    } as unknown as Page;
    const context = {
      pages: () => [page],
      newCDPSession: vi
        .fn()
        .mockResolvedValueOnce(discoverySession)
        .mockResolvedValueOnce(environmentSession),
    } as unknown as BrowserContext;
    const browser = {
      close: vi.fn(async () => undefined),
      contexts: () => [context],
      isConnected: vi.fn(() => true),
      version: () => "late-environment",
    };
    await expect(
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
        },
      ),
    ).rejects.toMatchObject({
      reason: "timeout",
      userMessage: expect.stringContaining(
        mutation === "media"
          ? "Emulation.setEmulatedMedia"
          : "Emulation.setFocusEmulationEnabled",
      ),
    });
    expect(restored).toBe(true);
    if (mutation === "media")
      expect(environmentSession.send).not.toHaveBeenCalledWith(
        "Emulation.clearDeviceMetricsOverride",
        undefined,
      );
    else
      expect(environmentSession.send).toHaveBeenCalledWith(
        "Emulation.clearDeviceMetricsOverride",
        undefined,
      );
    expect(browser.close).toHaveBeenCalledOnce();
  },
);

it.each([
  new Error("Timeout unrelated launch diagnostic"),
  Object.assign(new Error("unrelated launch failure"), {
    name: "TimeoutError",
  }),
])(
  "preserves a launch failure without inferring a Playwright deadline: %s",
  async (failure) => {
    const scenario = browserScenarioSchema.parse({
      browser: {
        mode: "launch",
        executable_path: process.execPath,
        headless: true,
      },
      start_url: { url: "https://example.test" },
      command_timeout_ms: 4_321,
      actions: scenarioActions,
    });
    let profilePath: string | undefined;
    await expect(
      openPlaywrightScenarioBrowser(
        scenario,
        {},
        {
          launcher: {
            connectOverCDP: async () => {
              throw new Error("Unexpected connection");
            },
            launchPersistentContext: async (profile) => {
              profilePath = profile;
              throw failure;
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      _tag: "ProviderAdapterError",
      cause: failure,
      diagnostics: {
        executable_path: process.execPath,
        startup_error: failure.message,
      },
    });
    expect(profilePath).toBeDefined();
    await expect(access(profilePath!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("normalizes a genuine Playwright launch timeout and releases its profile", async () => {
  const { errors } = await import("playwright-core");
  const failure = new errors.TimeoutError("native launch deadline");
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "launch",
      executable_path: process.execPath,
      headless: true,
    },
    start_url: { url: "https://example.test" },
    command_timeout_ms: 4_321,
    actions: scenarioActions,
  });
  let profilePath: string | undefined;
  await expect(
    openPlaywrightScenarioBrowser(
      scenario,
      {},
      {
        launcher: {
          connectOverCDP: async () => {
            throw new Error("Unexpected connection");
          },
          launchPersistentContext: async (profile) => {
            profilePath = profile;
            throw failure;
          },
        },
      },
    ),
  ).rejects.toMatchObject({
    reason: "timeout",
    userMessage: expect.stringContaining("4321 ms command_timeout_ms"),
    cause: failure,
    diagnostics: {
      phase: "launch",
      command_timeout_ms: 4_321,
      executable_path: process.execPath,
      producer_message: "native launch deadline",
    },
  });
  expect(profilePath).toBeDefined();
  await expect(access(profilePath!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps discovered transport credentials out of projected handshake timeouts", async () => {
  const { errors } = await import("playwright-core");
  // A credential-free HTTP endpoint may discover an authenticated WebSocket.
  // Native Playwright timeout logs include the discovered transport spelling.
  const native = new errors.TimeoutError(
    "WebSocket timeout: ws://fixture-user:fixture-password@127.0.0.1:9222/devtools/browser/discovered",
  );
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "discovered-timeout",
    },
    start_url: { url: "https://example.test" },
    environment: { service_workers: "allow" },
    command_timeout_ms: 50,
    actions: scenarioActions,
  });
  const failure = await openPlaywrightScenarioBrowser(
    scenario,
    {},
    {
      launcher: {
        connectOverCDP: async () => {
          throw native;
        },
        launchPersistentContext: async () => {
          throw new Error("Unexpected launch");
        },
      },
    },
  ).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(failure).toMatchObject({
    reason: "timeout",
    cause: native,
    diagnostics: { phase: "handshake", command_timeout_ms: 50 },
  });
  if (!(failure instanceof AnalysisError))
    throw new Error("Expected typed timeout");
  expect(failure.diagnostics).not.toHaveProperty("producer_message");
  const projected = JSON.stringify(projectAnalysisError(failure));
  expect(projected).not.toContain("fixture-user");
  expect(projected).not.toContain("fixture-password");
});
