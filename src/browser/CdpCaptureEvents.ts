import type {
  InspectWebPageInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import type { CdpEvent } from "./CdpConnection.js";
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
  readonly url: string;
  readonly origin: string | null;
  readonly hash: string;
  readonly length: number;
  readonly isModule: boolean;
  readonly language: string | null;
  readonly sourceMapUrl: string | null;
}

type NetworkState = WebPageInspection["network"]["requests"][number];

/** Bounded event accumulator that drops payload values at ingestion time. */
export class CdpCaptureEvents {
  readonly scripts = new Map<string, CapturedScript>();
  readonly network = new Map<string, NetworkState>();
  readonly allowedWebSockets = new Set<string>();
  readonly console: WebPageInspection["console"]["events"] = [];
  readonly websockets: WebPageInspection["network"]["websocket_events"] = [];
  dropped = 0;
  originViolation = false;
  navigationDuringCapture = false;
  #mainFrameId: string | undefined;

  constructor(
    private readonly input: InspectWebPageInput,
    private readonly allowedOrigins: ReadonlySet<string>,
  ) {}

  beginAuthorizedFrame(frameId: string): void {
    this.#mainFrameId = frameId;
    this.originViolation = false;
    this.navigationDuringCapture = false;
    this.dropped = 0;
    this.scripts.clear();
    this.network.clear();
    this.allowedWebSockets.clear();
    this.console.length = 0;
    this.websockets.length = 0;
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
    if (
      scriptId === undefined ||
      scriptId.length > 256 ||
      sanitized === undefined
    )
      return;
    if (
      this.scripts.size >= this.input.limits.max_scripts &&
      !this.scripts.has(scriptId)
    ) {
      this.dropped += 1;
      return;
    }
    this.scripts.set(scriptId, {
      scriptId,
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
      sourceMapUrl: this.#sourceMap(params.sourceMapURL),
    });
  }

  #sourceMap(value: unknown): string | null {
    const sanitized = allowedSanitizedUrl(value, this.allowedOrigins);
    return sanitized?.url ?? null;
  }

  #request(params: UnknownRecord): void {
    const requestId = stringValue(params.requestId);
    const request = recordValue(params.request);
    const sanitized = allowedSanitizedUrl(request?.url, this.allowedOrigins);
    if (requestId === undefined || requestId.length > 256) return;
    if (request === undefined || sanitized === undefined) {
      this.network.delete(requestId);
      return;
    }
    if (
      this.network.size >= this.input.limits.max_network_events &&
      !this.network.has(requestId)
    ) {
      this.dropped += 1;
      return;
    }
    const initiator = recordValue(params.initiator);
    const initiatorUrl = allowedSanitizedUrl(
      firstCallFrame(initiator)?.url,
      this.allowedOrigins,
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
        line: integerOrNull(firstCallFrame(initiator)?.lineNumber),
        column: integerOrNull(firstCallFrame(initiator)?.columnNumber),
      },
    });
  }

  #response(params: UnknownRecord): void {
    const requestId = stringValue(params.requestId);
    if (requestId === undefined || requestId.length > 256) return;
    const current = this.network.get(requestId);
    const response = recordValue(params.response);
    const sanitized = allowedSanitizedUrl(response?.url, this.allowedOrigins);
    if (current === undefined) return;
    if (response === undefined || sanitized === undefined) {
      this.network.delete(requestId);
      return;
    }
    this.network.set(requestId, {
      ...current,
      status: numberValue(response.status) ?? null,
      mime_type: boundedText(response.mimeType, 256),
    });
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
    const source = allowedSanitizedUrl(frame?.url, this.allowedOrigins);
    if (frame === undefined || source === undefined) return;
    if (this.console.length >= this.input.limits.max_console_events) {
      this.dropped += 1;
      return;
    }
    this.console.push({
      type: (stringValue(params.type) ?? "unknown").slice(0, 100),
      timestamp: numberValue(params.timestamp) ?? 0,
      argument_types: recordsValue(params.args)
        .map((argument) =>
          (stringValue(argument.type) ?? "unknown").slice(0, 100),
        )
        .slice(0, 100),
      url: source?.url ?? null,
      line: integerOrNull(frame?.lineNumber),
      column: integerOrNull(frame?.columnNumber),
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
      this.dropped += 1;
      return;
    }
    const response = recordValue(params.response);
    const payload = stringValue(response?.payloadData) ?? "";
    this.websockets.push({
      request_id: requestId,
      direction,
      opcode: Math.max(0, Math.trunc(numberValue(response?.opcode) ?? 0)),
      payload_bytes: Buffer.byteLength(payload),
    });
  }

  #websocketCreated(params: UnknownRecord): void {
    const requestId = stringValue(params.requestId);
    const rawUrl = stringValue(params.url);
    if (
      requestId === undefined ||
      requestId.length > 256 ||
      rawUrl === undefined
    )
      return;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return;
    }
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    else if (parsed.protocol === "wss:") parsed.protocol = "https:";
    else return;
    if (
      this.allowedOrigins.has(parsed.origin) &&
      (this.allowedWebSockets.has(requestId) ||
        this.allowedWebSockets.size < this.input.limits.max_websocket_events)
    )
      this.allowedWebSockets.add(requestId);
    else if (this.allowedOrigins.has(parsed.origin)) this.dropped += 1;
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
): UnknownRecord | undefined => {
  const callFrames = recordsValue(value?.callFrames);
  return callFrames[0];
};

const integerOrNull = (value: unknown): number | null => {
  const number = numberValue(value);
  return number === undefined ? null : Math.max(0, Math.trunc(number));
};
