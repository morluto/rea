import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";

import type { BrowserScenario } from "../domain/browserScenario.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { withPlaywrightExecutionBoundary } from "./PlaywrightExecutionBoundary.js";

const OPERATION = "capture_browser_scenario" as const;

const throwIfScenarioCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true)
    throw new BrowserObservationError(OPERATION, "cancelled");
};

export interface OpenedScenarioBrowser {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly browser: Pick<Browser, "contexts" | "close" | "version">;
  readonly profilePath: string | undefined;
  readonly cleanup: PlaywrightScenarioBrowserCleanupOwner;
}

/** Provider actions retained until the owned browser and profile are released. */
interface PlaywrightScenarioCleanupResources {
  readonly closeBrowser: () => Promise<void>;
  readonly removeProfile: (() => Promise<void>) | undefined;
  readonly onSettled?: (browserClosed: boolean) => void;
}

/** Owns one browser connection and optional private profile through cleanup retries. */
export class PlaywrightScenarioBrowserCleanupOwner {
  #browserClosed = false;
  #profileRemoved: boolean;
  #closePromise: Promise<void> | undefined;
  #eventFinalizationPromise: Promise<void> | undefined;

  /** Keep the narrow provider actions needed to release one opened browser. */
  constructor(private readonly resources: PlaywrightScenarioCleanupResources) {
    this.#profileRemoved = resources.removeProfile === undefined;
  }

  close(
    finishEvents?: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const cleanup = this.#closePromise ?? this.#closeResources(finishEvents);
    if (this.#closePromise === undefined) {
      this.#closePromise = cleanup;
      void cleanup.then(
        () => this.resources.onSettled?.(this.#browserClosed),
        () => {
          if (this.#closePromise === cleanup) this.#closePromise = undefined;
          this.resources.onSettled?.(this.#browserClosed);
        },
      );
    }
    return this.#awaitCleanup(cleanup, signal);
  }

  async #awaitCleanup(
    cleanup: Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await withPlaywrightExecutionBoundary(() => cleanup, 1_000, signal);
    } catch (cause: unknown) {
      throw new BrowserObservationError(OPERATION, "cleanup_failed", {
        cause,
        cleanup: {
          reason: cause instanceof Error ? cause.message : String(cause),
          resources: [
            "browser_transport",
            ...(this.resources.removeProfile === undefined
              ? []
              : ["browser_profile"]),
          ],
        },
      });
    }
  }

  async #closeResources(finishEvents?: () => Promise<void>): Promise<void> {
    const failures: unknown[] = [];
    const eventFinalization = (this.#eventFinalizationPromise ??=
      Promise.resolve().then(async () => {
        await finishEvents?.();
      }));
    try {
      await eventFinalization;
    } catch (cause: unknown) {
      failures.push(cause);
    }
    if (!this.#browserClosed) {
      try {
        await this.resources.closeBrowser();
        this.#browserClosed = true;
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    if (
      this.#browserClosed &&
      !this.#profileRemoved &&
      this.resources.removeProfile !== undefined
    ) {
      try {
        await this.resources.removeProfile();
        this.#profileRemoved = true;
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Browser session cleanup failed");
  }
}

interface AttachedScenarioWaiter {
  readonly signal: AbortSignal | undefined;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: BrowserObservationError) => void;
  onAbort: (() => void) | undefined;
}

interface AttachedScenarioAdmission {
  active: boolean;
  readonly waiters: AttachedScenarioWaiter[];
  cleanupOwner: PlaywrightScenarioBrowserCleanupOwner | undefined;
}

interface AttachedScenarioLease {
  readonly admission: AttachedScenarioAdmission;
  readonly release: () => void;
}

const attachedScenarioAdmissions = new Map<string, AttachedScenarioAdmission>();

const releaseAttachedScenario = (
  key: string,
  admission: AttachedScenarioAdmission,
): void => {
  const waiter = admission.waiters.shift();
  if (waiter === undefined) {
    admission.active = false;
    if (
      admission.cleanupOwner === undefined &&
      attachedScenarioAdmissions.get(key) === admission
    )
      attachedScenarioAdmissions.delete(key);
    return;
  }

  if (waiter.onAbort !== undefined)
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
  if (waiter.signal?.aborted === true) {
    waiter.reject(new BrowserObservationError(OPERATION, "cancelled"));
    releaseAttachedScenario(key, admission);
    return;
  }
  waiter.resolve(createAttachedScenarioRelease(key, admission));
};

const createAttachedScenarioRelease = (
  key: string,
  admission: AttachedScenarioAdmission,
): (() => void) => {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseAttachedScenario(key, admission);
  };
};

/** One browser admission. The key is the discovery URL this endpoint already parses. */
export const attachedScenarioLeaseKey = (
  endpoint: string,
  targetId: string,
): string =>
  JSON.stringify([new URL("/json/version", endpoint).href, targetId]);

const acquireAttachedScenario = (
  scenario: Extract<BrowserScenario["browser"], { readonly mode: "connect" }>,
  signal: AbortSignal | undefined,
): Promise<AttachedScenarioLease> => {
  if (signal?.aborted === true)
    return Promise.reject(new BrowserObservationError(OPERATION, "cancelled"));

  const key = attachedScenarioLeaseKey(
    scenario.cdp_endpoint,
    scenario.target_id,
  );
  const admission =
    attachedScenarioAdmissions.get(key) ??
    ({
      active: false,
      waiters: [],
      cleanupOwner: undefined,
    } satisfies AttachedScenarioAdmission);
  attachedScenarioAdmissions.set(key, admission);

  return new Promise((resolve, reject) => {
    const grant = (release: () => void): void =>
      resolve({ admission, release });
    if (!admission.active) {
      admission.active = true;
      grant(createAttachedScenarioRelease(key, admission));
      return;
    }

    const waiter: AttachedScenarioWaiter = {
      signal,
      resolve: (release) => grant(release),
      reject,
      onAbort: undefined,
    };
    admission.waiters.push(waiter);
    if (signal !== undefined) {
      const onAbort = (): void => {
        const index = admission.waiters.indexOf(waiter);
        if (index < 0) return;
        admission.waiters.splice(index, 1);
        signal.removeEventListener("abort", onAbort);
        reject(new BrowserObservationError(OPERATION, "cancelled"));
        if (!admission.active && admission.waiters.length === 0)
          releaseAttachedScenario(key, admission);
      };
      waiter.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
    }
  });
};

const allowedBrowserEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> => {
  const allowed = [
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "HOME",
    "LANG",
    "LD_LIBRARY_PATH",
    "PATH",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
  ];
  return Object.fromEntries(
    allowed
      .map((name) => [name, environment[name]] as const)
      .filter(
        (entry): entry is readonly [string, string] => entry[1] !== undefined,
      ),
  );
};
const findConnectedPage = async (
  browser: Pick<Browser, "contexts">,
  targetId: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly context: BrowserContext; readonly page: Page }> => {
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      const session = await context.newCDPSession(page);
      try {
        throwIfScenarioCancelled(signal);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        throwIfScenarioCancelled(signal);
        if (targetInfo.targetId !== targetId) continue;
        return { context, page };
      } finally {
        await session.detach();
      }
    }
  throw new BrowserObservationError(OPERATION, "target_not_found");
};

const configureAttachedEnvironment = async (
  context: BrowserContext,
  page: Page,
  environment: BrowserScenario["environment"],
  signal: AbortSignal | undefined,
): Promise<void> => {
  // setViewportSize also resizes the external browser window. The scenario's
  // CDP metrics override below supplies the viewport and expires on disconnect.
  await page.emulateMedia({
    colorScheme: environment.color_scheme,
    reducedMotion: environment.reduced_motion,
  });
  throwIfScenarioCancelled(signal);
  const session = await context.newCDPSession(page);
  throwIfScenarioCancelled(signal);
  // Chromium resets these overrides when the CDP session detaches. Keep it on
  // the scenario transport until cleanup disconnects the attached browser.
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: environment.viewport.width,
    height: environment.viewport.height,
    deviceScaleFactor: environment.viewport.device_scale_factor,
    mobile: false,
    dontSetVisibleSize: true,
  });
  throwIfScenarioCancelled(signal);
  await session.send("Emulation.setLocaleOverride", {
    locale: environment.locale,
  });
  throwIfScenarioCancelled(signal);
  await session.send("Emulation.setTimezoneOverride", {
    timezoneId: environment.timezone,
  });
};

/** Preserve an operation failure while reporting any incomplete cleanup. */
export const failBrowserScenarioOperation = async (
  cleanup: () => Promise<void>,
  primaryFailure: unknown,
  fallbackCleanupResources: readonly string[] = ["browser_transport"],
): Promise<never> => {
  try {
    await cleanup();
  } catch (cleanupFailure: unknown) {
    const cleanupDetails =
      cleanupFailure instanceof AnalysisError &&
      cleanupFailure.cleanup !== undefined
        ? cleanupFailure.cleanup
        : {
            reason:
              cleanupFailure instanceof Error
                ? cleanupFailure.message
                : String(cleanupFailure),
            resources:
              cleanupFailure instanceof AnalysisError
                ? cleanupFailure.cleanupResources
                : fallbackCleanupResources,
          };
    throw new BrowserObservationError(OPERATION, "cleanup_failed", {
      cause: new AggregateError(
        [primaryFailure, cleanupFailure],
        "Browser scenario operation and cleanup both failed",
        { cause: primaryFailure },
      ),
      cleanup: cleanupDetails,
    });
  }
  throw primaryFailure;
};

type ScenarioBrowserLauncher = Pick<
  typeof chromium,
  "launchPersistentContext"
> & {
  readonly connectOverCDP: (
    endpoint: string,
  ) => Promise<Pick<Browser, "contexts" | "close" | "version">>;
};

type AttachedBrowserRequest = Extract<
  BrowserScenario["browser"],
  { readonly mode: "connect" }
>;

const openAttachedScenarioBrowser = async (
  browserRequest: AttachedBrowserRequest,
  environment: BrowserScenario["environment"],
  launcher: ScenarioBrowserLauncher,
  signal: AbortSignal | undefined,
): Promise<OpenedScenarioBrowser> => {
  const lease = await acquireAttachedScenario(browserRequest, signal);
  let cleanupOwner: PlaywrightScenarioBrowserCleanupOwner | undefined;
  try {
    const priorOwner = lease.admission.cleanupOwner;
    if (priorOwner !== undefined) await priorOwner.close();
    throwIfScenarioCancelled(signal);

    const browser = await launcher.connectOverCDP(browserRequest.cdp_endpoint);
    const cleanup: PlaywrightScenarioBrowserCleanupOwner =
      new PlaywrightScenarioBrowserCleanupOwner({
        closeBrowser: () => browser.close(),
        onSettled: (browserClosed) => {
          if (browserClosed && lease.admission.cleanupOwner === cleanup)
            lease.admission.cleanupOwner = undefined;
          lease.release();
        },
        removeProfile: undefined,
      });
    cleanupOwner = cleanup;
    lease.admission.cleanupOwner = cleanup;
    throwIfScenarioCancelled(signal);
    const target = await withPlaywrightExecutionBoundary(
      () => findConnectedPage(browser, browserRequest.target_id, signal),
      undefined,
      signal,
    );
    throwIfScenarioCancelled(signal);
    await withPlaywrightExecutionBoundary(
      () =>
        configureAttachedEnvironment(
          target.context,
          target.page,
          environment,
          signal,
        ),
      undefined,
      signal,
    );
    return {
      ...target,
      browser,
      profilePath: undefined,
      cleanup,
    };
  } catch (cause: unknown) {
    if (cleanupOwner === undefined) {
      lease.release();
      throw cause;
    }
    const cleanup = cleanupOwner;
    return failBrowserScenarioOperation(() => cleanup.close(), cause);
  }
};

/** Launch or attach using the caller-selected environment and browser engine. */
export const openPlaywrightScenarioBrowser = async (
  scenario: BrowserScenario,
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    readonly launcher?: ScenarioBrowserLauncher;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<OpenedScenarioBrowser> => {
  const launcher = options.launcher ?? chromium;
  if (scenario.browser.mode === "connect")
    return openAttachedScenarioBrowser(
      scenario.browser,
      scenario.environment,
      launcher,
      options.signal,
    );

  const profilePath = await mkdtemp(join(tmpdir(), "rea-browser-scenario-"));
  let context: BrowserContext;
  try {
    await chmod(profilePath, 0o700);
    context = await launcher.launchPersistentContext(profilePath, {
      executablePath: resolve(scenario.browser.executable_path),
      headless: scenario.browser.headless,
      acceptDownloads: false,
      viewport: {
        width: scenario.environment.viewport.width,
        height: scenario.environment.viewport.height,
      },
      deviceScaleFactor: scenario.environment.viewport.device_scale_factor,
      locale: scenario.environment.locale,
      timezoneId: scenario.environment.timezone,
      colorScheme: scenario.environment.color_scheme,
      reducedMotion: scenario.environment.reduced_motion,
      serviceWorkers: scenario.environment.service_workers,
      env: allowedBrowserEnvironment(environment),
      handleSIGHUP: false,
      handleSIGINT: false,
      handleSIGTERM: false,
      timeout: 0,
    });
  } catch (cause: unknown) {
    return failBrowserScenarioOperation(
      () => rm(profilePath, { recursive: true, force: true, maxRetries: 3 }),
      cause,
      ["browser_profile"],
    );
  }
  const cleanup = new PlaywrightScenarioBrowserCleanupOwner({
    closeBrowser: () => context.close(),
    removeProfile: () =>
      rm(profilePath, { recursive: true, force: true, maxRetries: 3 }),
  });
  try {
    const browser = context.browser();
    if (browser === null)
      throw new BrowserObservationError(OPERATION, "protocol_error");
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      context,
      page,
      browser,
      profilePath,
      cleanup,
    };
  } catch (cause: unknown) {
    return failBrowserScenarioOperation(() => cleanup.close(), cause);
  }
};
