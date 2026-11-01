import type { CDPSession, Page, Request } from "playwright-core";

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
  /** Whether the step's own redirect response was handed to the network capture; false once attribution is in doubt. */
  delivered(): boolean;
  stop(): Promise<void>;
}

/** The statuses Fetch redirects on; other 3xx answers, such as 300, are ordinary responses. */
const FETCH_REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

const isRedirect = (answer: RedirectAnswer): boolean =>
  FETCH_REDIRECT_STATUSES.has(answer.status) &&
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
  return {
    request: () => request,
    url: () => request.url(),
    status: () => answer.status,
    headers: () =>
      Object.fromEntries(
        Object.entries(answer.headers).map(([name, value]) => {
          const lower = name.toLowerCase();
          return [
            lower,
            lower === "set-cookie" ? value : value.split("\n").join(", "),
          ];
        }),
      ),
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
  const onWillBeSent = (event: {
    readonly requestId: string;
    readonly request: { readonly url: string; readonly method: string };
    readonly redirectResponse?: unknown;
  }): void => {
    if (
      event.redirectResponse === undefined &&
      event.request.url === url &&
      event.request.method === method
    ) {
      // The same transport identity names the redirect target afterwards, so
      // a second dispatch of the URL cannot be told from the first one.
      if (dispatched.size > 0 && !dispatched.has(event.requestId))
        ambiguous = true;
      dispatched.add(event.requestId);
    }
  };
  const onExtraInfo = (event: {
    readonly requestId: string;
    readonly statusCode: number;
    readonly headers: Readonly<Record<string, string>>;
  }): void => {
    if (!dispatched.has(event.requestId)) return;
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
