import { createServer } from "node:net";

const [socketPath, token, runId] = process.argv.slice(2);
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
      return {
        items: [{ address: "0x1000", value: "fixture" }],
        offset: 0,
        limit: 500,
        total: 1,
        next_offset: null,
        has_more: false,
      };
    case "list_strings":
      return {
        items: [{ address: "0x1000", value: "fixture" }],
        offset: 0,
        limit: 500,
        total: 1,
        next_offset: null,
        has_more: false,
      };
    case "procedure_pseudo_code":
      return "return 0;";
    case "analyze_function": {
      const empty = () => ({
        items: [],
        total: 0,
        returned: 0,
        truncated: false,
        next_offset: null,
      });
      return {
        procedure: {
          address: "0x1000",
          name: "fixture",
          signature: null,
          locals: [],
        },
        pseudocode: {
          text: "return 0;",
          total_chars: 9,
          returned_chars: 9,
          truncated: false,
          next_offset: null,
        },
        assembly: { ...empty(), items: ["ret"], total: 1, returned: 1 },
        comments: empty(),
        callers: empty(),
        callees: empty(),
        incoming_references: empty(),
        outgoing_references: empty(),
        referenced_strings: empty(),
        referenced_names: empty(),
        basic_blocks: {
          ...empty(),
          items: [{ start: "0x1000", end: "0x1001", successors: [] }],
          total: 1,
          returned: 1,
        },
        instruction_scan: { scanned: 1, truncated: false },
      };
    }
    case "search_strings":
    case "search_procedures":
      return {
        items: [
          { address: "0x1000", value: "fixture", value_truncated: false },
        ],
        offset: 0,
        limit: 100,
        total: 1,
        next_offset: null,
        has_more: false,
      };
    case "xrefs":
      return ["0x1000"];
    default:
      return undefined;
  }
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
      } else if (request.method === "shutdown") {
        send({
          id: request.id,
          result: {
            shutdown: true,
            analysis_stopped: true,
            document_closed: true,
          },
        });
        setTimeout(() => server.close(), 2);
      } else if (request.method === "hang") {
        // Deliberately leave the request pending.
      } else if (request.method === "exit") {
        process.exit(7);
      } else if (request.method === "malformed") {
        socket.write("{not-json}\n");
      } else if (request.method === "wrong_id") {
        send({ id: request.id + 100, result: {} });
      } else if (request.method === "remote_error") {
        send({
          id: request.id,
          error: {
            code: -32001,
            message: "safe fake failure",
            type: "bridge_exception",
          },
        });
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
            references: {
              items: [],
              total: 0,
              returned: 0,
              truncated: false,
              next_offset: null,
            },
            instructions_scanned: 1,
            instruction_scan_truncated: false,
          },
        });
      } else {
        const delay = request.params?.delay ?? 0;
        setTimeout(
          () => send({ id: request.id, result: request.params ?? {} }),
          delay,
        );
      }
      newline = buffer.indexOf("\n");
    }
  });
});

server.listen(socketPath);
process.on("SIGTERM", () => server.close());
