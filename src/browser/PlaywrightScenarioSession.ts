import {
  type BrowserContext,
  type Page,
  type Route,
  type WebSocketRoute,
} from "playwright-core";

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
import {
  BrowserScenarioCaptureBudget,
  capturePlaywrightStepArtifacts,
} from "./PlaywrightScenarioArtifacts.js";
import { PlaywrightScenarioEvents } from "./PlaywrightScenarioEvents.js";
import { withPlaywrightExecutionBoundary } from "./PlaywrightExecutionBoundary.js";

const OPERATION = "capture_browser_scenario" as const;

const originAllowed = (
  value: string,
  allowedOrigins: ReadonlySet<string>,
): boolean => {
  try {
    return allowedOrigins.has(new URL(value).origin);
  } catch {
    return false;
  }
};

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

const installHttpPolicy = async (input: {
  readonly context: BrowserContext;
  readonly scenario: BrowserScenario;
  readonly secrets: BrowserScenarioSecrets;
  readonly ownedPages: Set<Page>;
  readonly claimOwnedPage: (page: Page) => Promise<boolean>;
}): Promise<void> => {
  const { context, scenario, secrets, ownedPages, claimOwnedPage } = input;
  const routes =
    scenario.request_replay.mode === "exact"
      ? new Map(
          scenario.request_replay.routes.map((route) => [
            `${route.method} ${secrets.url(route.request)}`,
            route,
          ]),
        )
      : new Map();
  await context.route("**/*", async (route, request) => {
    let requestPage: Page | undefined;
    try {
      requestPage = request.frame().page();
    } catch {
      requestPage = undefined;
    }
    if (
      scenario.browser.mode === "connect" &&
      requestPage !== undefined &&
      !ownedPages.has(requestPage)
    )
      await claimOwnedPage(requestPage);
    if (
      scenario.browser.mode === "connect" &&
      (requestPage === undefined || !ownedPages.has(requestPage))
    ) {
      await route.continue();
      return;
    }
    if (!originAllowed(request.url(), new Set(scenario.allowed_origins))) {
      await route.abort("blockedbyclient");
      return;
    }
    const replay = routes.get(`${request.method()} ${request.url()}`);
    if (replay !== undefined) {
      await fulfillReplayRoute(route, replay.response, secrets);
      return;
    }
    if (
      scenario.request_replay.mode === "exact" &&
      scenario.request_replay.unmatched === "abort"
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
};

type ReplayResponse = Extract<
  BrowserScenario["request_replay"],
  { readonly mode: "exact" }
>["routes"][number]["response"];

const fulfillReplayRoute = async (
  route: Route,
  response: ReplayResponse,
  secrets: BrowserScenarioSecrets,
): Promise<void> => {
  if (response.kind === "redirect") {
    await route.fulfill({
      status: response.status,
      headers: { location: secrets.url(response.destination) },
    });
    return;
  }
  await route.fulfill({
    status: response.status,
    headers: Object.fromEntries(
      response.headers.map(({ name, value }) => [name, secrets.value(value)]),
    ),
    ...(response.body === undefined
      ? {}
      : { body: secrets.value(response.body) }),
  });
};

const installWebSocketPolicy = async (
  owner: BrowserContext | Page,
  scenario: BrowserScenario,
): Promise<void> => {
  const allowed = new Set(scenario.allowed_origins);
  await owner.routeWebSocket("**/*", async (route: WebSocketRoute) => {
    const url = new URL(route.url());
    const httpOrigin = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
    if (
      !allowed.has(httpOrigin) ||
      (scenario.request_replay.mode === "exact" &&
        scenario.request_replay.unmatched === "abort")
    ) {
      await route.close({ code: 1008, reason: "outside scenario policy" });
      return;
    }
    route.connectToServer();
  });
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
): Promise<Set<Page>> => {
  context.setDefaultTimeout(scenario.limits.action_timeout_ms);
  context.setDefaultNavigationTimeout(scenario.limits.navigation_timeout_ms);
  const ownedPages = new Set([page]);
  if (scenario.browser.mode === "connect")
    await blockAttachedServiceWorkers(page);
  await installWebSocketPolicy(
    scenario.browser.mode === "launch" ? context : page,
    scenario,
  );
  const claimOwnedPage = async (candidate: Page): Promise<boolean> => {
    if (ownedPages.has(candidate)) return true;
    const opener = await candidate.opener();
    if (opener === null || !ownedPages.has(opener)) return false;
    await installWebSocketPolicy(candidate, scenario);
    ownedPages.add(candidate);
    return true;
  };
  await installHttpPolicy({
    context,
    scenario,
    secrets,
    ownedPages,
    claimOwnedPage,
  });
  page.on("popup", (popup) => {
    if (scenario.browser.mode === "connect")
      void claimOwnedPage(popup).catch(async () => {
        await popup.close().catch(() => undefined);
      });
    else ownedPages.add(popup);
  });
  await installStorageSeeds(context, page, scenario, secrets);
  return ownedPages;
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
    private readonly scenario: BrowserScenario,
    private readonly secrets: BrowserScenarioSecrets,
    private readonly eventCapture: PlaywrightScenarioEvents,
  ) {
    this.mode = scenario.browser.mode;
    this.processOwnership =
      scenario.browser.mode === "launch" ? "provider-owned" : "external";
    this.version = opened.browser.version();
    this.initialUrl = opened.page.url();
  }

  static async open(
    scenario: BrowserScenario,
    environment: Readonly<Record<string, string | undefined>>,
    options: {
      readonly signal?: AbortSignal;
      readonly budget: BrowserScenarioCaptureBudget;
      readonly deadlineAt: number;
    },
  ): Promise<PlaywrightScenarioSession> {
    const remaining = (): number => options.deadlineAt - Date.now();
    if (options.signal?.aborted === true)
      throw new BrowserObservationError(OPERATION, "cancelled");
    const secrets = BrowserScenarioSecrets.resolve(scenario, environment);
    if (secrets === undefined)
      throw new BrowserObservationError(OPERATION, "secret_unavailable");
    const opening = openPlaywrightScenarioBrowser(
      scenario,
      environment,
      remaining(),
    );
    let opened: OpenedScenarioBrowser;
    try {
      opened = await withPlaywrightExecutionBoundary(
        () => opening,
        remaining(),
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
        remaining(),
        options.signal,
      );
      const events = new PlaywrightScenarioEvents({
        page: opened.page,
        enabled: new Set(scenario.capture.events),
        limits: scenario.limits,
        secrets,
        budget: options.budget,
        allowedOrigins: scenario.allowed_origins,
      });
      const session = new PlaywrightScenarioSession(
        opened,
        scenario,
        secrets,
        events,
      );
      await withPlaywrightExecutionBoundary(
        () =>
          opened.page.goto(secrets.url(scenario.start_url), {
            waitUntil: "load",
            timeout: Math.min(
              scenario.limits.navigation_timeout_ms,
              remaining(),
            ),
          }),
        remaining(),
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

  eventTruncationSections() {
    return this.eventCapture.truncationSections();
  }

  async perform(
    action: BrowserScenarioAction,
    maximumTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await withPlaywrightExecutionBoundary(
      () =>
        performPlaywrightScenarioAction({
          page: this.opened.page,
          action,
          secrets: this.secrets,
          defaultTimeoutMs: this.scenario.limits.action_timeout_ms,
          maximumTimeoutMs,
        }),
      maximumTimeoutMs,
      signal,
    );
  }

  async capture(
    requested: ReadonlySet<
      BrowserScenario["capture"]["after_each_step"][number]
    >,
    budget: BrowserScenarioCaptureBudget,
    maximumTimeoutMs: number,
    signal?: AbortSignal,
  ) {
    return withPlaywrightExecutionBoundary(
      () =>
        capturePlaywrightStepArtifacts({
          context: this.opened.context,
          page: this.opened.page,
          scenario: this.scenario,
          secrets: this.secrets,
          requested,
          budget,
        }),
      maximumTimeoutMs,
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
    return this.secrets
      .redact(error instanceof Error ? error.message : "browser action failed")
      .slice(0, 4_096);
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
      readonly budget?: BrowserScenarioCaptureBudget;
      readonly deadlineAt?: number;
    } = {},
  ): Promise<BrowserScenarioSessionPort> {
    return PlaywrightScenarioSession.open(scenario, this.environment, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      budget:
        options.budget ??
        new BrowserScenarioCaptureBudget(
          scenario.limits.max_screenshots,
          scenario.limits.max_total_metadata_bytes,
        ),
      deadlineAt:
        options.deadlineAt ?? Date.now() + scenario.limits.max_duration_ms,
    });
  }
}
