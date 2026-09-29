import { createServer } from "node:net";

const [socketPath, token, runId, shutdownMode = "acknowledge"] =
  process.argv.slice(2);
const shutdownResult = () => ({
  shutdown: true,
  analysis_stopped: true,
  document_closed: shutdownMode !== "unconfirmed",
  ...(shutdownMode === "cleanup-required" ? { cleanup_required: true } : {}),
});
const capabilityUnavailableResult = (id) => ({
  id,
  error: {
    code: -32000,
    message: "fixture API is unavailable",
    type: "capability_unavailable",
  },
});
const bridgeEventFixtureMessages = (request) => {
  const progress = {
    type: "progress",
    phase: "hopper_bridge",
    completed: 0,
    total: 1,
    message: "Hopper bridge started request",
  };
  switch (request.method) {
    case "wrong_event_id":
      return [{ id: request.id + 100, event: progress }];
    case "malformed_event":
      return [
        {
          id: request.id,
          event: {
            ...progress,
            completed: 2,
            message: "invalid progress",
          },
        },
      ];
    case "remote_error": {
      const error = {
        code: -32001,
        message: "safe fake failure",
        type: "bridge_exception",
      };
      return [
        { id: request.id, event: { type: "diagnostic", error } },
        { id: request.id, error },
      ];
    }
    default:
      return undefined;
  }
};
const enhancedFixtureResult = (method) => {
  switch (method) {
    case "list_segments":
      return [
        {
          name: "__TEXT",
          start: "0x1000",
          end: "0x2000",
          readable: true,
          writable: false,
          executable: true,
        },
      ];
    case "list_documents":
      return ["fixture"];
    case "list_procedures":
      return [{ address: "0x1000", value: "fixture" }];
    case "list_strings":
      return [{ address: "0x1000", value: "fixture" }];
    case "procedure_pseudo_code":
      return "return 0;";
    case "analyze_function": {
      return {
        procedure: {
          address: "0x1000",
          name: "fixture",
          signature: null,
          locals: [],
        },
        pseudocode: "return 0;",
        assembly: ["ret"],
        comments: [],
        callers: [],
        callees: [],
        incoming_references: [],
        outgoing_references: [],
        referenced_strings: [],
        referenced_names: [],
        basic_blocks: [{ start: "0x1000", end: "0x1001", successors: [] }],
      };
    }
    case "search_strings":
    case "search_procedures":
      return [];
    case "xrefs":
      return ["0x1000"];
    default:
      return undefined;
  }
};

const sendEchoWithProgress = (send, request) => {
  send({
    id: request.id,
    event: {
      type: "progress",
      phase: "hopper_bridge",
      completed: 0,
      total: 1,
      message: "Hopper bridge started request",
    },
  });
  setTimeout(() => {
    send({
      id: request.id,
      event: {
        type: "progress",
        phase: "hopper_bridge",
        completed: 1,
        total: 1,
        message: "Hopper bridge completed request",
        terminal: true,
      },
    });
    send({ id: request.id, result: request.params ?? {} });
  }, request.params?.delay ?? 0);
};

const server = createServer((socket) => {
  socket.on("error", () => undefined);
  socket.setEncoding("utf8");
  let buffer = "";
  const send = (message, fragmented = false) => {
    const line = `${JSON.stringify(message)}\n`;
    if (!fragmented) return socket.write(line);
    const midpoint = Math.floor(line.length / 2);
    socket.write(line.slice(0, midpoint));
    setTimeout(() => socket.write(line.slice(midpoint)), 2);
  };
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const request = JSON.parse(buffer.slice(0, newline));
      const bridgeEventMessages = bridgeEventFixtureMessages(request);
      buffer = buffer.slice(newline + 1);
      if (request.token !== token) {
        send({ id: request.id, error: { code: -32001, message: "bad token" } });
      } else if (request.method === "health") {
        send(
          {
            id: request.id,
            result: {
              name: "REA Hopper bridge",
              version: "1.0.0",
              run_id: runId,
            },
          },
          true,
        );
      } else if (
        request.method === "shutdown" ||
        request.method === "shutdown_document"
      ) {
        send({ id: request.id, result: shutdownResult() });
        if (shutdownMode !== "cleanup-required")
          setTimeout(() => server.close(), 2);
      } else if (request.method === "hang") {
        // Deliberately leave the request pending.
      } else if (request.method === "exit") {
        process.exit(7);
      } else if (request.method === "malformed") {
        socket.write("{not-json}\n");
      } else if (request.method === "wrong_id") {
        send({ id: request.id + 100, result: {} });
      } else if (bridgeEventMessages !== undefined) {
        for (const message of bridgeEventMessages) send(message);
      } else if (request.method === "capability_unavailable") {
        send(capabilityUnavailableResult(request.id));
      } else if (request.method === "current_document") {
        send({ id: request.id, result: "fixture" });
      } else if (enhancedFixtureResult(request.method) !== undefined) {
        send({ id: request.id, result: enhancedFixtureResult(request.method) });
      } else if (request.method === "resolve_containing_procedure") {
        send({
          id: request.id,
          result: {
            query_address: request.params.address,
            found: true,
            procedure: { address: "0x1000", name: "fixture" },
          },
        });
      } else if (request.method === "procedure_references") {
        send({
          id: request.id,
          result: {
            procedure: { address: "0x1000", name: "fixture" },
            direction: request.params.direction ?? "outgoing",
            references: [],
          },
        });
      } else {
        sendEchoWithProgress(send, request);
      }
      newline = buffer.indexOf("\n");
    }
  });
});

server.listen(socketPath);
process.on("SIGTERM", () => server.close());
