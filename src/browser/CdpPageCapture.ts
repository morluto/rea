import type { InspectWebPageInput } from "../domain/browserObservation.js";
import type { WebPageInspection } from "../domain/browserObservationSchemas.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { type BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { stableWebResources } from "../domain/webInventory.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import { CdpConnection } from "./CdpConnection.js";
import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import {
  authorizedMainFrame,
  MASKED_MAIN_FRAME_LIMITATION,
  type CdpMainFrameSnapshot,
} from "./CdpAuthorizedMainFrame.js";
import { captureStorage } from "./CdpCaptureStorage.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import {
  captureAccessibility,
  captureDom,
  captureFrames,
  captureResources,
  type CapturedResource,
} from "./CdpCaptureDocuments.js";
import {
  allowedSanitizedUrl,
  delayWithCancellation,
} from "./CdpCaptureValues.js";
import { captureScripts } from "./CdpPageCaptureScripts.js";
import { captureWorkers } from "./CdpPageCaptureWorkers.js";
import type { WebSourceMapRequest } from "./WebSourceMapFetcher.js";

export interface CaptureContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly operation: Extract<
    BrowserObservationOperation,
    "inspect_web_page" | "analyze_web_bundle"
  >;
  readonly discovery: CdpEndpointDiscovery;
  readonly target: CdpEndpointTarget;
  readonly input: InspectWebPageInput;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

interface CaptureState {
  readonly context: CaptureContext;
  readonly events: CdpCaptureEvents;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly limitations: string[];
  readonly startedAt: string;
}

interface CapturedSections {
  readonly attachedUrl: string;
  readonly frames: WebPageInspection["frames"];
  readonly dom: ReturnType<typeof captureDom>;
  readonly accessibility: ReturnType<typeof captureAccessibility>;
  readonly scripts: WebPageInspection["scripts"];
  readonly resources: WebPageInspection["resources"];
  readonly workers: WebPageInspection["workers"];
  readonly storage: WebPageInspection["storage"];
}

export interface CapturedPage {
  readonly inspection: WebPageInspection;
  readonly sourceMapRequests: readonly WebSourceMapRequest[];
}

/** Capture and normalize one attached page without evaluating page JavaScript. */
export const capturePage = async (
  context: CaptureContext,
): Promise<CapturedPage> => {
  const allowedOrigins = new Set(context.input.allowed_origins);
  const events = new CdpCaptureEvents(context.input, allowedOrigins);
  const removeListener = context.connection.onEvent((event) => {
    if (event.sessionId !== context.sessionId) return;
    events.ingest(event);
  });
  const state: CaptureState = {
    context,
    events,
    allowedOrigins,
    limitations: [
      "Observation starts when REA attaches; prior network and console activity is unavailable.",
      "Raw network headers, bodies, cookies, storage values, console objects, and WebSocket payloads are never retained; explicitly requested primitive console text is retained verbatim, while payload captures retain value-free shapes.",
      "Source maps are reported only as declarative URLs and are not fetched.",
      "URL-less scripts and console events without an allowed source URL are excluded because their origin cannot be proven.",
    ],
    startedAt: new Date().toISOString(),
  };
  try {
    return await captureAuthorizedPage(state);
  } finally {
    removeListener();
  }
};

const captureAuthorizedPage = async (
  state: CaptureState,
): Promise<CapturedPage> => {
  const { context, allowedOrigins, limitations } = state;
  const { connection, sessionId, input, signal } = context;
  await authorizeObservationWindow(state);
  await captureJsonResponseBodies(state);
  const frameSnapshot = await authorizedMainFrame({
    connection: context.connection,
    sessionId: context.sessionId,
    targetId: context.target.id,
    signal: context.signal,
    allowedOrigins,
    operation: context.operation,
  });
  recordMainFrameLimitation(limitations, frameSnapshot);
  const attachedUrl = frameSnapshot.url ?? "";
  const frameCapture = captureFrames(frameSnapshot.frameTree, allowedOrigins, {
    completeness: state.events.completeness,
    verifiedMainFrameUrl: frameSnapshot.url,
  });
  const frames = frameCapture.items;
  const captureFrame = frames[0];
  if (captureFrame === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  state.events.beginFinalCapture(captureFrame.frame_id);
  const resourceCapture = captureResources(
    await connection.send("Page.getResourceTree", {}, sessionId, signal),
    allowedOrigins,
    state.events.completeness,
  );
  const resources = stableWebResources(
    resourceCapture.items.map(publicResource),
  );
  const dom = await capturePageDom(state);
  const accessibility = await accessibilityForFrames(state, frames);
  const scripts = await captureScripts({
    context,
    events: state.events,
    rawResources: resourceCapture.items,
    resources,
    frameIds: new Set(frames.map((frame) => frame.frame_id)),
  });
  const workers = await captureWorkers(
    { context, allowedOrigins, limitations, events: state.events },
    new Set(frames.map((frame) => frame.frame_id)),
  );
  const storageCapture = await captureStorage(
    context,
    attachedUrl,
    limitations,
  );
  if (!input.include_storage_keys)
    state.events.completeness.exclude("storage_keys", "not_approved", null);
  const completedFrameSnapshot = await authorizedMainFrame({
    connection: context.connection,
    sessionId: context.sessionId,
    targetId: context.target.id,
    signal: context.signal,
    allowedOrigins,
    operation: context.operation,
  });
  recordMainFrameLimitation(limitations, completedFrameSnapshot);
  const completedUrl = completedFrameSnapshot.url ?? "";
  if (state.events.originViolation)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  if (state.events.navigationDuringCapture || completedUrl !== attachedUrl)
    throw new BrowserObservationError("inspect_web_page", "target_changed");
  await report(context.progress, 3, "Normalizing browser evidence");
  state.events.recordScriptMetadataBudgetExclusions();
  return {
    inspection: normalizedInspection(state, {
      attachedUrl,
      frames,
      dom,
      accessibility,
      scripts: scripts.inventory,
      resources,
      workers,
      storage: storageCapture.value,
    }),
    sourceMapRequests: scripts.sourceMapRequests,
  };
};

const captureJsonResponseBodies = async (
  state: CaptureState,
): Promise<void> => {
  const requestIds = state.events.responseBodyRequestIds();
  for (let index = 0; index < requestIds.length; index += 1) {
    const requestId = requestIds[index];
    if (requestId === undefined) continue;
    const request = state.events.network.get(requestId);
    if (request === undefined) continue;
    if (request.encoded_data_length === null) {
      state.events.responseBodyUnavailable(requestId);
      continue;
    }
    let result: unknown;
    try {
      result = await optionalCdpCommand(
        state.context,
        "Network.getResponseBody",
        { requestId },
        state.limitations,
      );
    } catch (cause: unknown) {
      if (
        !(cause instanceof CdpCommandRejection) ||
        cause.command !== "Network.getResponseBody" ||
        cause.code !== -32_000 ||
        cause.reportedMessage === null
      )
        throw cause;
      state.events.responseBodyUnavailable(requestId);
      state.limitations.push(
        `Response body unavailable for request ${requestId}: ${cause.userMessage}`,
      );
      continue;
    }
    if (result !== undefined) {
      state.events.ingestResponseBody(requestId, result);
      continue;
    }
    for (const remaining of requestIds.slice(index))
      state.events.responseBodyUnavailable(remaining);
    return;
  }
};

const authorizeObservationWindow = async (
  state: CaptureState,
): Promise<void> => {
  const { context, allowedOrigins, events } = state;
  const { connection, sessionId, signal } = context;
  await report(context.progress, 1, "Enabling passive CDP domains");
  await connection.send("Page.enable", {}, sessionId, signal);
  const initialFrameResult = await authorizedMainFrame({
    connection: context.connection,
    sessionId: context.sessionId,
    targetId: context.target.id,
    signal: context.signal,
    allowedOrigins,
    operation: context.operation,
  });
  recordMainFrameLimitation(state.limitations, initialFrameResult);
  const mainFrame = captureFrames(
    initialFrameResult.frameTree,
    allowedOrigins,
    { verifiedMainFrameUrl: initialFrameResult.url },
  ).items[0];
  if (mainFrame === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  events.beginAuthorizedFrame(mainFrame.frame_id);
  await enableObservationDomains(connection, sessionId, signal);
  await report(context.progress, 2, "Observing page events");
  await delayWithCancellation(
    context.input.observation_ms,
    context.operation,
    signal,
  );
  if (events.originViolation)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
};

const capturePageDom = async (
  state: CaptureState,
): Promise<ReturnType<typeof captureDom>> => {
  const { context, allowedOrigins } = state;
  const result = await context.connection.send(
    "DOMSnapshot.captureSnapshot",
    {
      computedStyles: [],
      includePaintOrder: false,
      includeDOMRects: false,
    },
    context.sessionId,
    context.signal,
  );
  return captureDom(
    result,
    allowedOrigins,
    context.input,
    state.events.completeness,
  );
};

const normalizedInspection = (
  state: CaptureState,
  captured: CapturedSections,
): WebPageInspection => ({
  browser: state.context.discovery.version,
  target: normalizedTarget(
    state.context.target,
    captured.attachedUrl,
    state.allowedOrigins,
  ),
  capture_window: {
    started_at: state.startedAt,
    ended_at: new Date().toISOString(),
    observation_ms: state.context.input.observation_ms,
  },
  completeness: state.events.completeness.snapshot(),
  frames: [...captured.frames],
  dom: { total_nodes: captured.dom.total, nodes: [...captured.dom.nodes] },
  accessibility: {
    total_nodes: captured.accessibility.total,
    text_capture: captured.accessibility.textCapture,
    nodes: [...captured.accessibility.nodes],
  },
  scripts: captured.scripts,
  resources: [...captured.resources],
  network: {
    requests: [...state.events.network.values()],
    websocket_events: [...state.events.websockets],
    coverage_started_at: state.startedAt,
    prior_activity_available: false,
  },
  console: {
    events: [...state.events.console],
    coverage_started_at: state.startedAt,
    prior_activity_available: false,
  },
  workers: [...captured.workers],
  metadata: {
    responses: [...state.events.responseMetadata],
    dom_urls: [...captured.dom.urls],
    agent_hints: deduplicatedAgentHints([
      ...state.events.agentHints,
      ...captured.dom.agentHints,
    ]),
    excluded_dom_urls: captured.dom.excludedUrls,
    headers_allowlisted: true,
  },
  storage: captured.storage,
  limitations: state.limitations,
});

const enableObservationDomains = async (
  connection: CdpConnection,
  sessionId: string | undefined,
  signal?: AbortSignal,
): Promise<void> => {
  await connection.send("Runtime.enable", {}, sessionId, signal);
  await connection.send("Debugger.enable", {}, sessionId, signal);
  await connection.send("Network.enable", {}, sessionId, signal);
};

const accessibilityForFrames = async (
  state: CaptureState,
  frames: readonly { readonly frame_id: string }[],
): Promise<ReturnType<typeof captureAccessibility>> => {
  const { context, limitations, events } = state;
  const results: unknown[] = [];
  let unavailable = false;
  for (const frame of frames) {
    const result = await optionalCdpCommand(
      context,
      "Accessibility.getFullAXTree",
      { frameId: frame.frame_id },
      limitations,
    );
    if (result === undefined) unavailable = true;
    else results.push(result);
  }
  if (unavailable) events.completeness.unavailable("accessibility");
  const capture = captureAccessibility(results, {
    includeText: context.input.include_accessibility_text,
    ...(results.length === 0 && unavailable ? { unavailable: true } : {}),
  });
  if (!context.input.include_accessibility_text)
    events.completeness.exclude(
      "accessibility",
      "not_approved",
      capture.textCapture.excluded_fields,
    );
  if (capture.treeIncomplete) events.completeness.truncate("accessibility");
  return capture;
};

const publicResource = ({ rawUrl: _rawUrl, ...resource }: CapturedResource) =>
  resource;

const recordMainFrameLimitation = (
  limitations: string[],
  snapshot: CdpMainFrameSnapshot,
): void => {
  if (
    snapshot.urlSource === "target_info" &&
    !limitations.includes(MASKED_MAIN_FRAME_LIMITATION)
  )
    limitations.push(MASKED_MAIN_FRAME_LIMITATION);
};

const deduplicatedAgentHints = (
  hints: WebPageInspection["metadata"]["agent_hints"],
): WebPageInspection["metadata"]["agent_hints"] => {
  const seen = new Set<string>();
  return hints.filter((hint) => {
    const key = `${hint.mechanism}\0${hint.declaration}\0${hint.url ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const normalizedTarget = (
  target: CdpEndpointTarget,
  currentUrl: string,
  allowedOrigins: ReadonlySet<string>,
): WebPageInspection["target"] => {
  const url = allowedSanitizedUrl(currentUrl, allowedOrigins);
  return {
    target_id: target.id,
    type: target.type,
    title: target.title,
    url: url?.url ?? "[unsupported-url]",
    origin: url?.origin ?? "",
    attached: target.attached,
  };
};

const report = async (
  progress: ProgressReporter | undefined,
  completed: number,
  message: string,
): Promise<void> =>
  await progress?.report({
    phase: "browser_observation",
    completed,
    total: 3,
    message,
    ...(completed === 3 ? { terminal: true } : {}),
  });
