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

const launchScenario = browserScenarioSchema.parse({
  browser: { mode: "launch", executable_path: process.execPath },
  start_url: { url: "https://example.test" },
  actions: [{ step_id: "settle", action: "wait_for_timeout", duration_ms: 1 }],
});

const rejectedLaunch = async (
  scenario = launchScenario,
  {
    environment = {},
    platform,
    cause = new Error("launch boundary reached"),
  }: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly platform?: NodeJS.Platform;
    readonly cause?: Error;
  } = {},
) => {
  const launchPersistentContext = vi
    .fn<typeof import("playwright-core").chromium.launchPersistentContext>()
    .mockRejectedValue(cause);
  const result = await openPlaywrightScenarioBrowser(scenario, environment, {
    launcher: {
      launchPersistentContext,
      connectOverCDP: async () => {
        throw new Error("Unexpected connection");
      },
    },
    ...(platform === undefined ? {} : { platform }),
  }).then(
    (opened) => ({ opened }),
    (failure: unknown) => ({ failure }),
  );
  if ("opened" in result) {
    await result.opened.cleanup.close();
    throw new Error("Expected browser startup failure");
  }
  expect(launchPersistentContext).toHaveBeenCalledOnce();
  const [profile, options] = launchPersistentContext.mock.calls[0]!;
  return { failure: result.failure, profile, options };
};

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
    const { failure, options } = await rejectedLaunch(launchScenario, {
      environment: selected,
      platform,
    });
    expect(failure).toMatchObject({
      diagnostics: { startup_error: "launch boundary reached" },
    });
    expect(options?.env).toEqual({
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
      const { options } = await rejectedLaunch(
        browserScenarioSchema.parse({
          ...launchScenario,
          browser: { mode: "launch", executable_path: selected },
        }),
      );
      expect(options?.executablePath).toBe(`${root}/link/../browser`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("keeps Termux execution support when launching Chromium on Android", async () => {
  vi.stubEnv("PREFIX", "/ambient/termux");
  const { options } = await rejectedLaunch(launchScenario, {
    platform: "android",
    environment: {
      LANG: "selected-language",
      PREFIX: "/data/data/com.termux/files/usr",
    },
  });
  expect(options?.chromiumSandbox).toBe(false);
  expect(options?.args).toEqual(["--single-process"]);
  expect(options?.env).toEqual({
    LANG: "selected-language",
    LD_PRELOAD: "/data/data/com.termux/files/usr/lib/libtermux-exec.so",
    TERMUX_EXEC__PROC_SELF_EXE: process.execPath,
  });
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
    const { failure, options } = await rejectedLaunch(launchScenario, {
      platform: "linux",
      environment,
    });
    expect(failure).toMatchObject({
      diagnostics: { startup_error: "launch boundary reached" },
      // Chromium's startup log, not REA, says whether the sandbox caused it.
      remediationAction: sandbox
        ? expect.stringContaining("REA_BROWSER_NO_SANDBOX=true")
        : "Review the selected executable and startup diagnostics, then correct the launch configuration before retrying.",
    });
    expect(options?.chromiumSandbox).toBe(sandbox);
    expect(options?.args).toEqual([]);
    expect(options?.env).toEqual({});
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

it.each(["handshake", "target discovery"] as const)(
  "closes the attached browser on cancellation during $0",
  async (stage) => {
    const caller = new AbortController();
    const reason = new Error(`cancel during ${stage}`);
    const handshake = phaseGate();
    const browser = {
      close: vi.fn(async () => undefined),
      contexts: vi.fn(() => {
        caller.abort(reason);
        return [];
      }),
      isConnected: () => true,
      version: () => "fixture",
    };
    const scenario = browserScenarioSchema.parse({
      browser: {
        mode: "connect",
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "page-1",
      },
      start_url: { url: "https://example.test" },
      actions: scenarioActions,
    });
    const opening = openPlaywrightScenarioBrowser(
      scenario,
      {},
      {
        signal: caller.signal,
        launcher: {
          connectOverCDP: async () => {
            if (stage === "handshake") await handshake.hold();
            return browser;
          },
          launchPersistentContext: async () => {
            throw new Error("Unexpected launch");
          },
        },
      },
    );
    try {
      if (stage === "handshake") {
        await handshake.reached(opening, "browser handshake");
        caller.abort(reason);
        handshake.release();
      }
      await expect(opening).rejects.toMatchObject(
        stage === "handshake"
          ? {
              _tag: "BrowserObservationError",
              reason: "cancelled",
              cause: reason,
            }
          : { _tag: "AnalysisCancelledError", cause: reason },
      );
      expect(browser.contexts).toHaveBeenCalledTimes(
        stage === "handshake" ? 0 : 1,
      );
      expect(browser.close).toHaveBeenCalledOnce();
    } finally {
      caller.abort(reason);
      handshake.release();
      const opened = await opening.catch(() => undefined);
      await opened?.cleanup.close();
    }
  },
);

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
  commandTimeoutMs?: number,
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
    ...(commandTimeoutMs === undefined
      ? {}
      : { command_timeout_ms: commandTimeoutMs }),
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

it.each(["rejected", "malformed acknowledgement"] as const)(
  "restores only acquired overrides when locale application returns %s",
  async (outcome) => {
    const localeFailure = new Error("caller already owns locale");
    const fixture = attachedBrowserFixture({
      send: async (method, parameters) => {
        if (
          method !== "Emulation.setLocaleOverride" ||
          (parameters as { locale?: string }).locale !== "en-US"
        )
          return;
        if (outcome === "rejected") throw localeFailure;
        return "applied";
      },
    });
    const result = await fixture.open().then(
      (opened) => ({ opened }),
      (failure: unknown) => ({ failure }),
    );
    if ("opened" in result) {
      await result.opened.cleanup.close();
      throw new Error("Expected locale acquisition failure");
    }
    const { failure } = result;
    if (outcome === "rejected") expect(failure).toBe(localeFailure);
    else expect(failure).toMatchObject({ reason: "protocol_error" });
    expect(
      vi.mocked(fixture.environmentSession.send).mock.calls.slice(2),
    ).toEqual(
      outcome === "rejected"
        ? [["Emulation.clearDeviceMetricsOverride", undefined]]
        : [
            ["Emulation.setLocaleOverride", { locale: "" }],
            ["Emulation.clearDeviceMetricsOverride", undefined],
          ],
    );
    expect(fixture.environmentSession.detach).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  },
);

it.each([
  {
    mutation: "locale",
    method: "Emulation.setLocaleOverride",
    stop: "cancellation",
  },
  { mutation: "media", method: "Emulation.setEmulatedMedia", stop: "deadline" },
  {
    mutation: "focus",
    method: "Emulation.setFocusEmulationEnabled",
    stop: "deadline",
  },
] as const)(
  "joins a pending $mutation acknowledgement after $stop before restoring it",
  async ({ mutation, method, stop }) => {
    const pending = phaseGate();
    const progress: string[] = [];
    const restoreOrHold = async (reset: boolean) => {
      if (reset) progress.push("restored");
      else {
        await pending.hold();
        progress.push("acknowledged");
      }
    };
    const fixture = attachedBrowserFixture(
      {
        send: async (command, parameters) => {
          if (command !== method) return;
          const options = parameters as { locale?: string; enabled?: boolean };
          await restoreOrHold(
            options.locale === "" || options.enabled === false,
          );
        },
        emulateMedia: async (options) => {
          if (mutation === "media")
            await restoreOrHold(options?.colorScheme === null);
        },
        detach: async () => {
          progress.push("detached");
        },
        closeBrowser: async () => {
          progress.push("disconnected");
        },
      },
      40,
    );
    vi.useFakeTimers();
    const caller = new AbortController();
    const reason = new Error("cancel while applying locale");
    const observed = vi.fn();
    const opening = fixture.open(caller.signal);
    void opening.then(observed, observed);
    try {
      await pending.reached(opening, method);
      if (stop === "cancellation") caller.abort(reason);
      await vi.advanceTimersByTimeAsync(stop === "deadline" ? 40 : 0);
      expect(observed).not.toHaveBeenCalled();
      expect(progress).toEqual([]);

      pending.release();
      const failure = await opening.catch((cause: unknown) => cause);
      if (stop === "deadline")
        expect(failure).toMatchObject({
          reason: "timeout",
          diagnostics: { phase: "command", command_timeout_ms: 40, method },
        });
      else {
        expect(failure).toBeInstanceOf(AnalysisCancelledError);
        expect(failure).toHaveProperty("cause", reason);
      }
      expect(progress).toEqual([
        "acknowledged",
        "restored",
        "detached",
        "disconnected",
      ]);
      const commands = vi
        .mocked(fixture.environmentSession.send)
        .mock.calls.map(([name]) => name);
      expect(
        commands.filter(
          (name) => name === "Emulation.clearDeviceMetricsOverride",
        ),
      ).toHaveLength(mutation === "media" ? 0 : 1);
      if (mutation === "locale")
        expect(commands).not.toContain("Emulation.setTimezoneOverride");
    } finally {
      caller.abort(reason);
      pending.release();
      try {
        const opened = await opening.catch(() => undefined);
        await opened?.cleanup.close();
      } finally {
        vi.useRealTimers();
      }
    }
  },
);

it.each(["target destroyed", "browser disconnected"] as const)(
  "releases attached ownership once the %s",
  async (loss) => {
    let lost = false;
    const fixture = attachedBrowserFixture({
      send: async (method, parameters) => {
        if (
          lost &&
          method === "Emulation.setTimezoneOverride" &&
          (parameters as { timezoneId?: string }).timezoneId === ""
        )
          throw new Error(loss);
      },
      isTargetClosed: () => lost && loss === "target destroyed",
      isBrowserConnected: () => !lost || loss !== "browser disconnected",
    });
    const opened = await fixture.open();
    try {
      lost = true;
      await opened.cleanup.close();
      expect(opened.cleanup.cleanupResources).toEqual([]);
      expect(fixture.browser.close).toHaveBeenCalledTimes(
        loss === "target destroyed" ? 1 : 0,
      );
    } finally {
      lost = false;
      await opened.cleanup.close();
    }
  },
);

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
  const firstRefusal = new Error("first connection failed");
  try {
    await firstConnection.reached(first, "first CDP connection");
    expect(connectOverCDP).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
    const queued = openPlaywrightScenarioBrowser(
      makeScenario("page-1"),
      environment,
      { launcher, signal: controller.signal },
    );
    const reason = new Error("cancel queued attach");
    controller.abort(reason);
    await expect(queued).rejects.toMatchObject({
      _tag: "BrowserObservationError",
      reason: "cancelled",
      cause: reason,
    });
    expect(connectOverCDP).toHaveBeenCalledTimes(1);
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));

    await expect(
      openPlaywrightScenarioBrowser(makeScenario("page-2"), environment, {
        launcher,
      }),
    ).rejects.toThrow("connection failed");
    expect(connectOverCDP).toHaveBeenCalledTimes(2);

    await expect(
      openPlaywrightScenarioBrowser(launchScenario, environment, { launcher }),
    ).rejects.toMatchObject({
      diagnostics: { startup_error: "launch boundary reached" },
    });
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);

    firstConnection.reject(firstRefusal);
    await expect(first).rejects.toThrow("first connection failed");
    await expect(
      openPlaywrightScenarioBrowser(makeScenario("page-1"), environment, {
        launcher,
      }),
    ).rejects.toThrow("connection failed");
    expect(connectOverCDP).toHaveBeenCalledTimes(3);
  } finally {
    firstConnection.reject(firstRefusal);
    await first.catch(() => undefined);
  }
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
  let settled: Awaited<typeof outcomes>;
  try {
    await firstClose.reached(first, "first transport close");
  } finally {
    firstClose.release();
    settled = await outcomes;
  }

  expect(settled).toMatchObject([
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
  const finishEvents = vi.fn(async () => undefined);
  const settlements: boolean[] = [];
  const owner = new PlaywrightScenarioBrowserCleanupOwner({
    closeBrowser: async (disconnectAtBoundary) => {
      browserCloses++;
      await disconnectAtBoundary(async () => {
        if (browserDenied)
          throw new Error("controlled transport close failure");
      });
    },
    onSettled: (closed) => settlements.push(closed),
    removeProfile: async () => {
      if (profileDenied) throw new Error("controlled profile removal failure");
      await rm(profile, { recursive: true });
    },
  });
  try {
    const initial = await Promise.allSettled([
      owner.close(finishEvents),
      owner.close(finishEvents),
    ]);
    const firstFailures = initial.map((result) => {
      if (result.status !== "rejected")
        throw new Error("Expected transport refusal");
      const failure: unknown = result.reason;
      expect(failure).toMatchObject({
        reason: "cleanup_failed",
        cleanupIncomplete: true,
        cleanupResources: ["browser_transport", "browser_profile"],
      });
      return failure;
    });
    expect(settlements).toEqual([false]);
    browserDenied = false;
    const second: unknown = await owner
      .close()
      .catch((cause: unknown) => cause);
    expect(owner.browserClosed).toBe(true);
    for (const error of [...firstFailures, second])
      expect(error).toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: ["browser_profile"],
      });
    await access(profile);
    profileDenied = false;
    await owner.close();
    await expect(access(profile)).rejects.toMatchObject({ code: "ENOENT" });
    for (const error of [...firstFailures, second])
      expect(error).toMatchObject({
        cleanupIncomplete: false,
        cleanupResources: [],
      });
    await owner.close(finishEvents);
    expect(browserCloses).toBe(2);
    expect(finishEvents).toHaveBeenCalledOnce();
    expect(settlements).toEqual([false, true, true]);
  } finally {
    browserDenied = false;
    profileDenied = false;
    await owner.close();
  }
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
  const late = phaseGate();
  const lease = new AnalysisCleanupLease(
    () => late.hold(),
    ["browser_profile"],
  );
  const primary = new AnalysisCancelledError("capture_browser_scenario", {
    cause: new Error("cancelled opening"),
  });
  const settled = vi.fn<(cause: unknown) => void>();
  const opening = failBrowserScenarioOperation(lease, primary).catch(settled);
  try {
    await late.reached(opening, "opening failure cleanup");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledOnce();
    const failure = settled.mock.calls[0]![0];
    if (!(failure instanceof AnalysisError))
      throw new Error("Expected typed cleanup failure");
    expect(failure.cleanupPrimary).toBe(primary);
    expect(failure).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["browser_profile"],
    });
    expect(lease.released).toBe(false);
    late.release();
    await lease.release();
    expect(failure).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
    expect(projectAnalysisError(failure).code).toBe("cancelled");
  } finally {
    late.release();
    try {
      await opening;
      await lease.release();
    } finally {
      vi.useRealTimers();
    }
  }
});

const scenarioActions = [
  { step_id: "settle", action: "wait_for_timeout" as const, duration_ms: 1 },
];

it.each([
  { selected: undefined, effective: DEFAULT_CDP_COMMAND_TIMEOUT_MS },
  { selected: 4_321, effective: 4_321 },
])(
  "passes the effective $effective ms command deadline to startup (selected: $selected)",
  async ({ selected, effective }) => {
    const { options } = await rejectedLaunch({
      ...launchScenario,
      ...(selected === undefined ? {} : { command_timeout_ms: selected }),
    });
    expect(options?.timeout).toBe(effective);
  },
);

it("applies command_timeout_ms to primary target lookup when service workers are allowed", async () => {
  const lookup = phaseGate();
  const detach = vi.fn(async () => undefined);
  const targetId = "primary-target-info";
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: targetId,
    },
    start_url: { url: "https://example.test" },
    environment: { service_workers: "allow" },
    command_timeout_ms: 50,
    actions: scenarioActions,
  });
  const browser = {
    close: vi.fn(async () => undefined),
    contexts: () => [
      {
        pages: () => [{} as Page],
        newCDPSession: async () =>
          ({
            send: async () => {
              await lookup.hold();
              return { targetInfo: { targetId } };
            },
            detach,
          }) as unknown as CDPSession,
      } as unknown as BrowserContext,
    ],
    isConnected: () => true,
    version: () => "fixture",
  };
  const connectOverCDP = vi.fn(async () => browser);
  vi.useFakeTimers();
  const opening = openPlaywrightScenarioBrowser(
    scenario,
    {},
    {
      launcher: {
        connectOverCDP,
        launchPersistentContext: async () => {
          throw new Error("Unexpected launch");
        },
      },
    },
  );
  const settled = vi.fn();
  void opening.then(settled, settled);
  try {
    await lookup.reached(opening, "target lookup");
    expect(connectOverCDP).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:9222",
      { timeout: 50, noDefaults: true },
    );
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        reason: "timeout",
        userMessage: expect.stringContaining("Target.getTargetInfo"),
        diagnostics: {
          phase: "command",
          command_timeout_ms: 50,
          method: "Target.getTargetInfo",
        },
      }),
    );
    expect(detach).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  } finally {
    lookup.release();
    try {
      const opened = await opening.catch(() => undefined);
      await opened?.cleanup.close();
    } finally {
      vi.useRealTimers();
    }
  }
});

it("closes a context that launches after its deadline before removing the profile", async () => {
  const launch = phaseGate<string, BrowserContext>();
  const close = phaseGate();
  const scenario = { ...launchScenario, command_timeout_ms: 40 };
  vi.useFakeTimers();
  const opening = openPlaywrightScenarioBrowser(
    scenario,
    {},
    {
      launcher: {
        launchPersistentContext: (profile) => launch.hold(profile),
        connectOverCDP: async () => {
          throw new Error("Unexpected connection");
        },
      },
    },
  );
  const lateContext = {
    close: () => close.hold(),
  } as unknown as BrowserContext;
  try {
    const profile = await launch.reached(opening, "browser startup");
    await vi.advanceTimersByTimeAsync(40);
    launch.release(lateContext);
    await close.reached(opening, "late browser context release");
    await expect(access(profile)).resolves.toBeUndefined();
    close.release();
    const failure = await opening.catch((cause: unknown) => cause);
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
    await expect(access(profile)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    launch.release(lateContext);
    close.release();
    try {
      const opened = await opening.catch(() => undefined);
      await opened?.cleanup.close();
    } finally {
      vi.useRealTimers();
    }
  }
});

it("closes a browser that connects after its deadline without waiting to report the timeout", async () => {
  vi.useFakeTimers();
  const handshake = phaseGate();
  const browser = {
    close: vi.fn(async () => undefined),
    contexts: vi.fn(() => []),
    isConnected: () => true,
    version: () => "late-connect",
  };
  const connectOverCDP = vi.fn(async () => {
    await handshake.hold();
    return browser;
  });
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
        connectOverCDP,
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
    expect(connectOverCDP).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:9222",
      { timeout: 40, noDefaults: true },
    );
    await vi.advanceTimersByTimeAsync(39);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(browser.close).not.toHaveBeenCalled();
    const failure = await opening;
    expect(failure).toMatchObject({
      reason: "timeout",
      userMessage: expect.stringContaining("40 ms command_timeout_ms"),
      remediationAction: expect.stringContaining(
        "capture-browser-scenario JSON",
      ),
      diagnostics: { phase: "handshake", command_timeout_ms: 40 },
    });
    expect(
      (failure as { remediationAction?: string }).remediationAction,
    ).not.toContain("--command-timeout-ms");
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      released: false,
      cleanupResources: ["browser_transport"],
    });
    handshake.release();
    await leases[0]!.release();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(browser.contexts).not.toHaveBeenCalled();
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

it.each([
  new Error("Timeout unrelated launch diagnostic"),
  Object.assign(new Error("unrelated launch failure"), {
    name: "TimeoutError",
  }),
])(
  "preserves a launch failure without inferring a Playwright deadline: %s",
  async (cause) => {
    const { failure, profile } = await rejectedLaunch(launchScenario, {
      cause,
    });
    expect(failure).toMatchObject({
      _tag: "ProviderAdapterError",
      diagnostics: {
        executable_path: process.execPath,
        startup_error: cause.message,
      },
    });
    expect(failure).toHaveProperty("cause", cause);
    await expect(access(profile)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("normalizes a genuine Playwright launch timeout and releases its profile", async () => {
  const { errors } = await import("playwright-core");
  const cause = new errors.TimeoutError("native launch deadline");
  const { failure, profile } = await rejectedLaunch(
    { ...launchScenario, command_timeout_ms: 4_321 },
    { cause },
  );
  expect(failure).toMatchObject({
    reason: "timeout",
    userMessage: expect.stringContaining("4321 ms command_timeout_ms"),
    cause,
    diagnostics: {
      phase: "launch",
      command_timeout_ms: 4_321,
      executable_path: process.execPath,
      producer_message: "native launch deadline",
    },
  });
  await expect(access(profile)).rejects.toMatchObject({ code: "ENOENT" });
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
