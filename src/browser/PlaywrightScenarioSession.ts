import { type BrowserContext, type Page } from "playwright-core";

import type {
  BrowserScenario,
  BrowserScenarioAction,
} from "../domain/browserScenario.js";
import { BrowserObservationError } from "../domain/errors.js";
import type {
  BrowserScenarioSessionFactory,
  BrowserScenarioSessionPort,
} from "./BrowserScenarioSessionPort.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import {
  closePlaywrightScenarioBrowser,
  openPlaywrightScenarioBrowser,
  type OpenedScenarioBrowser,
} from "./PlaywrightScenarioBrowser.js";
import { performPlaywrightScenarioAction } from "./PlaywrightScenarioActions.js";
import { capturePlaywrightStepArtifacts } from "./PlaywrightScenarioArtifacts.js";
import { PlaywrightScenarioEvents } from "./PlaywrightScenarioEvents.js";
import { withPlaywrightExecutionBoundary } from "./PlaywrightExecutionBoundary.js";

const OPERATION = "capture_browser_scenario" as const;

const storageSeeds = (
  blocks: BrowserScenario["storage"]["local_storage"],
  secrets: BrowserScenarioSecrets,
): Record<string, string[][]> => {
  const seeds: Record<string, string[][]> = {};
  for (const { origin, entries } of blocks)
    (seeds[origin] ??= []).push(
      ...entries.map(({ name, value }) => [name, secrets.value(value)]),
    );
  return seeds;
};

const installStorageSeeds = async (
  context: BrowserContext,
  page: Page,
  scenario: BrowserScenario,
  secrets: BrowserScenarioSecrets,
): Promise<void> => {
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
  const storage = {
    local: storageSeeds(scenario.storage.local_storage, secrets),
    session: storageSeeds(scenario.storage.session_storage, secrets),
  };
  const payload = JSON.stringify(storage).replaceAll("<", "\\u003c");
  await page.addInitScript(`(() => {
    const seeds = ${payload};
    const local = seeds.local[window.location.origin] ?? [];
    const session = seeds.session[window.location.origin] ?? [];
    for (const [name, value] of local) window.localStorage.setItem(name, value);
    for (const [name, value] of session)
      window.sessionStorage.setItem(name, value);
  })()`);
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
): Promise<void> => {
  context.setDefaultTimeout(0);
  context.setDefaultNavigationTimeout(0);
  if (scenario.browser.mode === "connect")
    await blockAttachedServiceWorkers(page);
  await installStorageSeeds(context, page, scenario, secrets);
};

export class PlaywrightScenarioSession implements BrowserScenarioSessionPort {
  readonly mode: "launch" | "connect";
  readonly processOwnership: "provider-owned" | "external";
  readonly product = "Chromium";
  readonly version: string;
  readonly initialUrl: string;
  private closed = false;

  private constructor(
    private readonly opened: OpenedScenarioBrowser,
    mode: BrowserScenario["browser"]["mode"],
    private readonly secrets: BrowserScenarioSecrets,
    private readonly eventCapture: PlaywrightScenarioEvents,
  ) {
    this.mode = mode;
    this.processOwnership = mode === "launch" ? "provider-owned" : "external";
    this.version = opened.browser.version();
    this.initialUrl = opened.page.url();
  }

  static async open(
    scenario: BrowserScenario,
    environment: Readonly<Record<string, string | undefined>>,
    options: {
      readonly signal?: AbortSignal;
    },
  ): Promise<PlaywrightScenarioSession> {
    if (options.signal?.aborted === true)
      throw new BrowserObservationError(OPERATION, "cancelled");
    const secrets = BrowserScenarioSecrets.resolve(scenario, environment);
    if (secrets === undefined)
      throw new BrowserObservationError(OPERATION, "secret_unavailable");
    const opening = openPlaywrightScenarioBrowser(scenario, environment);
    let opened: OpenedScenarioBrowser;
    try {
      opened = await withPlaywrightExecutionBoundary(
        () => opening,
        undefined,
        options.signal,
      );
    } catch (cause: unknown) {
      void opening
        .then((lateOpened) => closePlaywrightScenarioBrowser(lateOpened))
        .catch(() => undefined);
      throw cause;
    }
    try {
      await withPlaywrightExecutionBoundary(
        () => initializePage(opened.context, opened.page, scenario, secrets),
        undefined,
        options.signal,
      );
      const events = new PlaywrightScenarioEvents({
        page: opened.page,
        enabled: new Set(scenario.capture.events),
        secrets,
      });
      const session = new PlaywrightScenarioSession(
        opened,
        scenario.browser.mode,
        secrets,
        events,
      );
      await withPlaywrightExecutionBoundary(
        () =>
          opened.page.goto(secrets.url(scenario.start_url), {
            waitUntil: "load",
            timeout: 0,
          }),
        undefined,
        options.signal,
      );
      return session;
    } catch (cause: unknown) {
      await closePlaywrightScenarioBrowser(opened);
      throw cause;
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
      () =>
        capturePlaywrightStepArtifacts({
          context: this.opened.context,
          page: this.opened.page,
          secrets: this.secrets,
          requested,
        }),
      undefined,
      signal,
    );
  }

  async close() {
    if (this.closed)
      return this.mode === "launch"
        ? ("terminated-owned-process" as const)
        : ("disconnected-external" as const);
    this.closed = true;
    await closePlaywrightScenarioBrowser(this.opened);
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

/** Production Playwright/CDP session factory. */
export class PlaywrightScenarioSessionFactory
  implements BrowserScenarioSessionFactory
{
  constructor(
    private readonly environment: Readonly<
      Record<string, string | undefined>
    > = process.env,
  ) {}

  open(
    scenario: BrowserScenario,
    options: {
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<BrowserScenarioSessionPort> {
    return PlaywrightScenarioSession.open(scenario, this.environment, options);
  }
}
