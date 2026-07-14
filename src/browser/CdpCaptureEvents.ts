import type {
  InspectWebPageInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import { inferJsonShape, type JsonShape } from "../domain/jsonShape.js";
import type { CdpEvent } from "./CdpConnection.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
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

export interface CapturedScript {
  readonly scriptId: string;
  readonly rawUrl: string;
  readonly url: string;
  readonly origin: string | null;
  readonly hash: string;
  readonly length: number;
  readonly isModule: boolean;
  readonly language: string | null;
  readonly sourceMapUrl: string | null;
  readonly sourceMapRawUrl: string | null;
}

type NetworkState = WebPageInspection["network"]["requests"][number];

/** Bounded event accumulator that drops payload values at ingestion time. */
export class CdpCaptureEvents {
  readonly scripts = new Map<string, CapturedScript>();
  readonly network = new Map<string, NetworkState>();
  readonly allowedWebSockets = new Set<string>();
  readonly console: WebPageInspection["console"]["events"] = [];
  readonly websockets: WebPageInspection["network"]["websocket_events"] = [];
  readonly responseMetadata: WebPageInspection["metadata"]["responses"] = [];
  readonly agentHints: WebPageInspection["metadata"]["agent_hints"] = [];
  readonly completeness = new CdpCaptureCompleteness([
    "network_requests",
    "console_events",
    "websocket_connections",
    "websocket_frames",
    "metadata",
  ]);
  originViolation = false;
  navigationDuringCapture = false;
  #mainFrameId: string | undefined;
  #consoleTextBytes = 0;
  #jsonBodyBytes = 0;
  #websocketShapeBytes = 0;

  constructor(
    private readonly input: InspectWebPageInput,
    private readonly allowedOrigins: ReadonlySet<string>,
  ) {}

  beginAuthorizedFrame(frameId: string): void {
    this.#mainFrameId = frameId;
    this.originViolation = false;
    this.navigationDuringCapture = false;
    this.scripts.clear();
    this.network.clear();
    this.allowedWebSockets.clear();
    this.console.length = 0;
    this.websockets.length = 0;
    this.responseMetadata.length = 0;
    this.agentHints.length = 0;
    this.#consoleTextBytes = 0;
    this.#jsonBodyBytes = 0;
    this.#websocketShapeBytes = 0;
    this.completeness.reset();
    if (!this.input.include_console_text)
      this.completeness.exclude("console_text", "not_approved", null);
    if (!this.input.include_json_body_shapes)
      this.completeness.exclude("json_body_shapes", "not_approved", null);
    if (!this.input.include_websocket_shapes)
      this.completeness.exclude("websocket_shapes", "not_approved", null);
  }

  beginFinalCapture(frameId: string): void {
    this.#mainFrameId = frameId;
    this.navigationDuringCapture = false;
  }

  ingest(event: CdpEvent): void {
    const params = recordValue(event.params);
    if (params === undefined) return;
    switch (event.method) {
      case "Debugger.scriptParsed":
        this.#script(params);
        break;
      case "Network.requestWillBeSent":
        this.#request(params);
        break;
      case "Network.responseReceived":
        this.#response(params);
        break;
      case "Network.loadingFinished":
        this.#finished(params);
        break;
      case "Runtime.consoleAPICalled":
        this.#console(params);
        break;
      case "Page.frameNavigated":
        this.#frameNavigated(params);
        break;
      case "Network.webSocketCreated":
        this.#websocketCreated(params);
        break;
      case "Network.webSocketFrameSent":
        this.#websocket(params, "sent");
        break;
      case "Network.webSocketFrameReceived":
        this.#websocket(params, "received");
        break;
    }
  }

  #script(params: UnknownRecord): void {
    const scriptId = stringValue(params.scriptId);
    const rawUrl = stringValue(params.url) ?? "";
    const sanitized = allowedSanitizedUrl(rawUrl, this.allowedOrigins);
    if (scriptId === undefined || scriptId.length > 256) {
      this.completeness.exclude("scripts", "invalid_protocol_value");
      return;
    }
    if (sanitized === undefined) {
      this.completeness.exclude("scripts", exclusionReasonForUrl(rawUrl));
      return;
    }
    if (
      this.scripts.size >= this.input.limits.max_scripts &&
      !this.scripts.has(scriptId)
    ) {
      this.completeness.drop("scripts");
      return;
    }
    const sourceMap = this.#sourceMap(params.sourceMapURL);
    this.scripts.set(scriptId, {
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
    });
  }

  #sourceMap(value: unknown): {
    readonly sanitized: string | null;
    readonly raw: string | null;
  } {
    const rawUrl = stringValue(value);
    if (rawUrl === undefined || rawUrl === "")
      return { sanitized: null, raw: null };
    const sanitized = allowedSanitizedUrl(rawUrl, this.allowedOrigins);
    if (sanitized !== undefined)
      return { sanitized: sanitized.url, raw: rawUrl };
    this.completeness.exclude("source_maps", exclusionReasonForUrl(rawUrl));
    return { sanitized: null, raw: null };
  }

  #request(params: UnknownRecord): void {
    const requestId = stringValue(params.requestId);
    const request = recordValue(params.request);
    if (requestId === undefined || requestId.length > 256) {
      this.completeness.exclude("network_requests", "invalid_protocol_value");
      return;
    }
    if (request === undefined) {
      this.completeness.exclude("network_requests", "invalid_protocol_value");
      this.network.delete(requestId);
      return;
    }
    const sanitized = allowedSanitizedUrl(request.url, this.allowedOrigins);
    if (sanitized === undefined) {
      this.completeness.exclude(
        "network_requests",
        exclusionReasonForUrl(stringValue(request.url)),
      );
      this.network.delete(requestId);
      return;
    }
    if (
      this.network.size >= this.input.limits.max_network_events &&
      !this.network.has(requestId)
    ) {
      this.completeness.drop("network_requests");
      return;
    }
    const initiator = recordValue(params.initiator);
    const initiatorFrame = initiatorLocation(initiator);
    const rawInitiatorUrl = stringValue(initiatorFrame?.url);
    const initiatorUrl = allowedSanitizedUrl(
      rawInitiatorUrl,
      this.allowedOrigins,
    );
    if (rawInitiatorUrl !== undefined && initiatorUrl === undefined)
      this.completeness.exclude(
        "network_initiators",
        exclusionReasonForUrl(rawInitiatorUrl),
      );
    this.network.set(requestId, {
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
      body_shapes: this.#requestBodyShape(request),
    });
  }

  #response(params: UnknownRecord): void {
    const requestId = stringValue(params.requestId);
    if (requestId === undefined || requestId.length > 256) {
      this.completeness.exclude("network_requests", "invalid_protocol_value");
      return;
    }
    const current = this.network.get(requestId);
    const response = recordValue(params.response);
    if (current === undefined) return;
    const sanitized = allowedSanitizedUrl(response?.url, this.allowedOrigins);
    if (response === undefined || sanitized === undefined) {
      this.completeness.exclude(
        "network_requests",
        response === undefined
          ? "invalid_protocol_value"
          : exclusionReasonForUrl(stringValue(response.url)),
      );
      this.network.delete(requestId);
      return;
    }
    this.network.set(requestId, {
      ...current,
      status: numberValue(response.status) ?? null,
      mime_type: boundedText(response.mimeType, 256),
    });
    if (this.responseMetadata.length >= this.input.limits.max_network_events) {
      this.completeness.truncate("metadata");
      return;
    }
    const metadata = safeResponseMetadata(
      requestId,
      sanitized.url,
      response,
      this.allowedOrigins,
    );
    this.responseMetadata.push(metadata.response);
    this.agentHints.push(...metadata.agentHints);
  }

  #finished(params: UnknownRecord): void {
    const requestId = stringValue(params.requestId);
    if (requestId === undefined || requestId.length > 256) return;
    const current = this.network.get(requestId);
    if (current === undefined) return;
    this.network.set(requestId, {
      ...current,
      encoded_data_length: Math.max(
        0,
        numberValue(params.encodedDataLength) ?? 0,
      ),
    });
  }

  #console(params: UnknownRecord): void {
    const frame = firstCallFrame(recordValue(params.stackTrace));
    if (frame === undefined) {
      this.completeness.exclude("console_events", "unattributed_origin");
      return;
    }
    const source = allowedSanitizedUrl(frame.url, this.allowedOrigins);
    if (source === undefined) {
      this.completeness.exclude(
        "console_events",
        exclusionReasonForUrl(stringValue(frame.url)),
      );
      return;
    }
    if (this.console.length >= this.input.limits.max_console_events) {
      this.completeness.drop("console_events");
      return;
    }
    const arguments_ = recordsValue(params.args);
    this.console.push({
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
      text_capture: this.#consoleText(arguments_),
    });
  }

  #websocket(params: UnknownRecord, direction: "sent" | "received"): void {
    const requestId = stringValue(params.requestId);
    if (
      requestId === undefined ||
      requestId.length > 256 ||
      (!this.network.has(requestId) && !this.allowedWebSockets.has(requestId))
    )
      return;
    if (this.websockets.length >= this.input.limits.max_websocket_events) {
      this.completeness.drop("websocket_frames");
      return;
    }
    const response = recordValue(params.response);
    const payload = stringValue(response?.payloadData) ?? "";
    const opcode = Math.max(0, Math.trunc(numberValue(response?.opcode) ?? 0));
    const decoded = opcode === 1 ? undefined : decodeBase64(payload);
    if (opcode !== 1 && decoded === undefined)
      this.completeness.exclude("websocket_frames", "invalid_protocol_value");
    this.websockets.push({
      request_id: requestId,
      direction,
      opcode,
      payload_bytes:
        opcode === 1 ? Buffer.byteLength(payload) : (decoded?.byteLength ?? 0),
      payload_shape: this.#websocketShape(payload, opcode),
    });
  }

  responseBodyRequestIds(): readonly string[] {
    if (!this.input.include_json_body_shapes) return [];
    return [...this.network.values()]
      .filter((request) => isJsonMediaType(request.mime_type))
      .map((request) => request.request_id);
  }

  responseBodyUnavailable(requestId: string): void {
    this.#updateResponseShape(requestId, null, false);
    this.completeness.unavailable("json_body_shapes");
  }

  ingestResponseBody(requestId: string, value: unknown): void {
    const result = recordValue(value);
    const body = stringValue(result?.body);
    if (body === undefined) {
      this.#invalidResponseBody(requestId);
      return;
    }
    const decoded =
      result?.base64Encoded === true
        ? decodeBase64(body)?.toString("utf8")
        : body;
    if (decoded === undefined) {
      this.#invalidResponseBody(requestId);
      return;
    }
    const inferred = this.#inferBodyShape(decoded);
    this.#updateResponseShape(requestId, inferred.shape, inferred.truncated);
  }

  #invalidResponseBody(requestId: string): void {
    this.#updateResponseShape(requestId, null, false);
    this.completeness.exclude("json_body_shapes", "invalid_protocol_value");
  }

  #requestBodyShape(request: UnknownRecord): NetworkState["body_shapes"] {
    if (!this.input.include_json_body_shapes)
      return { status: "not_approved", request: null, response: null };
    const body = stringValue(request.postData);
    if (!isJsonContentType(recordValue(request.headers)) || body === undefined)
      return { status: "unavailable", request: null, response: null };
    const inferred = this.#inferBodyShape(body);
    return {
      status: inferred.truncated
        ? "truncated"
        : inferred.shape === null
          ? "unavailable"
          : "included",
      request: inferred.shape,
      response: null,
    };
  }

  #inferBodyShape(text: string): {
    readonly shape: JsonShape | null;
    readonly truncated: boolean;
  } {
    const bytes = Buffer.byteLength(text);
    const remaining =
      this.input.limits.max_total_json_body_bytes - this.#jsonBodyBytes;
    if (bytes > this.input.limits.max_json_body_bytes || bytes > remaining) {
      this.completeness.truncate("json_body_shapes");
      return { shape: null, truncated: true };
    }
    this.#jsonBodyBytes += bytes;
    const shape = inferJsonShape(text, {
      maximumBytes: this.input.limits.max_json_body_bytes,
      maximumNodes: this.input.limits.max_json_shape_nodes,
      maximumDepth: this.input.limits.max_json_shape_depth,
    });
    if (shape?.truncated === true)
      this.completeness.truncate("json_body_shapes");
    return { shape, truncated: shape?.truncated === true };
  }

  #updateResponseShape(
    requestId: string,
    response: JsonShape | null,
    truncated: boolean,
  ): void {
    const current = this.network.get(requestId);
    if (current === undefined) return;
    const request = current.body_shapes.request;
    const status =
      truncated || current.body_shapes.status === "truncated"
        ? "truncated"
        : response !== null
          ? "included"
          : request !== null
            ? "partial"
            : "unavailable";
    this.network.set(requestId, {
      ...current,
      body_shapes: { status, request, response },
    });
  }

  #consoleText(
    arguments_: readonly UnknownRecord[],
  ): WebPageInspection["console"]["events"][number]["text_capture"] {
    if (!this.input.include_console_text)
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
        this.input.limits.max_total_console_text_bytes - this.#consoleTextBytes;
      if (remaining <= 0) {
        truncatedValues += 1;
        continue;
      }
      const bounded = boundedSensitiveText(
        primitive.text,
        Math.min(this.input.limits.max_console_text_field_bytes, remaining),
      );
      values.push({
        argument_index: argumentIndex,
        type: primitive.type,
        text: bounded.text,
      });
      retainedBytes += bounded.bytes;
      this.#consoleTextBytes += bounded.bytes;
      if (bounded.truncated) truncatedValues += 1;
    }
    if (truncatedValues > 0) this.completeness.truncate("console_text");
    return {
      status: truncatedValues > 0 ? "truncated" : "included",
      values,
      retained_bytes: retainedBytes,
      truncated_values: truncatedValues,
    };
  }

  #websocketShape(
    payload: string,
    opcode: number,
  ): WebPageInspection["network"]["websocket_events"][number]["payload_shape"] {
    if (!this.input.include_websocket_shapes) return null;
    if (opcode !== 1)
      return { format: "binary", json_shape: null, truncated: false };
    const bytes = Buffer.byteLength(payload);
    const remaining =
      this.input.limits.max_total_websocket_shape_bytes -
      this.#websocketShapeBytes;
    if (
      bytes > this.input.limits.max_websocket_shape_bytes ||
      bytes > remaining
    ) {
      this.completeness.truncate("websocket_shapes");
      return { format: "text", json_shape: null, truncated: true };
    }
    this.#websocketShapeBytes += bytes;
    const shape = inferJsonShape(payload, {
      maximumBytes: this.input.limits.max_websocket_shape_bytes,
      maximumNodes: this.input.limits.max_json_shape_nodes,
      maximumDepth: this.input.limits.max_json_shape_depth,
    });
    if (shape?.truncated === true)
      this.completeness.truncate("websocket_shapes");
    return {
      format: shape === null ? "text" : "json",
      json_shape: shape,
      truncated: shape?.truncated === true,
    };
  }

  #websocketCreated(params: UnknownRecord): void {
    const requestId = stringValue(params.requestId);
    const rawUrl = stringValue(params.url);
    if (requestId === undefined || requestId.length > 256) {
      this.completeness.exclude(
        "websocket_connections",
        "invalid_protocol_value",
      );
      return;
    }
    if (rawUrl === undefined) {
      this.completeness.exclude(
        "websocket_connections",
        "invalid_protocol_value",
      );
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      this.completeness.exclude("websocket_connections", "unsupported_url");
      return;
    }
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    else if (parsed.protocol === "wss:") parsed.protocol = "https:";
    else {
      this.completeness.exclude("websocket_connections", "unsupported_url");
      return;
    }
    if (!this.allowedOrigins.has(parsed.origin)) {
      this.completeness.exclude("websocket_connections", "disallowed_origin");
      return;
    }
    if (
      !this.allowedWebSockets.has(requestId) &&
      this.allowedWebSockets.size >= this.input.limits.max_websocket_events
    ) {
      this.completeness.drop("websocket_connections");
      return;
    }
    this.allowedWebSockets.add(requestId);
  }

  #frameNavigated(params: UnknownRecord): void {
    const frame = recordValue(params.frame);
    if (stringValue(frame?.id) !== this.#mainFrameId) return;
    this.navigationDuringCapture = true;
    const rawUrl = stringValue(frame?.url);
    if (
      isHttpUrl(rawUrl) &&
      allowedSanitizedUrl(rawUrl, this.allowedOrigins) === undefined
    )
      this.originViolation = true;
  }
}

const firstCallFrame = (
  value: UnknownRecord | undefined,
): UnknownRecord | undefined => recordsValue(value?.callFrames)[0];

const initiatorLocation = (
  initiator: UnknownRecord | undefined,
): UnknownRecord | undefined => {
  let stack = recordValue(initiator?.stack);
  for (let depth = 0; depth < 32 && stack !== undefined; depth += 1) {
    const frame = firstCallFrame(stack);
    if (frame !== undefined) return frame;
    stack = recordValue(stack.parent);
  }
  return stringValue(initiator?.url) === undefined ? undefined : initiator;
};

const exclusionReasonForUrl = (
  value: string | undefined,
): "disallowed_origin" | "unsupported_url" | "unattributed_origin" =>
  value === undefined || value === ""
    ? "unattributed_origin"
    : isHttpUrl(value)
      ? "disallowed_origin"
      : "unsupported_url";

const integerOrNull = (value: unknown): number | null => {
  const number = numberValue(value);
  return number === undefined ? null : Math.max(0, Math.trunc(number));
};

const isJsonContentType = (headers: UnknownRecord | undefined): boolean => {
  if (headers === undefined) return false;
  for (const [name, value] of Object.entries(headers))
    if (
      name.toLowerCase() === "content-type" &&
      isJsonMediaType(stringValue(value))
    )
      return true;
  return false;
};

const isJsonMediaType = (value: string | null | undefined): boolean => {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" || mediaType?.endsWith("+json") === true
  );
};

const consolePrimitive = (
  value: UnknownRecord,
): { readonly type: string; readonly text: string } | undefined => {
  const type = stringValue(value.type);
  switch (type) {
    case "string":
      return typeof value.value === "string"
        ? { type, text: value.value }
        : undefined;
    case "boolean":
      return typeof value.value === "boolean"
        ? { type, text: String(value.value) }
        : undefined;
    case "number":
      return typeof value.value === "number"
        ? { type, text: String(value.value) }
        : typeof value.unserializableValue === "string"
          ? { type, text: value.unserializableValue }
          : undefined;
    case "bigint":
      return typeof value.unserializableValue === "string"
        ? { type, text: value.unserializableValue }
        : undefined;
    case "undefined":
      return { type, text: "undefined" };
    default:
      return undefined;
  }
};

const BASE64 = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u;

const decodeBase64 = (value: string): Buffer | undefined =>
  value.length % 4 === 0 && BASE64.test(value)
    ? Buffer.from(value, "base64")
    : undefined;
