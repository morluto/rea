import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ProcessScenario,
  ProtocolEvent,
} from "../domain/processCapture.js";
import {
  type ReplayMachineDecision,
  type ReplayTransitionRecord,
} from "../domain/replayMachineRuntime.js";
import {
  closeReplayServer,
  listenOnLoopback,
  recordMachineEvent,
  readReplayRequestBody,
  ReplayRecorder,
  requestHeaders,
  waitForReplayDelay,
} from "./LoopbackReplayRecorder.js";

/** Owned loopback replay endpoints and their bounded protocol observations. */
export interface LoopbackReplay {
  readonly httpUrl: string;
  readonly websocketUrl: string;
  readonly events: ProtocolEvent[];
  readonly transitions: readonly ReplayTransitionRecord[];
  readonly truncated: boolean;
  close(): Promise<void>;
}

interface HttpReplayRequest {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly rawAtMs: number;
  readonly recordedAtMs: number;
}

const recordHttpResponse = (
  recorder: ReplayRecorder,
  request: Pick<HttpReplayRequest, "method" | "path">,
  data: string,
  outcome: ProtocolEvent["outcome"],
): void =>
  recorder.record({
    at_ms: recorder.atMs(),
    protocol: "http",
    direction: "response",
    method: request.method,
    path: request.path,
    data,
    outcome,
  });

const handleMachineHttp = async (
  recorder: ReplayRecorder,
  request: HttpReplayRequest,
): Promise<void> => {
  const machine = recorder.machine;
  if (machine === undefined) return;
  const decision = machine.dispatch({
    protocol: "http",
    connection: "not_applicable",
    at_ms: request.rawAtMs,
    recorded_at_ms: request.recordedAtMs,
    method: request.method,
    path: request.path,
    headers: requestHeaders(request.request),
    body: request.body,
  });
  recordMachineEvent(
    recorder,
    {
      at_ms: request.recordedAtMs,
      protocol: "http",
      direction: "request",
      method: request.method,
      path: request.path,
      data: request.body,
    },
    decision,
  );
  if (decision.outcome !== "matched") {
    request.response.statusCode = decision.outcome === "unmatched" ? 404 : 409;
    request.response.end();
    return;
  }
  for (const action of decision.actions) {
    if (action.type === "delay") await waitForReplayDelay(action.duration_ms);
    else if (action.type === "disconnect") {
      request.response.destroy();
      recordHttpResponse(recorder, request, "", "disconnected");
      return;
    } else if (action.type === "http_response") {
      request.response.statusCode = action.status;
      for (const [name, value] of Object.entries(action.headers))
        request.response.setHeader(name, value);
      request.response.end(action.body);
      recordHttpResponse(
        recorder,
        request,
        machine.redact(action.body),
        "matched",
      );
    }
  }
};

const handleStaticHttp = async (
  recorder: ReplayRecorder,
  request: HttpReplayRequest,
  calls: Map<number, number>,
): Promise<void> => {
  const index = recorder.scenario.replay.http.findIndex((route) =>
    route.method !== request.method || route.path !== request.path
      ? false
      : (route.request_body === undefined ||
          route.request_body === request.body) &&
        Object.entries(route.request_headers).every(
          ([name, value]) =>
            request.request.headers[name.toLowerCase()] === value,
        ),
  );
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
    method: request.method,
    path: request.path,
    data: request.body.length === 0 ? "" : "<redacted-request-body>",
    outcome,
  });
  if (route === undefined || outcome === "script_exhausted") {
    request.response.statusCode = route === undefined ? 404 : 409;
    request.response.end();
    return;
  }
  calls.set(index, used + 1);
  if (route.delay_ms > 0) await waitForReplayDelay(route.delay_ms);
  if (route.disconnect) {
    request.response.destroy();
    recordHttpResponse(recorder, request, "", "disconnected");
    return;
  }
  request.response.statusCode = route.status;
  for (const [name, value] of Object.entries(route.response_headers))
    request.response.setHeader(name, value);
  request.response.end(route.body);
  recordHttpResponse(recorder, request, route.body, "matched");
};

const handleHttpRequest = async (
  recorder: ReplayRecorder,
  request: IncomingMessage,
  response: ServerResponse,
  calls: Map<number, number>,
): Promise<void> => {
  const body = await readReplayRequestBody(
    request,
    recorder.scenario.limits.protocol_body_bytes,
  );
  const method = request.method ?? "GET";
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (body === undefined) {
    recorder.truncated = true;
    response.statusCode = 413;
    response.end();
    recorder.record({
      at_ms: recorder.atMs(),
      protocol: "http",
      direction: "request",
      method,
      path,
      data: "<body-over-limit>",
      outcome: "unmatched",
    });
    return;
  }
  const replayRequest = {
    request,
    response,
    method,
    path,
    body,
    rawAtMs: recorder.rawAtMs(),
    recordedAtMs: recorder.atMs(),
  };
  await (recorder.machine === undefined
    ? handleStaticHttp(recorder, replayRequest, calls)
    : recorder.enqueueMachine(() =>
        handleMachineHttp(recorder, replayRequest),
      ));
};

const createHttpHandler = (
  recorder: ReplayRecorder,
): ((request: IncomingMessage, response: ServerResponse) => void) => {
  const calls = new Map<number, number>();
  return (request, response) => {
    void handleHttpRequest(recorder, request, response, calls).catch(() => {
      recorder.truncated = true;
      if (response.headersSent) response.destroy();
      else {
        response.statusCode = 500;
        response.end();
      }
    });
  };
};

const sendWebSocketScript = async (
  client: WebSocket,
  connection: number,
  recorder: ReplayRecorder,
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

const runWebSocketActions = async (
  client: WebSocket,
  recorder: ReplayRecorder,
  decision: Extract<ReplayMachineDecision, { readonly outcome: "matched" }>,
  path: string,
): Promise<void> => {
  for (const action of decision.actions) {
    if (action.type === "delay") {
      await waitForReplayDelay(action.duration_ms);
      continue;
    }
    if (action.type === "disconnect") {
      client.close();
      recorder.record({
        at_ms: recorder.atMs(),
        protocol: "websocket",
        direction: "sent",
        method: null,
        path,
        data: "",
        outcome: "disconnected",
      });
      return;
    }
    if (action.type === "websocket_send" && client.readyState === 1) {
      client.send(action.data);
      recorder.record({
        at_ms: recorder.atMs(),
        protocol: "websocket",
        direction: "sent",
        method: null,
        path,
        data: recorder.machine?.redact(action.data) ?? action.data,
        outcome: "matched",
      });
    }
  }
};

const handleStaticWebSocket = (
  client: WebSocket,
  recorder: ReplayRecorder,
  connection: number,
  path: string,
): void => {
  client.on("message", (value) =>
    recorder.record({
      at_ms: recorder.atMs(),
      protocol: "websocket",
      direction: "received",
      method: null,
      path,
      data: value.toString(),
      outcome: "matched",
    }),
  );
  void sendWebSocketScript(client, connection, recorder);
};

const handleMachineWebSocket = (options: {
  readonly client: WebSocket;
  readonly request: IncomingMessage;
  readonly recorder: ReplayRecorder;
  readonly connection: number;
  readonly path: string;
}): void => {
  const { client, request, recorder, connection, path } = options;
  const machine = recorder.machine;
  if (machine === undefined) return;
  void recorder
    .enqueueMachine(async () => {
      const connectedAt = recorder.atMs();
      const connectionDecision = machine.dispatch({
        protocol: "websocket_connect",
        connection: connection === 1 ? "initial" : "reconnect",
        at_ms: recorder.rawAtMs(),
        recorded_at_ms: connectedAt,
        method: null,
        path,
        headers: requestHeaders(request),
        body: "",
      });
      recordMachineEvent(
        recorder,
        {
          at_ms: connectedAt,
          protocol: "websocket",
          direction: "received",
          method: null,
          path,
          data: "",
        },
        connectionDecision,
      );
      if (connectionDecision.outcome === "matched")
        await runWebSocketActions(client, recorder, connectionDecision, path);
      else client.close();
    })
    .catch(() => {
      recorder.truncated = true;
      client.terminate();
    });
  client.on("message", (value) => {
    const body = value.toString();
    const rawAtMs = recorder.rawAtMs();
    const recordedAtMs = recorder.atMs();
    void recorder
      .enqueueMachine(async () => {
        const decision = machine.dispatch({
          protocol: "websocket_message",
          connection: connection === 1 ? "initial" : "reconnect",
          at_ms: rawAtMs,
          recorded_at_ms: recordedAtMs,
          method: null,
          path,
          headers: {},
          body,
        });
        recordMachineEvent(
          recorder,
          {
            at_ms: recordedAtMs,
            protocol: "websocket",
            direction: "received",
            method: null,
            path,
            data: body,
          },
          decision,
        );
        if (decision.outcome === "matched")
          await runWebSocketActions(client, recorder, decision, path);
      })
      .catch(() => {
        recorder.truncated = true;
        client.terminate();
      });
  });
};

const createWebSocketReplay = (
  server: Server,
  recorder: ReplayRecorder,
): WebSocketServer => {
  let connections = 0;
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: recorder.scenario.limits.protocol_body_bytes,
    clientTracking: true,
  });
  server.on("upgrade", (request, socket, head) => {
    if (
      recorder.machine === undefined &&
      new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/ws"
    ) {
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (client) =>
      websocket.emit("connection", client, request),
    );
  });
  websocket.on("connection", (client: WebSocket, request: IncomingMessage) => {
    connections += 1;
    if (connections > recorder.scenario.limits.connections) {
      recorder.truncated = true;
      client.terminate();
      return;
    }
    client.on("error", () => undefined);
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (recorder.machine === undefined)
      handleStaticWebSocket(client, recorder, connections, path);
    else
      handleMachineWebSocket({
        client,
        request,
        recorder,
        connection: connections,
        path,
      });
  });
  return websocket;
};

/** Start bounded HTTP and WebSocket replay endpoints on IPv4 loopback only. */
export const startLoopbackReplay = async (
  scenario: ProcessScenario,
): Promise<LoopbackReplay> => {
  const recorder = new ReplayRecorder(scenario);
  const server = createServer(createHttpHandler(recorder));
  const websocket = createWebSocketReplay(server, recorder);
  let closePromise: Promise<void> | undefined;
  let port: number;
  try {
    port = await listenOnLoopback(server);
  } catch (cause: unknown) {
    await closeReplayServer(server).catch(() => undefined);
    throw cause;
  }
  return {
    httpUrl: `http://127.0.0.1:${String(port)}`,
    websocketUrl: `ws://127.0.0.1:${String(port)}/ws`,
    get events() {
      return recorder.events.map((event) => ({ ...event }));
    },
    get transitions() {
      return recorder.transitions.map((transition) => ({
        ...transition,
        sensitive_aliases: [...transition.sensitive_aliases],
      }));
    },
    get truncated() {
      return recorder.truncated;
    },
    async close() {
      closePromise ??= (async () => {
        recorder.stopMachineAdmission();
        for (const client of websocket.clients) client.terminate();
        await new Promise<void>((resolveClose) =>
          websocket.close(() => resolveClose()),
        );
        await closeReplayServer(server);
        await recorder.drainMachine();
      })();
      await closePromise;
    },
  };
};
