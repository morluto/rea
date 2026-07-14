import type { ProgressReporter } from "../application/ProgressReporter.js";
import type {
  ObserveWebSessionInput,
  WebObservationSession,
} from "../domain/browserSession.js";
import {
  AnalysisCancelledError,
  BrowserObservationError,
} from "../domain/errors.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import { CdpConnection, type CdpEvent } from "./CdpConnection.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import {
  allowedSanitizedUrl,
  delayWithCancellation,
  isHttpUrl,
  numberValue,
  recordValue,
  stringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import { mainFrameUrl } from "./CdpCaptureDocuments.js";

interface ObservationContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly discovery: CdpEndpointDiscovery;
  readonly target: CdpEndpointTarget;
  readonly input: ObserveWebSessionInput;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

type EndReason = WebObservationSession["window"]["end_reason"];
type TimelineEvent = WebObservationSession["timeline"][number];

/** Observe external user actions without rejecting approved same-origin navigation. */
export const observeCdpSession = async (
  context: ObservationContext,
): Promise<WebObservationSession> => {
  const allowedOrigins = new Set(context.input.allowed_origins);
  const initial = await authorizedFrame(context, allowedOrigins);
  const initialUrl = mainFrameUrl(initial) ?? "";
  const mainFrameId = frameId(initial);
  if (mainFrameId === undefined)
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  const capture = new TimelineCapture(
    context.input.max_timeline_events,
    allowedOrigins,
    mainFrameId,
    initialUrl,
  );
  const removeListener = context.connection.onEvent((event) => {
    if (event.sessionId === context.sessionId) capture.ingest(event);
  });
  try {
    await context.connection.send(
      "Page.enable",
      {},
      context.sessionId,
      context.signal,
    );
    await context.connection.send(
      "Network.enable",
      { maxTotalBufferSize: 1_024 * 1_024 },
      context.sessionId,
      context.signal,
    );
    await context.connection.send(
      "Page.setLifecycleEventsEnabled",
      { enabled: true },
      context.sessionId,
      context.signal,
    );
    const armedAt = new Date().toISOString();
    await context.progress?.report({
      phase: "browser_observation",
      completed: 1,
      total: 2,
      message:
        "Browser observation armed; perform the approved user action now",
    });
    let endReason = await waitForWindow(
      context.input.observation_ms,
      capture,
      context.signal,
    );
    if (endReason === "window_elapsed")
      endReason = await captureFinalUrl(context, capture, allowedOrigins);
    await context.progress?.report({
      phase: "browser_observation",
      completed: 2,
      total: 2,
      message: "Browser observation window ended",
      terminal: true,
    });
    return {
      schema_version: 1,
      browser: context.discovery.version,
      target: {
        target_id: context.target.id,
        initial_url: allowedSanitizedUrl(initialUrl, allowedOrigins)?.url ?? "",
        final_url: capture.finalUrl,
      },
      window: {
        armed_at: armedAt,
        ended_at: new Date().toISOString(),
        requested_ms: context.input.observation_ms,
        end_reason: endReason,
      },
      timeline: capture.timeline,
      completeness: capture.completeness.snapshot(),
      limitations: [
        "The timeline begins after REA attaches; earlier navigation and network activity is unavailable.",
        "Only navigation metadata is retained; headers, bodies, cookies, console values, and payloads are not captured by this tool.",
        "An out-of-policy destination ends collection immediately and is recorded without its URL.",
      ],
    };
  } finally {
    removeListener();
  }
};

class TimelineCapture {
  readonly timeline: TimelineEvent[] = [];
  readonly completeness = new CdpCaptureCompleteness(["timeline"]);
  finalUrl: string | null;
  #sequence = 0;
  #pendingReload = false;
  #endReason: EndReason | undefined;
  readonly #listeners = new Set<(reason: EndReason) => void>();

  constructor(
    private readonly maximum: number,
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly mainFrameId: string,
    initialUrl: string,
  ) {
    this.finalUrl =
      allowedSanitizedUrl(initialUrl, allowedOrigins)?.url ?? null;
  }

  ingest(event: CdpEvent): void {
    if (this.#endReason !== undefined) return;
    const params = recordValue(event.params);
    if (params === undefined) return;
    switch (event.method) {
      case "Page.frameRequestedNavigation":
        this.#navigationRequested(params);
        break;
      case "Page.frameNavigated":
        this.#navigationCommitted(params);
        break;
      case "Page.navigatedWithinDocument":
        this.#sameDocument(params);
        break;
      case "Network.requestWillBeSent":
        this.#redirect(params);
        break;
      case "Network.loadingFailed":
        this.#loadingFailed(params);
        break;
      case "Page.lifecycleEvent":
        this.#lifecycle(params);
        break;
      case "Inspector.targetCrashed":
      case "Target.detachedFromTarget":
        this.#add("target_terminated", params, null, null, "target_terminated");
        this.end("target_terminated");
        break;
    }
  }

  onEnd(listener: (reason: EndReason) => void): () => void {
    if (this.#endReason !== undefined) listener(this.#endReason);
    else this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  end(reason: EndReason): void {
    if (this.#endReason !== undefined) return;
    this.#endReason = reason;
    for (const listener of this.#listeners) listener(reason);
    this.#listeners.clear();
  }

  setFinalUrl(rawUrl: string): void {
    const destination = scopedUrl(rawUrl, this.allowedOrigins);
    this.finalUrl = destination.scope === "approved" ? destination.url : null;
  }

  #navigationRequested(params: UnknownRecord): void {
    if (stringValue(params.frameId) !== this.mainFrameId) return;
    const reason = safeDetail(params.reason);
    this.#pendingReload = reason === "reload";
    this.#add(
      "navigation_requested",
      params,
      stringValue(params.url),
      null,
      reason,
    );
  }

  #navigationCommitted(params: UnknownRecord): void {
    const frame = recordValue(params.frame);
    if (stringValue(frame?.id) !== this.mainFrameId) return;
    const rawUrl = stringValue(frame?.url);
    const destination = scopedUrl(rawUrl, this.allowedOrigins);
    this.#add(
      this.#pendingReload ? "same_origin_reload" : "navigation_committed",
      { ...params, frameId: frame?.id, loaderId: frame?.loaderId },
      rawUrl,
      null,
      safeDetail(frame?.transitionType),
    );
    this.#pendingReload = false;
    if (destination.scope === "approved") this.finalUrl = destination.url;
    else {
      this.finalUrl = null;
      this.completeness.exclude("timeline", "out_of_target_scope");
      this.end("target_left_scope");
    }
  }

  #sameDocument(params: UnknownRecord): void {
    if (stringValue(params.frameId) !== this.mainFrameId) return;
    const rawUrl = stringValue(params.url);
    const destination = scopedUrl(rawUrl, this.allowedOrigins);
    this.#add("same_document_navigation", params, rawUrl, null, null);
    if (destination.scope === "approved") this.finalUrl = destination.url;
    else {
      this.finalUrl = null;
      this.completeness.exclude("timeline", "out_of_target_scope");
      this.end("target_left_scope");
    }
  }

  #redirect(params: UnknownRecord): void {
    if (
      stringValue(params.frameId) !== this.mainFrameId ||
      recordValue(params.redirectResponse) === undefined
    )
      return;
    const request = recordValue(params.request);
    const rawUrl = stringValue(request?.url);
    const destination = scopedUrl(rawUrl, this.allowedOrigins);
    this.#add(
      "redirect",
      params,
      rawUrl,
      stringValue(params.requestId) ?? null,
      null,
    );
    if (destination.scope !== "approved") {
      this.completeness.exclude("timeline", "out_of_target_scope");
      this.end("target_left_scope");
    }
  }

  #loadingFailed(params: UnknownRecord): void {
    const frame = stringValue(params.frameId);
    if (frame !== undefined && frame !== this.mainFrameId) return;
    this.#add(
      "load_failed",
      params,
      null,
      stringValue(params.requestId) ?? null,
      safeNetworkError(params.errorText),
    );
  }

  #lifecycle(params: UnknownRecord): void {
    if (stringValue(params.frameId) !== this.mainFrameId) return;
    this.#add("lifecycle", params, null, null, safeDetail(params.name));
  }

  #add(
    type: TimelineEvent["type"],
    params: UnknownRecord,
    rawUrl: string | null | undefined,
    requestId: string | null,
    detail: string | null,
  ): void {
    const destination =
      rawUrl == null ? null : scopedUrl(rawUrl, this.allowedOrigins);
    if (this.timeline.length >= this.maximum) {
      this.completeness.drop("timeline_events");
      return;
    }
    this.#sequence += 1;
    this.timeline.push({
      sequence: this.#sequence,
      type,
      timestamp: Math.max(0, numberValue(params.timestamp) ?? 0),
      frame_id: boundedId(params.frameId),
      loader_id: boundedId(params.loaderId),
      request_id: requestId?.slice(0, 256) ?? null,
      url: destination?.scope === "approved" ? destination.url : null,
      destination_scope: destination?.scope ?? null,
      detail,
    });
  }
}

const waitForWindow = async (
  durationMs: number,
  capture: TimelineCapture,
  signal?: AbortSignal,
): Promise<EndReason> =>
  await new Promise<EndReason>((resolve, reject) => {
    let settled = false;
    let removeEnd = (): void => {};
    const finish = (reason: EndReason): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      removeEnd();
      resolve(reason);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeEnd();
      reject(new AnalysisCancelledError("observe_web_session"));
    };
    const timer = setTimeout(() => finish("window_elapsed"), durationMs);
    removeEnd = capture.onEnd(finish);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });

const authorizedFrame = async (
  context: ObservationContext,
  allowedOrigins: ReadonlySet<string>,
): Promise<unknown> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await context.connection.send(
      "Page.getFrameTree",
      {},
      context.sessionId,
      context.signal,
    );
    const url = mainFrameUrl(result);
    if (allowedSanitizedUrl(url, allowedOrigins) !== undefined) return result;
    if (isHttpUrl(url))
      throw new BrowserObservationError(
        "inspect_web_page",
        "target_not_allowed",
      );
    await delayWithCancellation(25, "observe_web_session", context.signal);
  }
  throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
};

const captureFinalUrl = async (
  context: ObservationContext,
  capture: TimelineCapture,
  allowedOrigins: ReadonlySet<string>,
): Promise<EndReason> => {
  const result = await context.connection.send(
    "Page.getFrameTree",
    {},
    context.sessionId,
    context.signal,
  );
  const url = mainFrameUrl(result);
  if (
    url !== undefined &&
    allowedSanitizedUrl(url, allowedOrigins) !== undefined
  ) {
    capture.setFinalUrl(url);
    return "window_elapsed";
  }
  capture.finalUrl = null;
  capture.completeness.exclude(
    "timeline",
    url === undefined ? "invalid_protocol_value" : "out_of_target_scope",
  );
  return "target_left_scope";
};

const frameId = (result: unknown): string | undefined =>
  stringValue(
    recordValue(recordValue(recordValue(result)?.frameTree)?.frame)?.id,
  );

const scopedUrl = (
  value: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): {
  readonly url: string | null;
  readonly scope: "approved" | "outside_policy" | "unsupported";
} => {
  const allowed = allowedSanitizedUrl(value, allowedOrigins);
  if (allowed !== undefined) return { url: allowed.url, scope: "approved" };
  return isHttpUrl(value)
    ? { url: null, scope: "outside_policy" }
    : { url: null, scope: "unsupported" };
};

const boundedId = (value: unknown): string | null =>
  stringValue(value)?.slice(0, 256) ?? null;

const safeDetail = (value: unknown): string | null => {
  const detail = stringValue(value)?.toLowerCase();
  return detail !== undefined && /^[a-z0-9_.:-]{1,100}$/u.test(detail)
    ? detail
    : null;
};

const safeNetworkError = (value: unknown): string | null => {
  const error = stringValue(value);
  return error !== undefined && /^net::ERR_[A-Z0-9_]{1,100}$/u.test(error)
    ? error
    : null;
};
