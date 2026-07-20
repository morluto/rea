import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket } from "ws";

import type {
  ProcessScenario,
  ProtocolEvent,
} from "../domain/processCapture.js";

/** Minimal recorder boundary shared by the legacy queue replay adapter. */
export interface QueueReplayRecorder {
  readonly scenario: ProcessScenario;
  truncated: boolean;
  atMs(): number;
  record(event: Omit<ProtocolEvent, "sequence">): number | null;
}

export interface QueueHttpRequest {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

/** Execute one request against the existing bounded HTTP response queue. */
export const handleQueueHttp = async (
  input: QueueHttpRequest,
  recorder: QueueReplayRecorder,
  calls: Map<number, number>,
): Promise<void> => {
  const index = recorder.scenario.replay.http.findIndex((route) => {
    if (route.method !== input.method || route.path !== input.path)
      return false;
    if (route.request_body !== undefined && route.request_body !== input.body)
      return false;
    return Object.entries(route.request_headers).every(
      ([name, value]) => input.request.headers[name.toLowerCase()] === value,
    );
  });
  const route = recorder.scenario.replay.http[index];
  const used = index < 0 ? 0 : (calls.get(index) ?? 0);
  const outcome =
    route === undefined
      ? "unmatched"
      : used >= route.max_calls
        ? "script_exhausted"
        : "matched";
  recorder.record({
    at_ms: recorder.atMs(),
    protocol: "http",
    direction: "request",
    method: input.method,
    path: input.path,
    data: input.body.length === 0 ? "" : "<redacted-request-body>",
    outcome,
  });
  if (route === undefined || outcome === "script_exhausted") {
    input.response.statusCode = route === undefined ? 404 : 409;
    input.response.end();
    return;
  }
  calls.set(index, used + 1);
  if (route.delay_ms > 0)
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, route.delay_ms),
    );
  if (route.disconnect) {
    input.response.destroy();
    recorder.record({
      at_ms: recorder.atMs(),
      protocol: "http",
      direction: "response",
      method: input.method,
      path: input.path,
      data: "",
      outcome: "disconnected",
    });
    return;
  }
  input.response.statusCode = route.status;
  for (const [name, value] of Object.entries(route.response_headers))
    input.response.setHeader(name, value);
  input.response.end(route.body);
  recorder.record({
    at_ms: recorder.atMs(),
    protocol: "http",
    direction: "response",
    method: input.method,
    path: input.path,
    data: route.body,
    outcome: "matched",
  });
};

/** Send the existing bounded per-connection WebSocket queue. */
export const sendWebSocketScript = async (
  client: WebSocket,
  connection: number,
  recorder: QueueReplayRecorder,
): Promise<void> => {
  const scripts = recorder.scenario.replay.websocket_connections;
  const script = scripts[connection - 1];
  if (scripts.length > 0 && script === undefined) {
    recorder.record({
      at_ms: recorder.atMs(),
      protocol: "websocket",
      direction: "sent",
      method: null,
      path: "/ws",
      data: "",
      outcome: "script_exhausted",
    });
    client.terminate();
    return;
  }
  const messages =
    script?.messages ??
    recorder.scenario.replay.websocket_messages.map((data) => ({
      data,
      delay_ms: 0,
    }));
  for (const message of messages) {
    if (message.delay_ms > 0)
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, message.delay_ms),
      );
    if (client.readyState !== 1) return;
    client.send(message.data);
    recorder.record({
      at_ms: recorder.atMs(),
      protocol: "websocket",
      direction: "sent",
      method: null,
      path: "/ws",
      data: message.data,
      outcome: "matched",
    });
  }
  if (script?.disconnect_after === true) {
    client.close();
    recorder.record({
      at_ms: recorder.atMs(),
      protocol: "websocket",
      direction: "sent",
      method: null,
      path: "/ws",
      data: "",
      outcome: "disconnected",
    });
  }
};
