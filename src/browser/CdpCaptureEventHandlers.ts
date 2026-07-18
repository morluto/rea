import type { WebPageInspection } from "../domain/browserObservation.js";
import { inferJsonShape } from "../domain/jsonShape.js";
import { safeResponseMetadata } from "./CdpSafeMetadata.js";
import { boundedSensitiveText } from "./SensitiveTextCapture.js";
import {
  allowedSanitizedUrl,
  boundedText,
  isHttpUrl,
  numberValue,
  recordValue,
  recordsValue,
  stringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import { requestBodyShape } from "./CdpCaptureEventBodyShapes.js";
import {
  consolePrimitive,
  decodeBase64,
  exclusionReasonForUrl,
  executionContextKey,
  firstCallFrame,
  initiatorLocation,
  integerOrNull,
} from "./CdpCaptureEventHelpers.js";
import type { CdpCaptureEventsState } from "./CdpCaptureEventState.js";
import type { CapturedScript } from "./CdpCaptureEventTypes.js";

export const handleExecutionContextCreated = (
  state: CdpCaptureEventsState,
  params: UnknownRecord,
): void => {
  const context = recordValue(params.context);
  const identifier = numberValue(context?.id);
  const frameId = stringValue(recordValue(context?.auxData)?.frameId);
  if (
    identifier === undefined ||
    !Number.isSafeInteger(identifier) ||
    frameId === undefined ||
    frameId.length > 256
  )
    return;
  const key = String(identifier);
  if (
    state.executionContextFrames.size >= state.input.limits.max_scripts &&
    !state.executionContextFrames.has(key)
  ) {
    state.completeness.truncate("scripts");
    return;
  }
  state.executionContextFrames.set(key, frameId);
};

export const handleExecutionContextDestroyed = (
  state: CdpCaptureEventsState,
  params: UnknownRecord,
): void => {
  const key = executionContextKey(params.executionContextId);
  if (key !== null) state.executionContextFrames.delete(key);
};

export const handleScriptParsed = (
  state: CdpCaptureEventsState,
  params: UnknownRecord,
): void => {
  const scriptId = stringValue(params.scriptId);
  const rawUrl = stringValue(params.url) ?? "";
  const sanitized = allowedSanitizedUrl(rawUrl, state.allowedOrigins);
  if (scriptId === undefined || scriptId.length > 256) {
    state.completeness.exclude("scripts", "invalid_protocol_value");
    return;
  }
  if (sanitized === undefined) {
    state.completeness.exclude("scripts", exclusionReasonForUrl(rawUrl));
    return;
  }
  if (
    state.scripts.size >= state.input.limits.max_scripts &&
    !state.scripts.has(scriptId)
  ) {
    state.completeness.drop("scripts");
    return;
  }
  const sourceMap = sourceMapForScript(params.sourceMapURL, rawUrl, state);
  const script: CapturedScript = {
    scriptId,
    rawUrl,
    url: sanitized.url,
    origin: sanitized.origin,
    hash: (stringValue(params.hash) ?? "").slice(0, 512),
    length: Math.max(
      0,
      Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.trunc(numberValue(params.length) ?? 0),
      ),
    ),
    isModule: params.isModule === true,
    language: boundedText(params.scriptLanguage, 100),
    sourceMapUrl: sourceMap.sanitized,
    sourceMapRawUrl: sourceMap.raw,
    executionContextKey: executionContextKey(params.executionContextId),
  };
  state.scripts.set(scriptId, script);
};

const sourceMapForScript = (
  value: unknown,
  scriptUrl: string,
  state: CdpCaptureEventsState,
): { readonly sanitized: string | null; readonly raw: string | null } => {
  const declaredUrl = stringValue(value);
  if (declaredUrl === undefined || declaredUrl === "")
    return { sanitized: null, raw: null };
  let rawUrl: string;
  try {
    rawUrl = new URL(declaredUrl, scriptUrl).href;
  } catch {
    state.completeness.exclude("source_maps", "unsupported_url");
    return { sanitized: null, raw: null };
  }
  const sanitized = allowedSanitizedUrl(rawUrl, state.allowedOrigins);
  if (sanitized !== undefined) return { sanitized: sanitized.url, raw: rawUrl };
  state.completeness.exclude("source_maps", exclusionReasonForUrl(rawUrl));
  return { sanitized: null, raw: null };
};

export const handleRequestWillBeSent = (
  state: CdpCaptureEventsState,
  params: UnknownRecord,
): void => {
  const requestId = stringValue(params.requestId);
  const request = recordValue(params.request);
  if (requestId === undefined || requestId.length > 256) {
    state.completeness.exclude("network_requests", "invalid_protocol_value");
    return;
  }
  if (request === undefined) {
    state.completeness.exclude("network_requests", "invalid_protocol_value");
    state.network.delete(requestId);
    return;
  }
  const sanitized = allowedSanitizedUrl(request.url, state.allowedOrigins);
  if (sanitized === undefined) {
    state.completeness.exclude(
      "network_requests",
      exclusionReasonForUrl(stringValue(request.url)),
    );
    state.network.delete(requestId);
    return;
  }
  if (
    state.network.size >= state.input.limits.max_network_events &&
    !state.network.has(requestId)
  ) {
    state.completeness.drop("network_requests");
    return;
  }
  const initiator = recordValue(params.initiator);
  const initiatorFrame = initiatorLocation(initiator);
  const rawInitiatorUrl = stringValue(initiatorFrame?.url);
  const initiatorUrl = allowedSanitizedUrl(
    rawInitiatorUrl,
    state.allowedOrigins,
  );
  if (rawInitiatorUrl !== undefined && initiatorUrl === undefined)
    state.completeness.exclude(
      "network_initiators",
      exclusionReasonForUrl(rawInitiatorUrl),
    );
  state.network.set(requestId, {
    request_id: requestId,
    url: sanitized.url,
    origin: sanitized.origin ?? "",
    method: (stringValue(request.method) ?? "GET").slice(0, 32),
    resource_type: boundedText(params.type, 100),
    status: null,
    mime_type: null,
    encoded_data_length: null,
    initiator: {
      type: (stringValue(initiator?.type) ?? "other").slice(0, 100),
      url: initiatorUrl?.url ?? null,
      line: integerOrNull(initiatorFrame?.lineNumber),
      column: integerOrNull(initiatorFrame?.columnNumber),
    },
    body_shapes: requestBodyShape(state, request),
  });
};

export const handleResponseReceived = (
  state: CdpCaptureEventsState,
  params: UnknownRecord,
): void => {
  const requestId = stringValue(params.requestId);
  if (requestId === undefined || requestId.length > 256) {
    state.completeness.exclude("network_requests", "invalid_protocol_value");
    return;
  }
  const current = state.network.get(requestId);
  const response = recordValue(params.response);
  if (current === undefined) return;
  const sanitized = allowedSanitizedUrl(response?.url, state.allowedOrigins);
  if (response === undefined || sanitized === undefined) {
    state.completeness.exclude(
      "network_requests",
      response === undefined
        ? "invalid_protocol_value"
        : exclusionReasonForUrl(stringValue(response.url)),
    );
    state.network.delete(requestId);
    return;
  }
  state.network.set(requestId, {
    ...current,
    status: numberValue(response.status) ?? null,
    mime_type: boundedText(response.mimeType, 256),
  });
  if (state.responseMetadata.length >= state.input.limits.max_network_events) {
    state.completeness.truncate("metadata");
    return;
  }
  const metadata = safeResponseMetadata(
    requestId,
    sanitized.url,
    response,
    state.allowedOrigins,
  );
  state.responseMetadata.push(metadata.response);
  state.agentHints.push(...metadata.agentHints);
};

export const handleLoadingFinished = (
  state: CdpCaptureEventsState,
  params: UnknownRecord,
): void => {
  const requestId = stringValue(params.requestId);
  if (requestId === undefined || requestId.length > 256) return;
  const current = state.network.get(requestId);
  if (current === undefined) return;
  state.network.set(requestId, {
    ...current,
    encoded_data_length: Math.max(
      0,
      numberValue(params.encodedDataLength) ?? 0,
    ),
  });
};

export const handleConsoleAPICalled = (
  state: CdpCaptureEventsState,
  params: UnknownRecord,
): void => {
  const frame = firstCallFrame(recordValue(params.stackTrace));
  if (frame === undefined) {
    state.completeness.exclude("console_events", "unattributed_origin");
    return;
  }
  const source = allowedSanitizedUrl(frame.url, state.allowedOrigins);
  if (source === undefined) {
    state.completeness.exclude(
      "console_events",
      exclusionReasonForUrl(stringValue(frame.url)),
    );
    return;
  }
  if (state.console.length >= state.input.limits.max_console_events) {
    state.completeness.drop("console_events");
    return;
  }
  const arguments_ = recordsValue(params.args);
  state.console.push({
    type: (stringValue(params.type) ?? "unknown").slice(0, 100),
    timestamp: numberValue(params.timestamp) ?? 0,
    argument_types: arguments_
      .map((argument) =>
        (stringValue(argument.type) ?? "unknown").slice(0, 100),
      )
      .slice(0, 100),
    url: source.url,
    line: integerOrNull(frame.lineNumber),
    column: integerOrNull(frame.columnNumber),
    text_capture: captureConsoleText(state, arguments_),
  });
};

const captureConsoleText = (
  state: CdpCaptureEventsState,
  arguments_: readonly UnknownRecord[],
): WebPageInspection["console"]["events"][number]["text_capture"] => {
  if (!state.input.include_console_text)
    return {
      status: "not_approved",
      values: [],
      retained_bytes: 0,
      truncated_values: 0,
    };
  const values: WebPageInspection["console"]["events"][number]["text_capture"]["values"] =
    [];
  let retainedBytes = 0;
  let truncatedValues = 0;
  for (const [argumentIndex, argument] of arguments_.entries()) {
    const primitive = consolePrimitive(argument);
    if (primitive === undefined) continue;
    const remaining =
      state.input.limits.max_total_console_text_bytes - state.consoleTextBytes;
    if (remaining <= 0) {
      truncatedValues += 1;
      continue;
    }
    const bounded = boundedSensitiveText(
      primitive.text,
      Math.min(state.input.limits.max_console_text_field_bytes, remaining),
    );
    values.push({
      argument_index: argumentIndex,
      type: primitive.type,
      text: bounded.text,
    });
    retainedBytes += bounded.bytes;
    state.consoleTextBytes += bounded.bytes;
    if (bounded.truncated) truncatedValues += 1;
  }
  if (truncatedValues > 0) state.completeness.truncate("console_text");
  return {
    status: truncatedValues > 0 ? "truncated" : "included",
    values,
    retained_bytes: retainedBytes,
    truncated_values: truncatedValues,
  };
};

export const handleWebSocketFrame = (
  state: CdpCaptureEventsState,
  params: UnknownRecord,
  direction: "sent" | "received",
): void => {
  const requestId = stringValue(params.requestId);
  if (
    requestId === undefined ||
    requestId.length > 256 ||
    (!state.network.has(requestId) && !state.allowedWebSockets.has(requestId))
  )
    return;
  if (state.websockets.length >= state.input.limits.max_websocket_events) {
    state.completeness.drop("websocket_frames");
    return;
  }
  const response = recordValue(params.response);
  const payload = stringValue(response?.payloadData) ?? "";
  const opcode = Math.max(0, Math.trunc(numberValue(response?.opcode) ?? 0));
  const decoded = opcode === 1 ? undefined : decodeBase64(payload);
  if (opcode !== 1 && decoded === undefined)
    state.completeness.exclude("websocket_frames", "invalid_protocol_value");
  state.websockets.push({
    request_id: requestId,
    direction,
    opcode,
    payload_bytes:
      opcode === 1 ? Buffer.byteLength(payload) : (decoded?.byteLength ?? 0),
    payload_shape: captureWebSocketShape(state, payload, opcode),
  });
};

const captureWebSocketShape = (
  state: CdpCaptureEventsState,
  payload: string,
  opcode: number,
): WebPageInspection["network"]["websocket_events"][number]["payload_shape"] => {
  if (!state.input.include_websocket_shapes) return null;
  if (opcode !== 1)
    return { format: "binary", json_shape: null, truncated: false };
  const bytes = Buffer.byteLength(payload);
  const remaining =
    state.input.limits.max_total_websocket_shape_bytes -
    state.websocketShapeBytes;
  if (
    bytes > state.input.limits.max_websocket_shape_bytes ||
    bytes > remaining
  ) {
    state.completeness.truncate("websocket_shapes");
    return { format: "text", json_shape: null, truncated: true };
  }
  state.websocketShapeBytes += bytes;
  const shape = inferJsonShape(payload, {
    maximumBytes: state.input.limits.max_websocket_shape_bytes,
    maximumNodes: state.input.limits.max_json_shape_nodes,
    maximumDepth: state.input.limits.max_json_shape_depth,
  });
  if (shape?.truncated === true)
    state.completeness.truncate("websocket_shapes");
  return {
    format: shape === null ? "text" : "json",
    json_shape: shape,
    truncated: shape?.truncated === true,
  };
};

export const handleWebSocketCreated = (
  state: CdpCaptureEventsState,
  params: UnknownRecord,
): void => {
  const requestId = stringValue(params.requestId);
  const rawUrl = stringValue(params.url);
  if (requestId === undefined || requestId.length > 256) {
    state.completeness.exclude(
      "websocket_connections",
      "invalid_protocol_value",
    );
    return;
  }
  if (rawUrl === undefined) {
    state.completeness.exclude(
      "websocket_connections",
      "invalid_protocol_value",
    );
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    state.completeness.exclude("websocket_connections", "unsupported_url");
    return;
  }
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  else if (parsed.protocol === "wss:") parsed.protocol = "https:";
  else {
    state.completeness.exclude("websocket_connections", "unsupported_url");
    return;
  }
  if (!state.allowedOrigins.has(parsed.origin)) {
    state.completeness.exclude("websocket_connections", "disallowed_origin");
    return;
  }
  if (
    !state.allowedWebSockets.has(requestId) &&
    state.allowedWebSockets.size >= state.input.limits.max_websocket_events
  ) {
    state.completeness.drop("websocket_connections");
    return;
  }
  state.allowedWebSockets.add(requestId);
};

export const handleFrameNavigated = (
  state: CdpCaptureEventsState,
  params: UnknownRecord,
): void => {
  const frame = recordValue(params.frame);
  if (stringValue(frame?.id) !== state.mainFrameId) return;
  state.navigationDuringCapture = true;
  const rawUrl = stringValue(frame?.url);
  if (
    isHttpUrl(rawUrl) &&
    allowedSanitizedUrl(rawUrl, state.allowedOrigins) === undefined
  )
    state.originViolation = true;
};
