import type {
  InspectWebPageInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import { BrowserObservationError } from "../domain/errors.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import { CdpConnection } from "./CdpConnection.js";
import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import { captureStorage } from "./CdpCaptureStorage.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import {
  captureAccessibility,
  captureDom,
  captureFrames,
  captureResources,
  mainFrameUrl,
} from "./CdpCaptureDocuments.js";
import {
  allowedSanitizedUrl,
  delayWithCancellation,
  isHttpUrl,
  recordValue,
  recordsValue,
  requiredRecord,
  sourceExcluded,
  sourceResult,
  stringValue,
} from "./CdpCaptureValues.js";

interface CaptureContext {
  readonly connection: CdpConnection;
  readonly sessionId: string;
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
  readonly truncatedSections: Set<string>;
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

/** Capture and normalize one attached page without evaluating page JavaScript. */
export const capturePage = async (
  context: CaptureContext,
): Promise<WebPageInspection> => {
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
      "Network headers, request bodies, response bodies, cookies, storage values, console values, and WebSocket payloads are not retained.",
      "Source maps are reported only as declarative URLs and are not fetched.",
      "URL-less scripts and console events without an allowed source URL are excluded because their origin cannot be proven.",
    ],
    truncatedSections: new Set<string>(),
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
): Promise<WebPageInspection> => {
  const { context, allowedOrigins, limitations, truncatedSections } = state;
  const { connection, sessionId, input, signal } = context;
  await authorizeObservationWindow(state);
  const frameResult = await authorizedFrameTree(context, allowedOrigins);
  const attachedUrl = mainFrameUrl(frameResult) ?? "";
  const frameCapture = captureFrames(
    frameResult,
    allowedOrigins,
    input.limits.max_frames,
  );
  const frames = frameCapture.items;
  if (frameCapture.total > frames.length) truncatedSections.add("frames");
  const captureFrame = frames[0];
  if (captureFrame === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  state.events.beginFinalCapture(captureFrame.frame_id);
  const resourceCapture = captureResources(
    await connection.send("Page.getResourceTree", {}, sessionId, signal),
    allowedOrigins,
    input.limits.max_resources,
  );
  if (resourceCapture.total > resourceCapture.items.length)
    truncatedSections.add("resources");
  const dom = await capturePageDom(state);
  if (dom.total > dom.nodes.length) truncatedSections.add("dom");
  const accessibility = await accessibilityForFrames(
    context,
    frames,
    limitations,
  );
  if (accessibility.total > accessibility.nodes.length)
    truncatedSections.add("accessibility");
  const scripts = await captureScripts(
    context,
    state.events,
    truncatedSections,
  );
  const workerCapture = await captureWorkers(
    context,
    allowedOrigins,
    limitations,
  );
  if (workerCapture.total > workerCapture.items.length)
    truncatedSections.add("workers");
  const storageCapture = await captureStorage(
    context,
    frames[0]?.origin ?? new URL(attachedUrl).origin,
    limitations,
  );
  if (storageCapture.truncated) truncatedSections.add("storage_keys");
  if (state.events.dropped > 0) truncatedSections.add("events");
  const completedFrameResult = await authorizedFrameTree(
    context,
    allowedOrigins,
  );
  const completedUrl = mainFrameUrl(completedFrameResult) ?? "";
  if (state.events.originViolation)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  if (state.events.navigationDuringCapture || completedUrl !== attachedUrl)
    throw new BrowserObservationError("inspect_web_page", "target_changed");
  await report(context.progress, 3, "Normalizing browser evidence");
  return normalizedInspection(state, {
    attachedUrl,
    frames,
    dom,
    accessibility,
    scripts,
    resources: resourceCapture.items,
    workers: workerCapture.items,
    storage: storageCapture.value,
  });
};

const authorizeObservationWindow = async (
  state: CaptureState,
): Promise<void> => {
  const { context, allowedOrigins, events } = state;
  const { connection, sessionId, signal } = context;
  await report(context.progress, 1, "Enabling passive CDP domains");
  await connection.send("Page.enable", {}, sessionId, signal);
  const initialFrameResult = await authorizedFrameTree(context, allowedOrigins);
  const mainFrame = captureFrames(initialFrameResult, allowedOrigins, 1)
    .items[0];
  if (mainFrame === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  events.beginAuthorizedFrame(mainFrame.frame_id);
  await enableObservationDomains(connection, sessionId, signal);
  await report(context.progress, 2, "Observing page events");
  await delayWithCancellation(context.input.observation_ms, signal);
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
  return captureDom(result, allowedOrigins, context.input);
};

const normalizedInspection = (
  state: CaptureState,
  captured: CapturedSections,
): WebPageInspection => ({
  schema_version: 1,
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
  completeness: {
    status: state.truncatedSections.size === 0 ? "complete" : "truncated",
    truncated_sections: [...state.truncatedSections].sort(),
    dropped_events: state.events.dropped,
  },
  frames: [...captured.frames],
  dom: { total_nodes: captured.dom.total, nodes: [...captured.dom.nodes] },
  accessibility: {
    total_nodes: captured.accessibility.total,
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
  storage: captured.storage,
  limitations: state.limitations,
});

const authorizedFrameTree = async (
  context: CaptureContext,
  allowedOrigins: ReadonlySet<string>,
): Promise<unknown> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await context.connection.send(
      "Page.getFrameTree",
      {},
      context.sessionId,
      context.signal,
    );
    const currentUrl = mainFrameUrl(result);
    if (allowedSanitizedUrl(currentUrl, allowedOrigins) !== undefined)
      return result;
    if (isHttpUrl(currentUrl))
      throw new BrowserObservationError(
        "inspect_web_page",
        "target_not_allowed",
      );
    await delayWithCancellation(25, context.signal);
  }
  throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
};

const enableObservationDomains = async (
  connection: CdpConnection,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> => {
  await connection.send("Runtime.enable", {}, sessionId, signal);
  await connection.send(
    "Debugger.enable",
    { maxScriptsCacheSize: 4 * 1_024 * 1_024 },
    sessionId,
    signal,
  );
  await connection.send(
    "Network.enable",
    {
      maxTotalBufferSize: 4 * 1_024 * 1_024,
      maxResourceBufferSize: 1_024 * 1_024,
    },
    sessionId,
    signal,
  );
};

const accessibilityForFrames = async (
  context: CaptureContext,
  frames: readonly { readonly frame_id: string }[],
  limitations: string[],
): Promise<ReturnType<typeof captureAccessibility>> => {
  const nodes: WebPageInspection["accessibility"]["nodes"] = [];
  let total = 0;
  for (const frame of frames) {
    const result = await optionalCdpCommand(
      context,
      "Accessibility.getFullAXTree",
      { depth: 32, frameId: frame.frame_id },
      limitations,
    );
    if (result === undefined) continue;
    const capture = captureAccessibility(
      [result],
      Math.max(0, context.input.limits.max_ax_nodes - nodes.length),
    );
    total += capture.total;
    nodes.push(...capture.nodes);
  }
  return { total, nodes };
};

const captureScripts = async (
  context: CaptureContext,
  events: CdpCaptureEvents,
  truncatedSections: Set<string>,
): Promise<WebPageInspection["scripts"]> => {
  let totalSourceBytes = 0;
  const items: WebPageInspection["scripts"]["items"] = [];
  for (const script of events.scripts.values()) {
    let source: WebPageInspection["scripts"]["items"][number]["source"] =
      sourceExcluded("source capture was not approved");
    if (context.input.include_script_sources) {
      if (script.length > context.input.limits.max_script_source_bytes) {
        source = sourceExcluded(
          "declared script length exceeds per-script limit",
        );
        truncatedSections.add("script_sources");
      } else if (
        totalSourceBytes + script.length >
        context.input.limits.max_total_script_source_bytes
      ) {
        source = sourceExcluded("total script source limit reached");
        truncatedSections.add("script_sources");
      } else {
        const result = requiredRecord(
          await context.connection.send(
            "Debugger.getScriptSource",
            { scriptId: script.scriptId },
            context.sessionId,
            context.signal,
          ),
        );
        const content = stringValue(result.scriptSource) ?? "";
        const bytes = Buffer.byteLength(content);
        if (
          bytes > context.input.limits.max_script_source_bytes ||
          totalSourceBytes + bytes >
            context.input.limits.max_total_script_source_bytes
        ) {
          source = sourceExcluded(
            "actual source exceeds configured byte limits",
          );
          truncatedSections.add("script_sources");
        } else {
          source = sourceResult(content);
          totalSourceBytes += bytes;
        }
      }
    }
    items.push({
      script_id: script.scriptId,
      url: script.url,
      origin: script.origin,
      cdp_hash: script.hash,
      length: script.length,
      is_module: script.isModule,
      language: script.language,
      source_map_url: script.sourceMapUrl,
      source,
    });
  }
  return { total: events.scripts.size, items };
};

const captureWorkers = async (
  context: CaptureContext,
  allowedOrigins: ReadonlySet<string>,
  limitations: string[],
): Promise<{
  readonly total: number;
  readonly items: WebPageInspection["workers"];
}> => {
  const result = await optionalCdpCommand(
    { ...context, sessionId: undefined },
    "Target.getTargets",
    {},
    limitations,
  );
  const items: WebPageInspection["workers"] = [];
  let total = 0;
  for (const target of recordsValue(recordValue(result)?.targetInfos)) {
    const type = stringValue(target.type) ?? "";
    const url = allowedSanitizedUrl(target.url, allowedOrigins);
    if (!type.includes("worker") || url === undefined) continue;
    total += 1;
    if (items.length >= context.input.limits.max_workers) continue;
    items.push({
      target_id: (stringValue(target.targetId) ?? "").slice(0, 256),
      type: type.slice(0, 100),
      url: url.url,
      origin: url.origin,
      attached: target.attached === true,
    });
  }
  return {
    total,
    items,
  };
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
    title: target.title.slice(0, 16_384),
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
