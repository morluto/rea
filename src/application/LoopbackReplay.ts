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
  ReplayTransitionEvent,
} from "../domain/processCapture.js";
import {
  ReplayMachineRuntime,
  type ReplayMachineDecision,
  type ReplayMachineEvent,
} from "../domain/replayMachineRuntime.js";
import { handleQueueHttp, sendWebSocketScript } from "./LoopbackQueueReplay.js";

/** Owned loopback replay endpoints and their bounded protocol observations. */
export interface LoopbackReplay {
  readonly httpUrl: string;
  readonly websocketUrl: string;
  readonly events: ProtocolEvent[];
  readonly transitions: ReplayTransitionEvent[];
  readonly truncated: boolean;
  close(): Promise<void>;
}

class ReplayRecorder {
  readonly events: ProtocolEvent[] = [];
  readonly transitions: ReplayTransitionEvent[] = [];
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

  record(event: Omit<ProtocolEvent, "sequence">): number | null {
    if (this.events.length >= this.scenario.limits.protocol_events) {
      this.truncated = true;
      return null;
    }
    const sequence = this.events.length;
    this.events.push({ sequence, ...event });
    return sequence;
  }

  recordTransition(
    decision: Extract<ReplayMachineDecision, { readonly outcome: "matched" }>,
    protocolEventSequence: number | null,
  ): void {
    if (protocolEventSequence === null) {
      this.truncated = true;
      return;
    }
    this.transitions.push({
      ...decision.transition,
      at_ms: this.atMs(),
      protocol_event_sequence: protocolEventSequence,
    });
  }
}

class SerializedReplayMachine {
  #tail: Promise<void> = Promise.resolve();

  constructor(readonly runtime: ReplayMachineRuntime) {}

  run<T>(operation: (runtime: ReplayMachineRuntime) => Promise<T>): Promise<T> {
    const result = this.#tail.then(
      () => operation(this.runtime),
      () => operation(this.runtime),
    );
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const requestHeaders = (
  request: IncomingMessage,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) =>
      value === undefined
        ? []
        : [
            [
              name.toLowerCase(),
              Array.isArray(value) ? value.join(", ") : value,
            ],
          ],
    ),
  );

const machineEvent = (
  protocol: ReplayMachineEvent["protocol"],
  path: string,
  body: string,
  connection: ReplayMachineEvent["connection"] = "not_applicable",
  request?: IncomingMessage,
): ReplayMachineEvent => ({
  protocol,
  connection,
  at_ms: 0,
  method: protocol === "http" ? (request?.method ?? "GET") : null,
  path,
  headers: request === undefined ? {} : requestHeaders(request),
  body,
});

const applyHttpActions = async (
  decision: Extract<ReplayMachineDecision, { readonly outcome: "matched" }>,
  response: ServerResponse,
): Promise<{ readonly disconnected: boolean; readonly body: string }> => {
  let body = "";
  for (const action of decision.actions) {
    if (action.type === "delay")
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, action.duration_ms),
      );
    else if (action.type === "disconnect") {
      response.destroy();
      return { disconnected: true, body };
    } else if (action.type === "http_response") {
      response.statusCode = action.status;
      for (const [name, value] of Object.entries(action.headers))
        response.setHeader(name, value);
      body = action.body;
    }
  }
  response.end(body);
  return { disconnected: false, body };
};

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

interface HttpReplayRequest {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

const handleMachineHttp = async (
  input: HttpReplayRequest,
  recorder: ReplayRecorder,
  machine: SerializedReplayMachine,
): Promise<void> =>
  machine.run(async (runtime) => {
    const decision = runtime.dispatch({
      ...machineEvent(
        "http",
        input.path,
        input.body,
        "not_applicable",
        input.request,
      ),
      at_ms: recorder.atMs(),
    });
    const protocolSequence = recorder.record({
      at_ms: recorder.atMs(),
      protocol: "http",
      direction: "request",
      method: input.method,
      path: input.path,
      data: input.body.length === 0 ? "" : "<redacted-request-body>",
      outcome: decision.outcome,
      transition_id: decision.transition?.transition_id ?? null,
      state_before: decision.transition?.state_before ?? runtime.state,
      state_after: decision.transition?.state_after ?? runtime.state,
    });
    if (decision.outcome !== "matched") {
      input.response.statusCode = decision.outcome === "unmatched" ? 404 : 409;
      input.response.end();
      return;
    }
    recorder.recordTransition(decision, protocolSequence);
    const applied = await applyHttpActions(decision, input.response);
    recorder.record({
      at_ms: recorder.atMs(),
      protocol: "http",
      direction: "response",
      method: input.method,
      path: input.path,
      data: runtime.redact(applied.body),
      outcome: applied.disconnected ? "disconnected" : "matched",
      transition_id: decision.transition.transition_id,
      state_before: decision.transition.state_before,
      state_after: decision.transition.state_after,
    });
  });

const createHttpHandler = (
  recorder: ReplayRecorder,
  machine: SerializedReplayMachine | null,
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
    const input = { request, response, method, path, body };
    if (machine === null) await handleQueueHttp(input, recorder, calls);
    else await handleMachineHttp(input, recorder, machine);
  };
};

const applyWebSocketActions = async (
  client: WebSocket,
  decision: Extract<ReplayMachineDecision, { readonly outcome: "matched" }>,
  recorder: ReplayRecorder,
  machine: ReplayMachineRuntime,
): Promise<void> => {
  for (const action of decision.actions) {
    if (action.type === "delay")
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, action.duration_ms),
      );
    else if (action.type === "disconnect") {
      client.close();
      recorder.record({
        at_ms: recorder.atMs(),
        protocol: "websocket",
        direction: "sent",
        method: null,
        path: "/ws",
        data: "",
        outcome: "disconnected",
        transition_id: decision.transition.transition_id,
        state_before: decision.transition.state_before,
        state_after: decision.transition.state_after,
      });
      return;
    } else if (action.type === "websocket_send" && client.readyState === 1) {
      client.send(action.data);
      recorder.record({
        at_ms: recorder.atMs(),
        protocol: "websocket",
        direction: "sent",
        method: null,
        path: "/ws",
        data: machine.redact(action.data),
        outcome: "matched",
        transition_id: decision.transition.transition_id,
        state_before: decision.transition.state_before,
        state_after: decision.transition.state_after,
      });
    }
  }
};

const dispatchWebSocketMachine = async (input: {
  readonly client: WebSocket;
  readonly machine: SerializedReplayMachine;
  readonly recorder: ReplayRecorder;
  readonly protocol: "websocket_connect" | "websocket_message";
  readonly connection: ReplayMachineEvent["connection"];
  readonly body: string;
  readonly request?: IncomingMessage;
}): Promise<void> => {
  const { client, machine, recorder, protocol, connection, body, request } =
    input;
  await machine.run(async (runtime) => {
    const decision = runtime.dispatch({
      ...machineEvent(protocol, "/ws", body, connection, request),
      at_ms: recorder.atMs(),
    });
    const protocolSequence = recorder.record({
      at_ms: recorder.atMs(),
      protocol: "websocket",
      direction: protocol === "websocket_connect" ? "request" : "received",
      method: null,
      path: "/ws",
      data: protocol === "websocket_connect" ? "" : runtime.redact(body),
      outcome: decision.outcome,
      transition_id: decision.transition?.transition_id ?? null,
      state_before: decision.transition?.state_before ?? runtime.state,
      state_after: decision.transition?.state_after ?? runtime.state,
    });
    if (decision.outcome !== "matched") {
      client.close();
      return;
    }
    recorder.recordTransition(decision, protocolSequence);
    await applyWebSocketActions(client, decision, recorder, runtime);
  });
};

const createWebSocketReplay = (
  server: Server,
  recorder: ReplayRecorder,
  machine: SerializedReplayMachine | null,
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
  websocket.on("connection", (client: WebSocket, request: IncomingMessage) => {
    connections += 1;
    if (connections > recorder.scenario.limits.connections) {
      recorder.truncated = true;
      client.terminate();
      return;
    }
    client.on("error", () => undefined);
    if (machine !== null) {
      client.on("message", (value) => {
        void dispatchWebSocketMachine({
          client,
          machine,
          recorder,
          protocol: "websocket_message",
          connection: "not_applicable",
          body: value.toString(),
        });
      });
      void dispatchWebSocketMachine({
        client,
        machine,
        recorder,
        protocol: "websocket_connect",
        connection: connections === 1 ? "initial" : "reconnect",
        body: "",
        request,
      });
      return;
    }
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
  const machine =
    scenario.replay.machine === null
      ? null
      : new SerializedReplayMachine(
          new ReplayMachineRuntime(scenario.replay.machine),
        );
  const server = createServer(createHttpHandler(recorder, machine));
  const websocket = createWebSocketReplay(server, recorder, machine);
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
    transitions: recorder.transitions,
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
