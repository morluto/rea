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

/** Owned loopback replay endpoints and their bounded protocol observations. */
export interface LoopbackReplay {
  readonly httpUrl: string;
  readonly websocketUrl: string;
  readonly events: ProtocolEvent[];
  readonly truncated: boolean;
  close(): Promise<void>;
}

class ReplayRecorder {
  readonly events: ProtocolEvent[] = [];
  readonly started = Date.now();
  truncated = false;

  constructor(readonly scenario: ProcessScenario) {}

  atMs(): number {
    return (
      Math.floor(
        (Date.now() - this.started) /
          this.scenario.normalization.time_bucket_ms,
      ) * this.scenario.normalization.time_bucket_ms
    );
  }

  record(event: Omit<ProtocolEvent, "sequence">): void {
    if (this.events.length < this.scenario.limits.protocol_events)
      this.events.push({ sequence: this.events.length, ...event });
    else this.truncated = true;
  }
}

const readRequestBody = async (
  request: IncomingMessage,
  limit: number,
): Promise<string | undefined> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > limit) return undefined;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const createHttpHandler = (
  recorder: ReplayRecorder,
): ((request: IncomingMessage, response: ServerResponse) => Promise<void>) => {
  const calls = new Map<number, number>();
  return async (request, response) => {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const body = await readRequestBody(
      request,
      recorder.scenario.limits.protocol_body_bytes,
    );
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
    const index = recorder.scenario.replay.http.findIndex((route) => {
      if (route.method !== method || route.path !== path) return false;
      if (route.request_body !== undefined && route.request_body !== body)
        return false;
      return Object.entries(route.request_headers).every(
        ([name, value]) => request.headers[name.toLowerCase()] === value,
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
      method,
      path,
      data: body.length === 0 ? "" : "<redacted-request-body>",
      outcome,
    });
    if (route === undefined || outcome === "script_exhausted") {
      response.statusCode = route === undefined ? 404 : 409;
      response.end();
      return;
    }
    calls.set(index, used + 1);
    if (route.delay_ms > 0)
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, route.delay_ms),
      );
    if (route.disconnect) {
      response.destroy();
      recorder.record({
        at_ms: recorder.atMs(),
        protocol: "http",
        direction: "response",
        method,
        path,
        data: "",
        outcome: "disconnected",
      });
      return;
    }
    response.statusCode = route.status;
    for (const [name, value] of Object.entries(route.response_headers))
      response.setHeader(name, value);
    response.end(route.body);
    recorder.record({
      at_ms: recorder.atMs(),
      protocol: "http",
      direction: "response",
      method,
      path,
      data: route.body,
      outcome: "matched",
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
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/ws") {
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (client) =>
      websocket.emit("connection", client, request),
    );
  });
  websocket.on("connection", (client: WebSocket) => {
    connections += 1;
    if (connections > recorder.scenario.limits.connections) {
      recorder.truncated = true;
      client.terminate();
      return;
    }
    client.on("error", () => undefined);
    client.on("message", (value) =>
      recorder.record({
        at_ms: recorder.atMs(),
        protocol: "websocket",
        direction: "received",
        method: null,
        path: "/ws",
        data: value.toString(),
        outcome: "matched",
      }),
    );
    void sendWebSocketScript(client, connections, recorder);
  });
  return websocket;
};

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("loopback replay did not acquire a TCP port");
  return address.port;
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, rejectClose) => {
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error),
    );
  });

/** Start bounded HTTP and WebSocket replay endpoints on IPv4 loopback only. */
export const startLoopbackReplay = async (
  scenario: ProcessScenario,
): Promise<LoopbackReplay> => {
  const recorder = new ReplayRecorder(scenario);
  const server = createServer(createHttpHandler(recorder));
  const websocket = createWebSocketReplay(server, recorder);
  let port: number;
  try {
    port = await listen(server);
  } catch (cause: unknown) {
    await closeServer(server).catch(() => undefined);
    throw cause;
  }
  return {
    httpUrl: `http://127.0.0.1:${String(port)}`,
    websocketUrl: `ws://127.0.0.1:${String(port)}/ws`,
    events: recorder.events,
    get truncated() {
      return recorder.truncated;
    },
    async close() {
      for (const client of websocket.clients) client.terminate();
      await new Promise<void>((resolveClose) =>
        websocket.close(() => resolveClose()),
      );
      await closeServer(server);
    },
  };
};
