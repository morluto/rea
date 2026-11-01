import type { CDPSession, Page, Request } from "playwright-core";

import {
  readCdpRequestWillBeSent,
  readCdpResponseReceivedExtraInfo,
} from "./CdpNetworkEventFacts.js";
import { withPlaywrightExecutionBoundary } from "./PlaywrightExecutionBoundary.js";
import type { ScenarioNetworkResponse } from "./network/PlaywrightScenarioNetwork.js";

/** Attaching or detaching is best effort; it must never hold up a request step. */
const REDIRECT_TRANSPORT_TIMEOUT_MS = 2_000;

interface RedirectAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

/** A redirect answer whose request is the browser's own request object. */
export type ScenarioRedirectResponse = Omit<
  ScenarioNetworkResponse,
  "request"
> & {
  request(): Request;
};

/** A request step's redirect answer, as the browser's network service reported it. */
export interface ScenarioRedirectObservation {
  /** Whether the step's own redirect response was offered to the network capture, which still applies its event budgets; false once attribution is in doubt. */
  delivered(): boolean;
  stop(): Promise<void>;
}

/** The statuses Fetch redirects on; other 3xx answers, such as 300, are ordinary responses. */
const FETCH_REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/**
 * Chromium refuses response headers beyond 256 KiB, so a genuine redirect
 * answer is smaller. Measure the raw report before any copy or expansion; a
 * larger one is not recovered and the step discloses the gap instead.
 */
const MAX_REDIRECT_HEADER_CHARACTERS = 256 * 1024;

/** A redirect answer carries a few dozen header fields; bound the expanded entries separately from their size. */
const MAX_REDIRECT_HEADER_ENTRIES = 4096;

/** Whether the raw report is small enough to expand, counted without copying any value. */
const withinHeaderBounds = (
  headers: Readonly<Record<string, string>>,
): boolean => {
  let characters = 0;
  let entries = 0;
  for (const name in headers) {
    const value = headers[name] ?? "";
    characters += name.length + value.length;
    entries += 1;
    for (
      let at = value.indexOf("\n");
      at !== -1;
      at = value.indexOf("\n", at + 1)
    )
      entries += 1;
    if (
      characters > MAX_REDIRECT_HEADER_CHARACTERS ||
      entries > MAX_REDIRECT_HEADER_ENTRIES
    )
      return false;
  }
  return true;
};

const isRedirect = (answer: RedirectAnswer): boolean =>
  FETCH_REDIRECT_STATUSES.has(answer.status) &&
  withinHeaderBounds(answer.headers) &&
  Object.keys(answer.headers).some((name) => name.toLowerCase() === "location");

/**
 * A redirect answered to a manual-redirect page fetch while a route guard is
 * installed reaches Playwright only as a failed request: no response event is
 * emitted. The browser still reports the status and headers on the Network
 * domain, so present them to the capture as the response Playwright withheld.
 * The CDP headers object joins repeated names with a line break, as Playwright
 * itself reads it. Body reads are never attempted for a redirect.
 */
const redirectResponse = (
  request: Request,
  answer: RedirectAnswer,
): ScenarioRedirectResponse => {
  let flattened: Record<string, string> | undefined;
  return {
    request: () => request,
    url: () => request.url(),
    status: () => answer.status,
    headers: () =>
      (flattened ??= Object.fromEntries(
        Object.entries(answer.headers).map(([name, value]) => {
          const lower = name.toLowerCase();
          return [
            lower,
            lower === "set-cookie" ? value : value.split("\n").join(", "),
          ];
        }),
      )),
    // Expanded only when the capture selects header values and admits them.
    headersArray: async () =>
      Object.entries(answer.headers).flatMap(([name, value]) =>
        value.split("\n").map((single) => ({ name, value: single })),
      ),
    body: () =>
      Promise.reject(new Error("A redirect response has no readable body.")),
  };
};

/**
 * Watch one request step's dispatch on the Network domain and hand a redirect
 * answer to `onResponse` the moment the browser reports it, before Playwright
 * reports the request as failed. Returns `undefined` when the browser offers
 * no such transport; the caller then discloses the gap.
 */
export const observeScenarioRedirect = async (input: {
  readonly page: Page;
  readonly url: string;
  readonly method: string;
  readonly signal?: AbortSignal | undefined;
  readonly onResponse: (response: ScenarioRedirectResponse) => void;
}): Promise<ScenarioRedirectObservation | undefined> => {
  const { page, url, method, signal, onResponse } = input;
  const attaching = (async () => {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Network.enable");
    } catch (cause: unknown) {
      await session.detach().catch(() => undefined);
      throw cause;
    }
    return session;
  })();
  let session: CDPSession;
  try {
    session = await withPlaywrightExecutionBoundary(
      () => attaching,
      REDIRECT_TRANSPORT_TIMEOUT_MS,
      signal,
    );
  } catch {
    // A late attachment is released as soon as it settles.
    void attaching.then(
      (late) => late.detach().catch(() => undefined),
      () => undefined,
    );
    return undefined;
  }

  const dispatched = new Set<string>();
  let request: Request | undefined;
  let ambiguous = false;
  let answer: RedirectAnswer | undefined;
  let delivered = false;
  const deliver = (): void => {
    if (delivered || ambiguous || request === undefined || answer === undefined)
      return;
    delivered = true;
    onResponse(redirectResponse(request, answer));
  };
  const onRequest = (sent: Request): void => {
    if (sent.url() !== url || sent.method() !== method) return;
    if (request === undefined) request = sent;
    else if (request !== sent) ambiguous = true;
    deliver();
  };
  const onWillBeSent = (reported: unknown): void => {
    const event = readCdpRequestWillBeSent(reported);
    if (
      event.requestId !== null &&
      event.redirect.kind === "missing" &&
      event.request?.url === url &&
      event.request.method === method
    ) {
      // The same transport identity names the redirect target afterwards, so
      // a second dispatch of the URL cannot be told from the first one.
      if (ambiguous) return;
      if (dispatched.size > 0 && !dispatched.has(event.requestId)) {
        // Attribution is lost for good; stop retaining transport identities.
        ambiguous = true;
        dispatched.clear();
        return;
      }
      dispatched.add(event.requestId);
    }
  };
  const onExtraInfo = (reported: unknown): void => {
    const event = readCdpResponseReceivedExtraInfo(reported);
    if (
      event.requestId === null ||
      event.statusCode === undefined ||
      event.headers === undefined ||
      !dispatched.has(event.requestId)
    )
      return;
    const candidate = { status: event.statusCode, headers: event.headers };
    if (!isRedirect(candidate)) return;
    answer = candidate;
    deliver();
  };
  session.on("Network.requestWillBeSent", onWillBeSent);
  session.on("Network.responseReceivedExtraInfo", onExtraInfo);
  page.on("request", onRequest);

  return {
    delivered: () => delivered && !ambiguous,
    /** Stops listening before the first await; the returned detach is bounded and never rejects. */
    stop: async () => {
      page.off("request", onRequest);
      session.off("Network.requestWillBeSent", onWillBeSent);
      session.off("Network.responseReceivedExtraInfo", onExtraInfo);
      await withPlaywrightExecutionBoundary(
        () => session.detach(),
        REDIRECT_TRANSPORT_TIMEOUT_MS,
      ).catch(() => undefined);
    },
  };
};
