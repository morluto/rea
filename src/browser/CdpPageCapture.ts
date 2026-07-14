import type {
  InspectWebPageInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import {
  BrowserObservationError,
  type BrowserObservationOperation,
} from "../domain/errors.js";
import {
  reconcileCapturedWebScript,
  stableWebResources,
  stableWebScriptKey,
} from "../domain/webInventory.js";
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
  type CapturedResource,
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
import type { WebSourceMapRequest } from "./WebSourceMapFetcher.js";

interface CaptureContext {
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

interface CapturedScripts {
  readonly inventory: WebPageInspection["scripts"];
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
      "Raw network headers, bodies, cookies, storage values, console objects, and WebSocket payloads are never retained; separately approved captures retain only bounded redacted text or value-free shapes.",
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
  const frameResult = await authorizedFrameTree(context, allowedOrigins);
  const attachedUrl = mainFrameUrl(frameResult) ?? "";
  const frameCapture = captureFrames(
    frameResult,
    allowedOrigins,
    input.limits.max_frames,
    state.events.completeness,
  );
  const frames = frameCapture.items;
  if (frameCapture.total > frames.length)
    state.events.completeness.truncate("frames");
  const captureFrame = frames[0];
  if (captureFrame === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  state.events.beginFinalCapture(captureFrame.frame_id);
  const resourceCapture = captureResources(
    await connection.send("Page.getResourceTree", {}, sessionId, signal),
    allowedOrigins,
    input.limits.max_resources,
    state.events.completeness,
  );
  if (resourceCapture.total > resourceCapture.items.length)
    state.events.completeness.truncate("resources");
  const resources = stableWebResources(
    resourceCapture.items.map(publicResource),
  );
  const dom = await capturePageDom(state);
  if (dom.total > dom.nodes.length) state.events.completeness.truncate("dom");
  const accessibility = await accessibilityForFrames(state, frames);
  if (accessibility.total > accessibility.nodes.length)
    state.events.completeness.truncate("accessibility");
  const scripts = await captureScripts(
    context,
    state.events,
    resourceCapture.items,
    resources,
  );
  const workerCapture = await captureWorkers(
    state,
    new Set(frames.map((frame) => frame.frame_id)),
  );
  if (workerCapture.total > workerCapture.items.length)
    state.events.completeness.truncate("workers");
  const storageCapture = await captureStorage(
    context,
    frames[0]?.origin ?? new URL(attachedUrl).origin,
    limitations,
  );
  if (storageCapture.truncated)
    state.events.completeness.truncate("storage_keys");
  if (!input.include_storage_keys)
    state.events.completeness.exclude("storage_keys", "not_approved", null);
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
  return {
    inspection: normalizedInspection(state, {
      attachedUrl,
      frames,
      dom,
      accessibility,
      scripts: scripts.inventory,
      resources,
      workers: workerCapture.items,
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
    const result = await optionalCdpCommand(
      state.context,
      "Network.getResponseBody",
      { requestId },
      state.limitations,
    );
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
  const initialFrameResult = await authorizedFrameTree(context, allowedOrigins);
  const mainFrame = captureFrames(initialFrameResult, allowedOrigins, 1)
    .items[0];
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
  schema_version: 2,
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
    await delayWithCancellation(25, context.operation, context.signal);
  }
  throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
};

const enableObservationDomains = async (
  connection: CdpConnection,
  sessionId: string | undefined,
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
      { depth: 32, frameId: frame.frame_id },
      limitations,
    );
    if (result === undefined) unavailable = true;
    else results.push(result);
  }
  if (unavailable) events.completeness.unavailable("accessibility");
  const capture = captureAccessibility(
    results,
    context.input.limits.max_ax_nodes,
    {
      includeText: context.input.include_accessibility_text,
      maximumFieldBytes: context.input.limits.max_ax_text_field_bytes,
      maximumTotalBytes: context.input.limits.max_total_ax_text_bytes,
      ...(results.length === 0 && unavailable ? { unavailable: true } : {}),
    },
  );
  if (!context.input.include_accessibility_text)
    events.completeness.exclude(
      "accessibility",
      "not_approved",
      capture.textCapture.excluded_fields,
    );
  if (capture.textCapture.status === "truncated")
    events.completeness.truncate("accessibility");
  return capture;
};

const captureScripts = async (
  context: CaptureContext,
  events: CdpCaptureEvents,
  rawResources: readonly CapturedResource[],
  resources: WebPageInspection["resources"],
): Promise<CapturedScripts> => {
  let totalSourceBytes = 0;
  const drafts: {
    readonly item: Omit<
      WebPageInspection["scripts"]["items"][number],
      "script_key"
    >;
    readonly sourceMapRawUrl: string | null;
  }[] = [];
  for (const script of events.scripts.values()) {
    let source: WebPageInspection["scripts"]["items"][number]["source"] =
      sourceExcluded("source capture was not approved");
    if (context.input.include_script_sources) {
      if (script.length > context.input.limits.max_script_source_bytes) {
        source = sourceExcluded(
          "declared script length exceeds per-script limit",
        );
        events.completeness.truncate("script_sources");
      } else if (
        totalSourceBytes + script.length >
        context.input.limits.max_total_script_source_bytes
      ) {
        source = sourceExcluded("total script source limit reached");
        events.completeness.truncate("script_sources");
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
          events.completeness.truncate("script_sources");
        } else {
          source = sourceResult(content);
          totalSourceBytes += bytes;
        }
      }
    }
    const inventoryScript = {
      url: script.url,
      cdp_hash: script.hash,
      length: script.length,
      is_module: script.isModule,
      language: script.language,
      source_map_url: script.sourceMapUrl,
    };
    drafts.push({
      item: {
        ...inventoryScript,
        origin: script.origin,
        resource_reconciliation: reconcileCapturedWebScript(
          { ...inventoryScript, rawUrl: script.rawUrl },
          rawResources,
          resources,
        ),
        source,
      },
      sourceMapRawUrl: script.sourceMapRawUrl,
    });
  }
  if (!context.input.include_script_sources)
    events.completeness.exclude(
      "script_sources",
      "not_approved",
      events.scripts.size,
    );
  const keyed = drafts.map((draft) => ({
    ...draft,
    base: stableWebScriptKey(draft.item),
  }));
  keyed.sort(
    (left, right) =>
      left.base.localeCompare(right.base) ||
      sourceDigest(left.item.source).localeCompare(
        sourceDigest(right.item.source),
      ),
  );
  const totals = new Map<string, number>();
  for (const { base } of keyed) totals.set(base, (totals.get(base) ?? 0) + 1);
  const seen = new Map<string, number>();
  const sourceMapRequests: WebSourceMapRequest[] = [];
  const items = keyed.map(({ base, item, sourceMapRawUrl }) => {
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const scriptKey =
      totals.get(base) === 1 ? base : `${base}_${String(occurrence)}`;
    if (item.source_map_url !== null && sourceMapRawUrl !== null)
      sourceMapRequests.push({
        scriptKey,
        declaredUrl: item.source_map_url,
        fetchUrl: sourceMapRawUrl,
      });
    return { script_key: scriptKey, ...item };
  });
  return {
    inventory: { total: events.scripts.size, items },
    sourceMapRequests,
  };
};

const sourceDigest = (
  source: WebPageInspection["scripts"]["items"][number]["source"],
): string => (source.included ? source.artifact.sha256 : source.reason);

const publicResource = ({ rawUrl: _rawUrl, ...resource }: CapturedResource) =>
  resource;

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

const captureWorkers = async (
  state: CaptureState,
  frameIds: ReadonlySet<string>,
): Promise<{
  readonly total: number;
  readonly items: WebPageInspection["workers"];
}> => {
  const { context, allowedOrigins, limitations, events } = state;
  const completeness = events.completeness;
  const result = await optionalCdpCommand(
    { ...context, sessionId: undefined },
    "Target.getTargets",
    {},
    limitations,
  );
  const items: WebPageInspection["workers"] = [];
  let total = 0;
  if (result === undefined) completeness.unavailable("workers");
  for (const target of recordsValue(recordValue(result)?.targetInfos)) {
    const type = stringValue(target.type) ?? "";
    const url = allowedSanitizedUrl(target.url, allowedOrigins);
    const relatedToPage =
      stringValue(target.openerId) === context.target.id ||
      (stringValue(target.parentFrameId) !== undefined &&
        frameIds.has(stringValue(target.parentFrameId) ?? ""));
    if (!type.includes("worker")) continue;
    if (!relatedToPage) {
      completeness.exclude("workers", "out_of_target_scope");
      continue;
    }
    if (url === undefined) {
      const rawUrl = stringValue(target.url);
      completeness.exclude(
        "workers",
        rawUrl === undefined || rawUrl === ""
          ? "unattributed_origin"
          : isHttpUrl(rawUrl)
            ? "disallowed_origin"
            : "unsupported_url",
      );
      continue;
    }
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
