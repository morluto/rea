import { PLAYWRIGHT_BROWSER_SCENARIO_PROVIDER_IDENTITY } from "./providerIdentities.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  AnalysisCleanupLeaseGroup,
  AnalysisCleanupLease,
} from "../artifacts/AnalysisCleanupLease.js";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
  chromium,
} from "playwright-core";

import type { BrowserScenario } from "../domain/browserScenario.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { isLiteralLoopbackHostname } from "../domain/browserObservation.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import {
  withPlaywrightExecutionBoundary,
  PLAYWRIGHT_CLEANUP_CONFIRMATION_TIMEOUT_MS,
} from "./PlaywrightExecutionBoundary.js";
import {
  reclaimStaleScenarioProfiles,
  writeScenarioProfileOwner,
} from "./ScenarioProfileReclamation.js";

const OPERATION = "capture_browser_scenario" as const;

/** Best-effort reclamation must never decide when the caller's browser starts. */
const SCENARIO_PROFILE_RECLAMATION_TIMEOUT_MS = 5_000;

const throwIfScenarioCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true)
    throw new BrowserObservationError(OPERATION, "cancelled", {
      cause: signal?.reason,
    });
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
  #eventFinalizationPromise: Promise<void> | undefined;
  #eventsFinalized = false;
  readonly cleanupLease: AnalysisCleanupLease;

  /** Keep the narrow provider actions needed to release one opened browser. */
  constructor(private readonly resources: PlaywrightScenarioCleanupResources) {
    this.#profileRemoved = resources.removeProfile === undefined;
    this.cleanupLease = new AnalysisCleanupLease(
      () =>
        this.#closeResources().finally(() =>
          this.resources.onSettled?.(this.#browserClosed),
        ),
      this,
    );
  }

  get browserClosed(): boolean {
    return this.#browserClosed;
  }

  get cleanupResources(): readonly string[] {
    return [
      ...(!this.#eventsFinalized ? ["browser_events"] : []),
      ...(!this.#browserClosed ? ["browser_transport"] : []),
      ...(!this.#profileRemoved ? ["browser_profile"] : []),
    ];
  }

  /** Await actual resource release, including a late browser acknowledgement. */
  release(finishEvents?: () => Promise<void>): Promise<void> {
    this.#prepareEvents(finishEvents);
    return this.cleanupLease.release();
  }

  close(finishEvents?: () => Promise<void>): Promise<void> {
    return this.#awaitCleanup(this.release(finishEvents));
  }

  #prepareEvents(finishEvents?: () => Promise<void>): void {
    this.#eventFinalizationPromise ??= Promise.resolve().then(async () => {
      await finishEvents?.();
      this.#eventsFinalized = true;
    });
  }

  async #awaitCleanup(cleanup: Promise<void>): Promise<void> {
    try {
      await withPlaywrightExecutionBoundary(
        () => cleanup,
        PLAYWRIGHT_CLEANUP_CONFIRMATION_TIMEOUT_MS,
      );
    } catch (cause: unknown) {
      const failure = new BrowserObservationError(OPERATION, "cleanup_failed", {
        cause,
        cleanup: {
          reason: cause instanceof Error ? cause.message : String(cause),
          resources: this.cleanupResources,
        },
      });
      new AnalysisCleanupLeaseGroup(failure, [this.cleanupLease]);
      throw failure;
    }
  }

  async #closeResources(): Promise<void> {
    const failures: unknown[] = [];
    this.#prepareEvents();
    try {
      await this.#eventFinalizationPromise;
    } catch (cause: unknown) {
      // A failed finalization stays failed: the memoized attempt rejects on
      // every retry so cleanup can never report success for unfinalized
      // events.
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
    waiter.reject(
      new BrowserObservationError(OPERATION, "cancelled", {
        cause: waiter.signal.reason,
      }),
    );
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
): string => {
  const discovery = new URL("/json/version", endpoint);
  // One CDP browser serves every loopback stack on one port, so spellings that
  // reach it through 127.0.0.1 or ::1 must share a single admission.
  if (isLiteralLoopbackHostname(discovery.hostname))
    discovery.hostname = "127.0.0.1";
  return JSON.stringify([discovery.href, targetId]);
};

const acquireAttachedScenario = (
  scenario: Extract<BrowserScenario["browser"], { readonly mode: "connect" }>,
  signal: AbortSignal | undefined,
): Promise<AttachedScenarioLease> => {
  if (signal?.aborted === true)
    return Promise.reject(
      new BrowserObservationError(OPERATION, "cancelled", {
        cause: signal?.reason,
      }),
    );

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
        reject(
          new BrowserObservationError(OPERATION, "cancelled", {
            cause: signal?.reason,
          }),
        );
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
  const selected = Object.fromEntries(
    allowed
      .map((name) => [name, environment[name]] as const)
      .filter(
        (entry): entry is readonly [string, string] => entry[1] !== undefined,
      ),
  );
  if (process.platform !== "android") return selected;

  // Android rejects execve() for binaries below Termux's application data
  // directory. Termux supplies an exec interceptor that rewrites those calls
  // through the system linker and removes itself for the launched program.
  // Playwright must retain it for its Chromium child process.
  const prefix = environment.PREFIX;
  if (prefix === undefined) return selected;
  return {
    ...selected,
    LD_PRELOAD: `${prefix}/lib/libtermux-exec.so`,
    TERMUX_EXEC__PROC_SELF_EXE: process.execPath,
  };
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

/** Owns the target state changed while one scenario uses an attached page. */
class AttachedScenarioEnvironmentOwner {
  #mediaOverride = false;
  #deviceMetricsOverride = false;
  #localeOverride = false;
  #timezoneOverride = false;
  #detached = false;
  #application: Promise<void> | undefined;

  private constructor(
    private readonly page: Page,
    private readonly session: CDPSession,
  ) {}

  static async create(
    context: BrowserContext,
    page: Page,
  ): Promise<AttachedScenarioEnvironmentOwner> {
    return new AttachedScenarioEnvironmentOwner(
      page,
      await context.newCDPSession(page),
    );
  }

  get restored(): boolean {
    return (
      !this.#mediaOverride &&
      !this.#deviceMetricsOverride &&
      !this.#localeOverride &&
      !this.#timezoneOverride
    );
  }

  get targetClosed(): boolean {
    return this.page.isClosed();
  }

  apply(
    environment: BrowserScenario["environment"],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const application =
      this.#application ?? this.#applyEnvironment(environment, signal);
    this.#application = application;
    return application;
  }

  async #applyEnvironment(
    environment: BrowserScenario["environment"],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await this.page.emulateMedia({
      colorScheme: environment.color_scheme,
      reducedMotion: environment.reduced_motion,
    });
    this.#mediaOverride = true;
    throwIfScenarioCancelled(signal);

    // setViewportSize also resizes the external browser window. CDP metrics
    // provide the scenario viewport without changing that caller-owned window.
    await this.session.send("Emulation.setDeviceMetricsOverride", {
      width: environment.viewport.width,
      height: environment.viewport.height,
      deviceScaleFactor: environment.viewport.device_scale_factor,
      mobile: false,
      dontSetVisibleSize: true,
    });
    this.#deviceMetricsOverride = true;
    throwIfScenarioCancelled(signal);

    await this.session.send("Emulation.setLocaleOverride", {
      locale: environment.locale,
    });
    this.#localeOverride = true;
    throwIfScenarioCancelled(signal);

    await this.session.send("Emulation.setTimezoneOverride", {
      timezoneId: environment.timezone,
    });
    this.#timezoneOverride = true;
    throwIfScenarioCancelled(signal);
  }

  async close(): Promise<void> {
    if (this.#detached) return;
    // The execution boundary can report cancellation before a pending CDP
    // command settles. Wait for that producer so every successful mutation is
    // recorded before deciding which state this owner must restore.
    try {
      await this.#application;
    } catch {
      // The operation path reports application failures. Cleanup still owns
      // and restores every mutation that completed before the failure.
    }
    const failures: unknown[] = [];
    if (this.#timezoneOverride) {
      try {
        await this.session.send("Emulation.setTimezoneOverride", {
          timezoneId: "",
        });
        this.#timezoneOverride = false;
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    if (this.#localeOverride) {
      try {
        await this.session.send("Emulation.setLocaleOverride", { locale: "" });
        this.#localeOverride = false;
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    if (this.#deviceMetricsOverride) {
      try {
        await this.session.send("Emulation.clearDeviceMetricsOverride");
        this.#deviceMetricsOverride = false;
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    if (this.#mediaOverride) {
      try {
        await this.page.emulateMedia({
          colorScheme: null,
          reducedMotion: null,
        });
        this.#mediaOverride = false;
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Attached browser environment restoration failed",
      );
    await this.session.detach();
    this.#detached = true;
  }
}

/** Preserve an operation failure while reporting any incomplete cleanup. */
export const failBrowserScenarioOperation = async (
  cleanup: AnalysisCleanupLease,
  primaryFailure: unknown,
): Promise<never> => {
  try {
    await withPlaywrightExecutionBoundary(
      () => cleanup.release(),
      PLAYWRIGHT_CLEANUP_CONFIRMATION_TIMEOUT_MS,
    );
  } catch (cause: unknown) {
    const primary =
      primaryFailure instanceof AnalysisError
        ? primaryFailure
        : new ProviderAdapterError(
            PLAYWRIGHT_BROWSER_SCENARIO_PROVIDER_IDENTITY.id,
            OPERATION,
            {
              cause: primaryFailure,
            },
          );
    const failure = new BrowserObservationError(OPERATION, "cleanup_failed", {
      cause,
      cleanup: {
        reason: cause instanceof Error ? cause.message : String(cause),
        resources: cleanup.cleanupResources ?? [],
      },
    });
    new AnalysisCleanupLeaseGroup(failure, [cleanup]);
    throw analysisErrorWithCleanupFailure(
      primary,
      failure,
      OPERATION,
    ).bindCleanupDependencies([primary, failure]);
  }
  throw primaryFailure;
};

type ScenarioBrowserLauncher = Pick<
  typeof chromium,
  "launchPersistentContext"
> & {
  readonly connectOverCDP: (
    endpoint: string,
  ) => Promise<Pick<Browser, "contexts" | "close" | "isConnected" | "version">>;
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
  retainCleanup: ((lease: AnalysisCleanupLease) => void) | undefined,
): Promise<OpenedScenarioBrowser> => {
  const lease = await acquireAttachedScenario(browserRequest, signal);
  let cleanupOwner: PlaywrightScenarioBrowserCleanupOwner | undefined;
  let environmentOwner: AttachedScenarioEnvironmentOwner | undefined;
  try {
    const priorOwner = lease.admission.cleanupOwner;
    if (priorOwner !== undefined) await priorOwner.close();
    throwIfScenarioCancelled(signal);

    const browser = await launcher.connectOverCDP(browserRequest.cdp_endpoint);
    const cleanup: PlaywrightScenarioBrowserCleanupOwner =
      new PlaywrightScenarioBrowserCleanupOwner({
        closeBrowser: async () => {
          let environmentFailure: unknown;
          const ownedEnvironment = environmentOwner;
          if (ownedEnvironment !== undefined) {
            try {
              await ownedEnvironment.close();
              environmentOwner = undefined;
            } catch (cause: unknown) {
              environmentFailure = cause;
              const browserConnected = browser.isConnected();
              if (ownedEnvironment.targetClosed || !browserConnected) {
                // A destroyed target has no remaining emulation state. A lost
                // transport cannot be retained or retried; release its local
                // owner so later discovery can establish current target state.
                environmentOwner = undefined;
                if (!browserConnected) return;
              } else if (!ownedEnvironment.restored) {
                // Keep the live transport and target session for a cleanup
                // retry while any target override remains.
                throw cause;
              }
            }
          }
          try {
            await browser.close();
            // Once target state is restored, disconnecting the transport is a
            // definitive fallback for an explicit session detach failure.
            environmentOwner = undefined;
          } catch (browserFailure: unknown) {
            if (environmentFailure !== undefined)
              throw new AggregateError(
                [environmentFailure, browserFailure],
                "Attached browser environment cleanup failed",
              );
            throw browserFailure;
          }
        },
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
    const configuredEnvironment = await withPlaywrightExecutionBoundary(
      () =>
        AttachedScenarioEnvironmentOwner.create(target.context, target.page),
      undefined,
      signal,
    );
    environmentOwner = configuredEnvironment;
    await withPlaywrightExecutionBoundary(
      () => configuredEnvironment.apply(environment, signal),
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
    const recovery = cleanup.cleanupLease;
    try {
      return await failBrowserScenarioOperation(recovery, cause);
    } catch (failure: unknown) {
      if (failure !== cause) retainCleanup?.(recovery);
      throw failure;
    }
  }
};

/** Launch or attach using the caller-selected environment and browser engine. */
export const openPlaywrightScenarioBrowser = async (
  scenario: BrowserScenario,
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    readonly launcher?: ScenarioBrowserLauncher;
    readonly signal?: AbortSignal | undefined;
    readonly retainCleanup?: (lease: AnalysisCleanupLease) => void;
  } = {},
): Promise<OpenedScenarioBrowser> => {
  // Load Playwright only when a scenario opens; MCP startup stays off its module graph.
  const launcher =
    options.launcher ?? (await import("playwright-core")).chromium;
  if (scenario.browser.mode === "connect")
    return openAttachedScenarioBrowser(
      scenario.browser,
      scenario.environment,
      launcher,
      options.signal,
      options.retainCleanup,
    );

  // Reclaim what a terminated earlier run could not remove; a profile another
  // live owner still holds is left in place. Best effort: the deadline bounds
  // the sweep so a stale directory can never decide when this browser starts.
  await withPlaywrightExecutionBoundary(
    () => reclaimStaleScenarioProfiles(),
    SCENARIO_PROFILE_RECLAMATION_TIMEOUT_MS,
  ).catch(() => undefined);
  const profilePath = await mkdtemp(join(tmpdir(), "rea-browser-scenario-"));
  let context: BrowserContext;
  try {
    await chmod(profilePath, 0o700);
    // Record this owner so a later run can prove this profile is stale.
    await writeScenarioProfileOwner(profilePath).catch(() => undefined);
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
      // Termux's Chromium cannot create its renderer process through Android's
      // executable boundary. Single-process mode keeps the browser and page in
      // the Termux-launched process so scenario navigation remains available.
      args:
        process.platform === "android"
          ? ["--no-sandbox", "--single-process"]
          : [],
    });
  } catch (cause: unknown) {
    const cleanup = new AnalysisCleanupLease(
      () => rm(profilePath, { recursive: true, force: true, maxRetries: 3 }),
      ["browser_profile"],
    );
    try {
      return await failBrowserScenarioOperation(cleanup, cause);
    } catch (failure: unknown) {
      if (failure !== cause) options.retainCleanup?.(cleanup);
      throw failure;
    }
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
    const recovery = cleanup.cleanupLease;
    try {
      return await failBrowserScenarioOperation(recovery, cause);
    } catch (failure: unknown) {
      if (failure !== cause) options.retainCleanup?.(recovery);
      throw failure;
    }
  }
};
