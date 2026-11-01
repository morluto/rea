import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  mkdir,
  writeFile,
  rm,
  access,
  readdir,
  realpath,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
} from "playwright-core";

import { DEFAULT_CDP_COMMAND_TIMEOUT_MS } from "../domain/browserDeadline.js";
import { browserScenarioSchema } from "../domain/browserScenario.js";
import { PLAYWRIGHT_CLEANUP_CONFIRMATION_TIMEOUT_MS } from "./PlaywrightExecutionBoundary.js";
import {
  absoluteCallerPath,
  appendCallerPath,
} from "../filesystem/callerPath.js";
import {
  attachedScenarioLeaseKey,
  failBrowserScenarioOperation,
  openPlaywrightScenarioBrowser,
  PlaywrightScenarioBrowserCleanupOwner,
} from "./PlaywrightScenarioBrowser.js";

const hostPlatform = process.platform;

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
  ).rejects.toMatchObject({
    diagnostics: { startup_error: "launch boundary reached" },
  });
  expect(launchedEnvironment).toEqual({
    LANG: "selected-language",
    PATH: "/selected/bin",
  });
});

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
  const prefix = await createTestTempDirectory("rea-termux-exec-");
  Object.defineProperty(process, "platform", { value: "android" });
  const selected = { LANG: "selected-language", PREFIX: prefix };
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
  ).rejects.toMatchObject({
    diagnostics: { startup_error: "launch boundary reached" },
  });

  expect(launchOptions?.args).toEqual([
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--single-process",
  ]);
  expect(launchOptions?.env).toEqual({
    LANG: "selected-language",
    LD_PRELOAD: `${prefix}/lib/libtermux-exec.so`,
    TERMUX_EXEC__PROC_SELF_EXE: process.execPath,
    TMPDIR: appendCallerPath(prefix, "tmp"),
  });
});

const androidLaunchScenario = (executablePath: string) =>
  browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: executablePath },
    start_url: { url: "https://example.test" },
    actions: [
      { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
    ],
  });

const captureAndroidLaunch = async (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  Object.defineProperty(process, "platform", { value: "android" });
  let launchedProfile: string | undefined;
  let launchOptions: Parameters<
    typeof import("playwright-core").chromium.launchPersistentContext
  >[1];
  await expect(
    openPlaywrightScenarioBrowser(
      androidLaunchScenario(process.execPath),
      environment,
      {
        launcher: {
          connectOverCDP: async () => {
            throw new Error("Unexpected connection");
          },
          launchPersistentContext: async (profile, options) => {
            launchedProfile = profile;
            launchOptions = options;
            throw new Error("launch boundary reached");
          },
        },
      },
    ),
  ).rejects.toMatchObject({
    diagnostics: { startup_error: "launch boundary reached" },
  });
  return { launchedProfile, launchOptions };
};

it.each([
  {
    name: "uses the Termux prefix when no temp directory is selected",
    variables: {},
    parent: "prefix" as const,
    forwarded: { TMPDIR: "prefix" as const },
  },
  {
    name: "keeps a caller-selected TMPDIR",
    variables: { TMPDIR: "explicit" as const },
    parent: "explicit" as const,
    forwarded: { TMPDIR: "explicit" as const },
  },
  {
    name: "uses TMP when TMPDIR is absent",
    variables: { TMP: "explicit" as const },
    parent: "explicit" as const,
    forwarded: { TMP: "explicit" as const, TMPDIR: "explicit" as const },
  },
  {
    name: "uses TEMP when TMPDIR and TMP are absent",
    variables: { TEMP: "explicit" as const },
    parent: "explicit" as const,
    forwarded: { TEMP: "explicit" as const, TMPDIR: "explicit" as const },
  },
  {
    name: "prefers TMPDIR over TMP and TEMP",
    variables: {
      TMPDIR: "explicit" as const,
      TMP: "other" as const,
      TEMP: "other" as const,
    },
    parent: "explicit" as const,
    forwarded: {
      TMPDIR: "explicit" as const,
      TMP: "other" as const,
      TEMP: "other" as const,
    },
  },
  {
    name: "treats an empty TMPDIR as unset and uses TMP",
    variables: { TMPDIR: "" as const, TMP: "explicit" as const },
    parent: "explicit" as const,
    forwarded: { TMPDIR: "explicit" as const, TMP: "explicit" as const },
  },
  {
    name: "treats empty temp variables as unset and uses the Termux prefix",
    variables: { TMPDIR: "" as const, TMP: "" as const, TEMP: "" as const },
    parent: "prefix" as const,
    forwarded: {
      TMPDIR: "prefix" as const,
      TMP: "" as const,
      TEMP: "" as const,
    },
  },
])(
  "keeps Termux Chromium on a writable temp directory: $name",
  async ({ variables, parent, forwarded }) => {
    const root = await createTestTempDirectory("rea-termux-temp-");
    const prefix = join(root, "usr");
    const paths = {
      explicit: join(root, "explicit-tmp"),
      other: join(root, "other-tmp"),
      prefix: appendCallerPath(prefix, "tmp", "android"),
    };
    const resolvePath = (
      token: "" | "explicit" | "other" | "prefix",
    ): string => (token === "" ? "" : paths[token]);
    const selected = {
      LANG: "selected-language",
      PREFIX: prefix,
      ...Object.fromEntries(
        Object.entries(variables).map(([name, token]) => [
          name,
          resolvePath(token),
        ]),
      ),
    };
    const { launchedProfile, launchOptions } =
      await captureAndroidLaunch(selected);
    expect(launchedProfile?.startsWith(paths[parent])).toBe(true);
    expect(launchOptions?.args).toEqual([
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
    ]);
    expect(launchOptions?.env).toEqual({
      LANG: "selected-language",
      LD_PRELOAD: `${prefix}/lib/libtermux-exec.so`,
      TERMUX_EXEC__PROC_SELF_EXE: process.execPath,
      ...Object.fromEntries(
        Object.entries(forwarded).map(([name, token]) => [
          name,
          resolvePath(token),
        ]),
      ),
    });
  },
);

it.skipIf(process.platform === "win32")(
  "keeps the Termux prefix temp through a symlink parent",
  async () => {
    const root = await createTestTempDirectory("rea-termux-prefix-link-");
    const physicalPrefix = join(root, "termux", "usr");
    const decoyTemp = join(root, "work", "tmp");
    await mkdir(join(physicalPrefix, "inner"), { recursive: true });
    await mkdir(decoyTemp, { recursive: true });
    await symlink(join(physicalPrefix, "inner"), join(root, "work", "link"));
    const prefix = `${root}/work/link/..`;
    const selectedTemp = appendCallerPath(prefix, "tmp", "android");
    const { launchedProfile, launchOptions } = await captureAndroidLaunch({
      PREFIX: prefix,
      TMPDIR: "",
      TMP: "",
      TEMP: "",
    });
    expect(join(prefix, "tmp")).toBe(decoyTemp);
    expect(selectedTemp).toBe(`${root}/work/link/../tmp`);
    expect(launchedProfile?.startsWith(selectedTemp)).toBe(true);
    expect(launchedProfile?.startsWith(decoyTemp)).toBe(false);
    expect(launchOptions?.env?.TMPDIR).toBe(selectedTemp);
    expect(await realpath(dirname(launchedProfile!))).toBe(
      await realpath(join(physicalPrefix, "tmp")),
    );
    expect(
      (await readdir(decoyTemp)).some((name) =>
        name.startsWith("rea-browser-scenario-"),
      ),
    ).toBe(false);
  },
);

it("does not let a stuck Android launch block later launches", async () => {
  const firstRoot = await createTestTempDirectory("rea-termux-stuck-a-");
  const secondRoot = await createTestTempDirectory("rea-termux-stuck-b-");
  vi.stubEnv("TMPDIR", "");
  vi.stubEnv("TMP", "");
  vi.stubEnv("TEMP", "");
  Object.defineProperty(process, "platform", { value: "android" });
  const nodeOs = createRequire(import.meta.url)("node:os") as {
    tmpdir: () => string;
  };
  const firstEntered = deferred<void>();
  const releaseFirst = deferred<void>();
  let firstLookup: string | undefined;
  let firstLookupAfterWait: string | undefined;
  let secondLookup: string | undefined;
  const opening = (root: string, onLaunch: () => Promise<void>) =>
    openPlaywrightScenarioBrowser(
      androidLaunchScenario(process.execPath),
      { PREFIX: root, TMPDIR: "", TMP: "", TEMP: "" },
      {
        launcher: {
          connectOverCDP: async () => {
            throw new Error("Unexpected connection");
          },
          launchPersistentContext: async () => {
            await onLaunch();
            throw new Error("launch boundary reached");
          },
        },
      },
    );
  const first = opening(firstRoot, async () => {
    firstLookup = nodeOs.tmpdir();
    firstEntered.resolve(undefined);
    await releaseFirst.promise;
    firstLookupAfterWait = nodeOs.tmpdir();
  });
  try {
    await awaitAcknowledgement(
      firstEntered.promise,
      first,
      "stuck Android launch",
    );
    await expect(
      opening(secondRoot, async () => {
        secondLookup = nodeOs.tmpdir();
      }),
    ).rejects.toMatchObject({
      diagnostics: { startup_error: "launch boundary reached" },
    });
  } finally {
    releaseFirst.resolve(undefined);
    await Promise.allSettled([first]);
  }
  await expect(first).rejects.toMatchObject({
    diagnostics: { startup_error: "launch boundary reached" },
  });
  expect(firstLookup).toBe(appendCallerPath(firstRoot, "tmp"));
  expect(firstLookupAfterWait).toBe(appendCallerPath(firstRoot, "tmp"));
  expect(secondLookup).toBe(appendCallerPath(secondRoot, "tmp"));
  expect(process.env.TMPDIR).toBe("");
  expect(process.env.TMP).toBe("");
  expect(process.env.TEMP).toBe("");
});

it("places Playwright's host artifact directory on the Termux temp directory", async () => {
  await import("playwright-core");
  const prefix = await createTestTempDirectory("rea-termux-host-");
  vi.stubEnv("TMPDIR", "");
  vi.stubEnv("TMP", "");
  vi.stubEnv("TEMP", "");
  Object.defineProperty(process, "platform", { value: "android" });
  await expect(
    openPlaywrightScenarioBrowser(
      androidLaunchScenario(join(prefix, "missing-chromium")),
      { PREFIX: prefix, TMPDIR: "", TMP: "", TEMP: "" },
    ),
  ).rejects.toMatchObject({
    diagnostics: {
      startup_error: expect.stringMatching(/executable doesn't exist/),
    },
  });
  expect(
    (await readdir(join(prefix, "tmp"))).some((name) =>
      name.startsWith("playwright-artifacts-"),
    ),
  ).toBe(true);
  expect(process.env.TMPDIR).toBe("");
  expect(process.env.TMP).toBe("");
  expect(process.env.TEMP).toBe("");
});

it("publishes a writable Playwright browsers path before an Android launch", async () => {
  const prefix = await createTestTempDirectory("rea-termux-playwright-");
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "");
  Object.defineProperty(process, "platform", { value: "android" });
  await expect(
    openPlaywrightScenarioBrowser(
      androidLaunchScenario(join(prefix, "missing-chromium")),
      { PREFIX: prefix, TMPDIR: "", TMP: "", TEMP: "" },
    ),
  ).rejects.toMatchObject({
    diagnostics: {
      startup_error: expect.stringMatching(/executable doesn't exist/),
    },
  });
  expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe(
    appendCallerPath(appendCallerPath(prefix, "tmp"), "ms-playwright"),
  );
});

it("launches Termux Chromium from the binary next to its ICU data", async () => {
  const prefix = await createTestTempDirectory("rea-termux-icu-");
  const wrapper = join(prefix, "bin", "chromium-browser");
  const chrome = join(prefix, "lib", "chromium", "chrome");
  await mkdir(join(prefix, "bin"), { recursive: true });
  await mkdir(join(prefix, "lib", "chromium"), { recursive: true });
  await writeFile(wrapper, "#!/bin/sh\n");
  await writeFile(chrome, "#!/bin/sh\n");
  Object.defineProperty(process, "platform", { value: "android" });
  let executablePath: string | undefined;
  await expect(
    openPlaywrightScenarioBrowser(
      androidLaunchScenario(wrapper),
      { PREFIX: prefix, TMPDIR: "", TMP: "", TEMP: "" },
      {
        launcher: {
          connectOverCDP: async () => {
            throw new Error("Unexpected connection");
          },
          launchPersistentContext: async (_profile, options) => {
            executablePath = options?.executablePath;
            throw new Error("launch boundary reached");
          },
        },
      },
    ),
  ).rejects.toMatchObject({
    diagnostics: { startup_error: "launch boundary reached" },
  });
  expect(executablePath).toBe(
    appendCallerPath(dirname(wrapper), "../lib/chromium/chrome"),
  );
});

it.skipIf(process.platform === "win32")(
  "launches Termux Chromium through a symlink parent",
  async () => {
    const root = await createTestTempDirectory("rea-termux-chrome-link-");
    const physicalPrefix = join(root, "termux", "usr");
    const decoyChrome = join(root, "work", "lib", "chromium", "chrome");
    await mkdir(join(physicalPrefix, "inner"), { recursive: true });
    await mkdir(join(physicalPrefix, "bin"), { recursive: true });
    await mkdir(join(physicalPrefix, "lib", "chromium"), { recursive: true });
    await mkdir(join(root, "work", "bin"), { recursive: true });
    await mkdir(join(root, "work", "lib", "chromium"), { recursive: true });
    await symlink(join(physicalPrefix, "inner"), join(root, "work", "link"));
    await writeFile(
      join(physicalPrefix, "bin", "chromium-browser"),
      "#!/bin/sh\n",
    );
    await writeFile(
      join(physicalPrefix, "lib", "chromium", "chrome"),
      "#!/bin/sh\n",
    );
    await writeFile(join(root, "work", "bin", "chromium-browser"), "decoy\n");
    await writeFile(decoyChrome, "decoy\n");
    const wrapper = `${root}/work/link/../bin/chromium-browser`;
    Object.defineProperty(process, "platform", { value: "android" });
    let executablePath: string | undefined;
    await expect(
      openPlaywrightScenarioBrowser(
        androidLaunchScenario(wrapper),
        { PREFIX: `${root}/work/link/..`, TMPDIR: "", TMP: "", TEMP: "" },
        {
          launcher: {
            connectOverCDP: async () => {
              throw new Error("Unexpected connection");
            },
            launchPersistentContext: async (_profile, options) => {
              executablePath = options?.executablePath;
              throw new Error("launch boundary reached");
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      diagnostics: { startup_error: "launch boundary reached" },
    });
    const sibling = appendCallerPath(
      dirname(wrapper),
      "../lib/chromium/chrome",
    );
    expect(join(dirname(wrapper), "..", "lib", "chromium", "chrome")).toBe(
      decoyChrome,
    );
    expect(executablePath).toBe(sibling);
    expect(await realpath(executablePath!)).toBe(
      await realpath(join(physicalPrefix, "lib", "chromium", "chrome")),
    );
  },
);

it("keeps a caller-selected Android browser that is not Termux Chromium", async () => {
  const prefix = await createTestTempDirectory("rea-termux-custom-");
  const selected = join(prefix, "bin", "custom-chromium");
  const chrome = join(prefix, "lib", "chromium", "chrome");
  await mkdir(join(prefix, "bin"), { recursive: true });
  await mkdir(join(prefix, "lib", "chromium"), { recursive: true });
  await writeFile(selected, "#!/bin/sh\n");
  await writeFile(chrome, "#!/bin/sh\n");
  Object.defineProperty(process, "platform", { value: "android" });
  let executablePath: string | undefined;
  await expect(
    openPlaywrightScenarioBrowser(
      androidLaunchScenario(selected),
      { PREFIX: prefix, TMPDIR: "", TMP: "", TEMP: "" },
      {
        launcher: {
          connectOverCDP: async () => {
            throw new Error("Unexpected connection");
          },
          launchPersistentContext: async (_profile, options) => {
            executablePath = options?.executablePath;
            throw new Error("launch boundary reached");
          },
        },
      },
    ),
  ).rejects.toMatchObject({
    diagnostics: { startup_error: "launch boundary reached" },
  });
  expect(executablePath).toBe(selected);
});

it("places each overlapping Playwright artifact directory in its own Termux temp", async () => {
  await import("playwright-core");
  const firstRoot = await createTestTempDirectory("rea-termux-artifacts-a-");
  const secondRoot = await createTestTempDirectory("rea-termux-artifacts-b-");
  vi.stubEnv("TMPDIR", "");
  vi.stubEnv("TMP", "");
  vi.stubEnv("TEMP", "");
  Object.defineProperty(process, "platform", { value: "android" });
  const launch = (root: string) =>
    openPlaywrightScenarioBrowser(
      androidLaunchScenario(join(root, "missing-chromium")),
      { PREFIX: root, TMPDIR: "", TMP: "", TEMP: "" },
    );
  const settled = await Promise.allSettled([
    launch(firstRoot),
    launch(secondRoot),
  ]);
  expect(settled.map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  for (const result of settled)
    if (result.status === "rejected")
      expect(result.reason).toMatchObject({
        diagnostics: {
          startup_error: expect.stringMatching(/executable doesn't exist/),
        },
      });
  const artifactCount = async (root: string) =>
    (await readdir(join(root, "tmp"))).filter((name) =>
      name.startsWith("playwright-artifacts-"),
    ).length;
  expect(await artifactCount(firstRoot)).toBe(1);
  expect(await artifactCount(secondRoot)).toBe(1);
  expect(process.env.TMPDIR).toBe("");
  expect(process.env.TMP).toBe("");
  expect(process.env.TEMP).toBe("");
});

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
    const closeStarted = deferred<void>();
    const closeResult = deferred<void>();
    const settled: boolean[] = [];
    const cleanup = new PlaywrightScenarioBrowserCleanupOwner({
      closeBrowser: async (disconnectAtBoundary) => {
        closeStarted.resolve(undefined);
        await disconnectAtBoundary(() => closeResult.promise);
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
    await vi.advanceTimersByTimeAsync(
      PLAYWRIGHT_CLEANUP_CONFIRMATION_TIMEOUT_MS - 1,
    );
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
  const restorationStarted = deferred<void>();
  const finishRestoration = deferred<void>();
  const order: string[] = [];
  const fixture = attachedBrowserFixture({
    send: async (method, parameters) => {
      if (
        method === "Emulation.setTimezoneOverride" &&
        (parameters as { timezoneId?: string }).timezoneId === ""
      ) {
        order.push("restore-started");
        restorationStarted.resolve(undefined);
        await finishRestoration.promise;
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

  await restorationStarted.promise;
  revision += 1;
  finishRestoration.resolve(undefined);
  await release;

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
  ).rejects.toMatchObject({
    diagnostics: { startup_error: "launch boundary reached" },
  });
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
  const eventsStarted = deferred<void>();
  const finishEvents = deferred<void>();
  const gateStarted = deferred<void>();
  const finishGate = deferred<void>();
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
      eventsStarted.resolve(undefined);
      await finishEvents.promise;
    },
    {
      get revision() {
        return revision;
      },
      async run() {
        gateRuns.push(revision);
        if (gateRuns.length === 1) {
          gateStarted.resolve(undefined);
          await finishGate.promise;
        }
      },
    },
  );

  await eventsStarted.promise;
  finishEvents.resolve(undefined);
  await gateStarted.promise;
  revision += 1;
  finishGate.resolve(undefined);
  await release;

  expect(gateRuns).toEqual([0, 1]);
  expect(closeBrowser).toHaveBeenCalledTimes(1);
  expect(owner.browserClosed).toBe(true);
});

it("runs the latest stop gate after attached restoration and before disconnect", async () => {
  const restorationStarted = deferred<void>();
  const finishRestoration = deferred<void>();
  const gateRevisions: number[] = [];
  let revision = 0;
  let disconnected = false;
  const owner = new PlaywrightScenarioBrowserCleanupOwner({
    closeBrowser: async (disconnectAtBoundary) => {
      restorationStarted.resolve(undefined);
      await finishRestoration.promise;
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

  await restorationStarted.promise;
  revision += 1;
  finishRestoration.resolve(undefined);
  await release;

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
    const gateStarted = deferred<void>();
    const finishGate = deferred<void>();
    let revision = 0;
    let failGate = true;
    const gate = {
      get revision() {
        return revision;
      },
      async run() {
        if (failGate) {
          failGate = false;
          gateStarted.resolve(undefined);
          await finishGate.promise;
          throw failure;
        }
      },
    };

    const release = owner.release(undefined, gate).then(
      () => ({ ok: true as const }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
    await gateStarted.promise;
    if (changeRevision) revision += 1;
    finishGate.resolve(undefined);
    await expect(release).resolves.toEqual({ ok: false, cause: failure });
    expect(closeBrowser).toHaveBeenCalledTimes(1);
    expect(transportClosed).toBe(false);
    expect(owner.browserClosed).toBe(false);
    expect(owner.cleanupResources).toContain("browser_transport");

    await owner.release(undefined, gate);
    expect(closeBrowser).toHaveBeenCalledTimes(2);
    expect(transportClosed).toBe(true);
    expect(owner.browserClosed).toBe(true);
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
  expect(performance.now() - started).toBeLessThan(2_000);
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
  expect(performance.now() - started).toBeLessThan(2_000);
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
  let closed = false;
  const started = performance.now();
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
  await expect(
    openPlaywrightScenarioBrowser(
      scenario,
      {},
      {
        launcher: {
          connectOverCDP: async () => {
            await new Promise((resolve) => setTimeout(resolve, 80));
            return {
              close: async () => {
                closed = true;
              },
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
    ),
  ).rejects.toMatchObject({ reason: "timeout" });
  expect(performance.now() - started).toBeLessThan(2_000);
  for (let attempt = 0; attempt < 50 && !closed; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(closed).toBe(true);
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
          if (method !== "Emulation.setFocusEmulationEnabled") return;
          if (parameters?.enabled === false) {
            if (mutation === "focus") restored = true;
          } else if (mutation === "focus")
            await new Promise((resolve) => setTimeout(resolve, 80));
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
      );
    else
      expect(environmentSession.send).toHaveBeenCalledWith(
        "Emulation.clearDeviceMetricsOverride",
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
