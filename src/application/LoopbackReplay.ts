import { createServer, type Server } from "node:http";
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
  close(): Promise<void>;
}

const closeServer = async (server: Server): Promise<void> =>
  new Promise((resolveClose, rejectClose) => {
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error),
    );
  });

/** Start bounded HTTP and WebSocket replay endpoints bound only to IPv4 loopback. */
export const startLoopbackReplay = async (
  scenario: ProcessScenario,
): Promise<LoopbackReplay> => {
  const events: ProtocolEvent[] = [];
  const record = (event: Omit<ProtocolEvent, "sequence">): void => {
    if (events.length < 10_000)
      events.push({ sequence: events.length, ...event });
  };
  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    record({ protocol: "http", direction: "request", method, path, data: "" });
    const route = scenario.replay.http.find(
      (candidate) => candidate.method === method && candidate.path === path,
    );
    response.statusCode = route?.status ?? 404;
    const body = route?.body ?? "";
    response.end(body);
    record({
      protocol: "http",
      direction: "response",
      method,
      path,
      data: body,
    });
  });
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 1_000_000,
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
    client.on("error", () => undefined);
    client.on("message", (value) =>
      record({
        protocol: "websocket",
        direction: "received",
        method: null,
        path: "/ws",
        data: value.toString(),
      }),
    );
    for (const message of scenario.replay.websocket_messages) {
      client.send(message);
      record({
        protocol: "websocket",
        direction: "sent",
        method: null,
        path: "/ws",
        data: message,
      });
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("loopback replay did not acquire a TCP port");
  }
  return {
    httpUrl: `http://127.0.0.1:${String(address.port)}`,
    websocketUrl: `ws://127.0.0.1:${String(address.port)}/ws`,
    events,
    async close() {
      for (const client of websocket.clients) client.terminate();
      await new Promise<void>((resolveClose) =>
        websocket.close(() => resolveClose()),
      );
      await closeServer(server);
    },
  };
};
