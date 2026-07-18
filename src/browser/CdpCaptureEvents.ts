import type {
  InspectWebPageInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import type { CdpEvent } from "./CdpConnection.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import * as bodyShapes from "./CdpCaptureEventBodyShapes.js";
import type { CdpCaptureEventsState } from "./CdpCaptureEventState.js";
import type { CapturedScript, NetworkState } from "./CdpCaptureEventTypes.js";
import * as handlers from "./CdpCaptureEventHandlers.js";
import { isJsonMediaType } from "./CdpCaptureEventHelpers.js";
import { recordValue } from "./CdpCaptureValues.js";

export { type CapturedScript } from "./CdpCaptureEventTypes.js";

/** Bounded event accumulator that drops payload values at ingestion time. */
export class CdpCaptureEvents implements CdpCaptureEventsState {
  readonly scripts = new Map<string, CapturedScript>();
  readonly executionContextFrames = new Map<string, string>();
  readonly network = new Map<string, NetworkState>();
  readonly allowedWebSockets = new Set<string>();
  console: WebPageInspection["console"]["events"] = [];
  websockets: WebPageInspection["network"]["websocket_events"] = [];
  responseMetadata: WebPageInspection["metadata"]["responses"] = [];
  agentHints: WebPageInspection["metadata"]["agent_hints"] = [];
  readonly completeness = new CdpCaptureCompleteness([
    "network_requests",
    "console_events",
    "websocket_connections",
    "websocket_frames",
    "metadata",
  ]);
  originViolation = false;
  navigationDuringCapture = false;
  mainFrameId: string | undefined = undefined;
  consoleTextBytes = 0;
  jsonBodyBytes = 0;
  websocketShapeBytes = 0;

  readonly input: InspectWebPageInput;
  readonly allowedOrigins: ReadonlySet<string>;

  constructor(input: InspectWebPageInput, allowedOrigins: ReadonlySet<string>) {
    this.input = input;
    this.allowedOrigins = allowedOrigins;
  }

  beginAuthorizedFrame(frameId: string): void {
    this.mainFrameId = frameId;
    this.originViolation = false;
    this.navigationDuringCapture = false;
    this.scripts.clear();
    this.executionContextFrames.clear();
    this.network.clear();
    this.allowedWebSockets.clear();
    this.console.length = 0;
    this.websockets.length = 0;
    this.responseMetadata.length = 0;
    this.agentHints.length = 0;
    this.consoleTextBytes = 0;
    this.jsonBodyBytes = 0;
    this.websocketShapeBytes = 0;
    this.completeness.reset();
    if (!this.input.include_console_text)
      this.completeness.exclude("console_text", "not_approved", null);
    if (!this.input.include_json_body_shapes)
      this.completeness.exclude("json_body_shapes", "not_approved", null);
    if (!this.input.include_websocket_shapes)
      this.completeness.exclude("websocket_shapes", "not_approved", null);
  }

  beginFinalCapture(frameId: string): void {
    this.mainFrameId = frameId;
    this.navigationDuringCapture = false;
  }

  ingest(event: CdpEvent): void {
    const params = recordValue(event.params);
    if (params === undefined) return;
    switch (event.method) {
      case "Runtime.executionContextCreated":
        handlers.handleExecutionContextCreated(this, params);
        break;
      case "Runtime.executionContextDestroyed":
        handlers.handleExecutionContextDestroyed(this, params);
        break;
      case "Runtime.executionContextsCleared":
        this.executionContextFrames.clear();
        break;
      case "Debugger.scriptParsed":
        handlers.handleScriptParsed(this, params);
        break;
      case "Network.requestWillBeSent":
        handlers.handleRequestWillBeSent(this, params);
        break;
      case "Network.responseReceived":
        handlers.handleResponseReceived(this, params);
        break;
      case "Network.loadingFinished":
        handlers.handleLoadingFinished(this, params);
        break;
      case "Runtime.consoleAPICalled":
        handlers.handleConsoleAPICalled(this, params);
        break;
      case "Page.frameNavigated":
        handlers.handleFrameNavigated(this, params);
        break;
      case "Network.webSocketCreated":
        handlers.handleWebSocketCreated(this, params);
        break;
      case "Network.webSocketFrameSent":
        handlers.handleWebSocketFrame(this, params, "sent");
        break;
      case "Network.webSocketFrameReceived":
        handlers.handleWebSocketFrame(this, params, "received");
        break;
    }
  }

  /** Resolve a transient execution context to one already authorized frame. */
  frameForScript(
    script: CapturedScript,
    allowedFrameIds: ReadonlySet<string>,
  ): string | null {
    if (script.executionContextKey === null) return null;
    const frameId = this.executionContextFrames.get(script.executionContextKey);
    return frameId !== undefined && allowedFrameIds.has(frameId)
      ? frameId
      : null;
  }

  responseBodyRequestIds(): readonly string[] {
    if (!this.input.include_json_body_shapes) return [];
    return [...this.network.values()]
      .filter((request) => isJsonMediaType(request.mime_type))
      .map((request) => request.request_id);
  }

  responseBodyUnavailable(requestId: string): void {
    bodyShapes.updateResponseBodyShape(this, requestId, null, false);
    this.completeness.unavailable("json_body_shapes");
  }

  ingestResponseBody(requestId: string, value: unknown): void {
    bodyShapes.ingestResponseBodyShape(this, requestId, value);
  }
}
