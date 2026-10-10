import { type BrowserContext, type Page } from "playwright-core";

import type { BrowserScenario } from "../domain/browserScenario.js";
import type { BrowserScenarioAction } from "../domain/browserScenarioValues.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import type { BrowserScenarioSessionPort } from "./BrowserScenarioSessionPort.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { PlaywrightScenarioStorage } from "./PlaywrightScenarioStorage.js";
import {
  failBrowserScenarioOperation,
  openPlaywrightScenarioBrowser,
  type OpenedScenarioBrowser,
} from "./PlaywrightScenarioBrowser.js";
import { performPlaywrightScenarioAction } from "./PlaywrightScenarioActions.js";
import { capturePlaywrightStepArtifacts } from "./PlaywrightScenarioArtifacts.js";
import { PlaywrightScenarioEvents } from "./PlaywrightScenarioEvents.js";
import { withPlaywrightExecutionBoundary } from "./PlaywrightExecutionBoundary.js";
import {
  browserScenarioCaptureData,
  browserScenarioOperationFailure,
} from "./BrowserScenarioPartialObservation.js";

const OPERATION = "capture_browser_scenario" as const;

const installStorageSeeds = async (
  context: BrowserContext,
  page: Page,
  scenario: BrowserScenario,
  secrets: BrowserScenarioSecrets,
  retainCleanup?: (close: () => Promise<unknown>) => void,
): Promise<PlaywrightScenarioStorage | undefined> => {
  await context.addCookies(
    scenario.storage.cookies.map((cookie) => ({
      name: cookie.name,
      value: secrets.value(cookie.value),
      url: secrets.url(cookie.destination),
      httpOnly: cookie.http_only,
      secure: cookie.secure,
      sameSite: cookie.same_site,
    })),
  );
  return PlaywrightScenarioStorage.install(
    context,
    page,
    scenario,
    secrets,
    retainCleanup,
  );
};

const blockAttachedServiceWorkers = async (page: Page): Promise<void> => {
  const controller = await page.evaluate(
    "Boolean(navigator.serviceWorker?.controller)",
  );
  if (controller)
    throw new BrowserObservationError(OPERATION, "target_not_allowed");
  const blockRegistration = `(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((item) => item.unregister())));
    Object.defineProperty(ServiceWorkerContainer.prototype, "register", {
      configurable: false,
      value: () => Promise.reject(new Error("service workers are blocked by scenario policy"))
    });
  })()`;
  await page.addInitScript(blockRegistration);
  await page.evaluate(blockRegistration);
};

const initializePage = async (
  context: BrowserContext,
  page: Page,
  scenario: BrowserScenario,
  secrets: BrowserScenarioSecrets,
  retainCleanup?: (close: () => Promise<unknown>) => void,
): Promise<PlaywrightScenarioStorage | undefined> => {
  context.setDefaultTimeout(0);
  context.setDefaultNavigationTimeout(0);
  if (scenario.browser.mode === "connect")
    await blockAttachedServiceWorkers(page);
  return installStorageSeeds(context, page, scenario, secrets, retainCleanup);
};

export class PlaywrightScenarioSession implements BrowserScenarioSessionPort {
  readonly mode: "launch" | "connect";
  readonly processOwnership: "provider-owned" | "external";
  readonly product = "Chromium";
  readonly version: string;
  readonly initialUrl: string;
  private readonly secrets: BrowserScenarioSecrets;
  private readonly eventCapture: PlaywrightScenarioEvents;
  private readonly storage: PlaywrightScenarioStorage | undefined;
  private readonly signal: AbortSignal | undefined;

  private constructor(
    private readonly opened: OpenedScenarioBrowser,
    options: {
      readonly mode: BrowserScenario["browser"]["mode"];
      readonly secrets: BrowserScenarioSecrets;
      readonly eventCapture: PlaywrightScenarioEvents;
      readonly storage: PlaywrightScenarioStorage | undefined;
      readonly signal: AbortSignal | undefined;
    },
  ) {
    this.mode = options.mode;
    this.processOwnership =
      options.mode === "launch" ? "provider-owned" : "external";
    this.secrets = options.secrets;
    this.eventCapture = options.eventCapture;
    this.storage = options.storage;
    this.signal = options.signal;
    this.version = opened.browser.version();
    this.initialUrl = opened.page.url();
  }

  static async open(
    scenario: BrowserScenario,
    environment: Readonly<Record<string, string | undefined>>,
    options: {
      readonly signal?: AbortSignal;
      readonly retainCleanup?: (close: () => Promise<unknown>) => void;
    },
  ): Promise<PlaywrightScenarioSession> {
    if (options.signal?.aborted === true)
      throw new BrowserObservationError(OPERATION, "cancelled");
    const secrets = BrowserScenarioSecrets.resolve(scenario, environment);
    if (secrets === undefined)
      throw new BrowserObservationError(OPERATION, "secret_unavailable");
    const startedAt = Date.now();
    const opening = openPlaywrightScenarioBrowser(scenario, environment, {
      signal: options.signal,
      ...(options.retainCleanup === undefined
        ? {}
        : { retainCleanup: options.retainCleanup }),
    });
    let opened: OpenedScenarioBrowser;
    let events: PlaywrightScenarioEvents | undefined;
    let storage: PlaywrightScenarioStorage | undefined;
    try {
      opened = await withPlaywrightExecutionBoundary(
        () => opening,
        undefined,
        options.signal,
      );
    } catch (cause: unknown) {
      const lateCleanup = () =>
        opening.then(
          (lateOpened) => lateOpened.cleanup.close(undefined, options.signal),
          () => undefined,
        );
      options.retainCleanup?.(() =>
        withPlaywrightExecutionBoundary(lateCleanup, 1_000),
      );
      void lateCleanup().catch((cleanupCause: unknown) => {
        // best-effort cleanup: retainCleanup keeps the retry capability.
        void cleanupCause;
      });
      throw cause;
    }
    let session: PlaywrightScenarioSession;
    const initialization = initializePage(
      opened.context,
      opened.page,
      scenario,
      secrets,
      options.retainCleanup,
    );
    try {
      storage = await withPlaywrightExecutionBoundary(
        () => initialization,
        undefined,
        options.signal,
      );
      events = new PlaywrightScenarioEvents({
        page: opened.page,
        context: opened.context,
        ownsContext: scenario.browser.mode === "launch",
        enabled: new Set(scenario.capture.events),
        secrets,
        network: scenario.capture.network,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      session = new PlaywrightScenarioSession(opened, {
        mode: scenario.browser.mode,
        secrets,
        eventCapture: events,
        storage,
        signal: options.signal,
      });
    } catch (cause: unknown) {
      const closeBrowser = () =>
        opened.cleanup.close(
          () => events?.finish() ?? Promise.resolve(),
          options.signal,
        );
      const cleanup = async () => {
        try {
          await withPlaywrightExecutionBoundary(
            () =>
              initialization.then(
                (lateStorage) => lateStorage?.close(),
                () => undefined,
              ),
            1_000,
          );
        } catch (failure: unknown) {
          return failBrowserScenarioOperation(closeBrowser, failure);
        }
        await closeBrowser();
      };
      try {
        return await failBrowserScenarioOperation(cleanup, cause);
      } catch (failure: unknown) {
        if (failure !== cause) options.retainCleanup?.(cleanup);
        throw failure;
      }
    }
    try {
      await withPlaywrightExecutionBoundary(
        async () => {
          await opened.page.goto(secrets.url(scenario.start_url), {
            waitUntil: "load",
            timeout: 0,
          });
          await storage?.settle();
        },
        undefined,
        options.signal,
      );
      return session;
    } catch (cause: unknown) {
      let cleanup:
        | "terminated-owned-process"
        | "disconnected-external"
        | "incomplete";
      let cleanupFailure: { readonly cause: unknown } | undefined;
      try {
        cleanup = await session.close(true);
      } catch (failure: unknown) {
        cleanup = "incomplete";
        cleanupFailure = { cause: failure };
        options.retainCleanup?.(() => session.close());
      }
      throw browserScenarioOperationFailure(
        cause,
        {
          kind: "browser-scenario-observation",
          capture: browserScenarioCaptureData({
            session,
            scenario,
            startedAt,
            steps: [],
            cleanup,
            limitations: [
              "Scenario navigation failed before the initial state was captured.",
            ],
          }),
        },
        cleanupFailure,
      );
    }
  }

  currentUrl(): string {
    return this.opened.page.url();
  }

  sanitizeUrl(value: string) {
    return this.secrets.sanitizeUrl(value);
  }

  setStep(index: number): void {
    this.eventCapture.setStep(index);
  }

  nextEventSequence(): number {
    return this.eventCapture.nextSequence();
  }

  lastEventSequence(): number {
    return this.eventCapture.lastSequence();
  }

  events() {
    return this.eventCapture.result();
  }

  /** Preserve event coverage gaps for the aggregate capture's completeness. */
  eventLimitations(): readonly string[] {
    return this.eventCapture.limitations();
  }

  async perform(
    action: BrowserScenarioAction,
    signal?: AbortSignal,
  ): Promise<void> {
    await withPlaywrightExecutionBoundary(
      () =>
        performPlaywrightScenarioAction({
          page: this.opened.page,
          action,
          secrets: this.secrets,
        }),
      "timeout_ms" in action ? action.timeout_ms : undefined,
      signal,
    );
  }

  async capture(
    requested: ReadonlySet<
      BrowserScenario["capture"]["after_each_step"][number]
    >,
    signal?: AbortSignal,
  ) {
    return withPlaywrightExecutionBoundary(
      async () => {
        await this.storage?.settle();
        return capturePlaywrightStepArtifacts({
          context: this.opened.context,
          page: this.opened.page,
          secrets: this.secrets,
          requested,
        });
      },
      undefined,
      signal,
    );
  }

  async close(stopLoading = false) {
    const closeBrowser = () =>
      this.opened.cleanup.close(() => this.eventCapture.finish());
    try {
      await this.storage?.close(stopLoading || this.signal?.aborted === true);
    } catch (cause: unknown) {
      return failBrowserScenarioOperation(closeBrowser, cause);
    }
    await closeBrowser();
    return this.mode === "launch"
      ? ("terminated-owned-process" as const)
      : ("disconnected-external" as const);
  }

  redactError(error: unknown): string {
    return this.secrets.redact(
      error instanceof Error ? error.message : "browser action failed",
    );
  }
}
