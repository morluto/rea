import { rm } from "node:fs/promises";
import { createServer } from "node:net";

const [
  socketPath,
  token,
  runId,
  providerVersion,
  profileDigest,
  mode = "success",
] = process.argv.slice(2);

if (
  socketPath === undefined ||
  token === undefined ||
  runId === undefined ||
  providerVersion === undefined ||
  profileDigest === undefined
) {
  process.exit(64);
}

if (mode === "exit") process.exit(73);
if (mode === "silent") setInterval(() => undefined, 1_000);
else {
  await rm(socketPath, { force: true });
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let pings = 0;
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        const request = JSON.parse(line);
        if (request.token !== token) {
          socket.end(
            `${JSON.stringify({
              id: request.id,
              ok: false,
              error: { code: "auth", message: "Authentication failed" },
            })}\n`,
          );
          continue;
        }
        if (request.method === "ping") {
          pings += 1;
          if (mode === "malformed") {
            socket.write("{invalid\n");
            continue;
          }
          if (mode === "contradictory") {
            socket.write(
              `${JSON.stringify({
                id: request.id,
                ok: false,
                result: { unexpected: true },
                error: { code: "failure", message: "Failed" },
              })}\n`,
            );
            continue;
          }
          if (mode === "oversized_whitespace") {
            socket.write(`${" ".repeat(1024 * 1024 + 1)}\n`);
            continue;
          }
          if (mode === "future_id") {
            socket.write(
              `${JSON.stringify({ id: request.id + 10, ok: true, result: null })}\n`,
            );
            continue;
          }
          if (mode === "hang_after_start" && pings > 1) continue;
          const result = sessionInfo({
            runId,
            providerVersion:
              mode === "wrong_identity" ? "0.0.0" : providerVersion,
            profileDigest,
            timedOut: mode === "analysis_timeout",
          });
          const response = `${JSON.stringify({ id: request.id, ok: true, result })}\n`;
          if (mode === "fragmented") {
            const split = Math.floor(response.length / 2);
            socket.write(response.slice(0, split));
            setTimeout(() => socket.write(response.slice(split)), 5);
          } else socket.write(response);
          continue;
        }
        if (mode === "remote_error" && request.method === "list_procedures") {
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: false,
              error: {
                code: "not_found",
                message: "Unknown Ghidra procedure name",
              },
            })}\n`,
          );
          continue;
        }
        const inventory = inventoryResult(request.method);
        if (inventory !== undefined) {
          socket.write(
            `${JSON.stringify({ id: request.id, ok: true, result: inventory })}\n`,
          );
          continue;
        }
        if (request.method === "shutdown") {
          socket.end(
            `${JSON.stringify({
              id: request.id,
              ok: true,
              result: { shutdown: true, project_ephemeral: true },
            })}\n`,
          );
          server.close(() => process.exit(0));
        }
      }
    });
  });
  server.listen(socketPath);
}

const sessionInfo = ({
  runId: sessionRunId,
  providerVersion: version,
  profileDigest: digest,
  timedOut,
}) => ({
  name: "REA Ghidra bridge",
  bridge_version: 2,
  run_id: sessionRunId,
  profile_digest: digest,
  provider: { id: "ghidra", version },
  read_only: true,
  analysis_complete: !timedOut,
  analysis_timed_out: timedOut,
  capabilities: [
    "ping",
    "shutdown",
    "address_name",
    "list_documents",
    "list_names",
    "list_procedures",
    "list_segments",
    "list_strings",
    "procedure_address",
    "resolve_containing_procedure",
    "search_procedures",
    "search_strings",
  ],
  target: {
    name: "fixture",
    language_id: "x86:LE:64:default",
    compiler_spec_id: "gcc",
    image_base: "0x1000",
    default_address_space: "ram",
  },
});

const inventoryResult = (method) => {
  const page = (items) => ({
    items,
    offset: 0,
    limit: method.startsWith("search_") ? 100 : 500,
    total: items.length,
    next_offset: null,
    has_more: false,
  });
  switch (method) {
    case "address_name":
      return "fixture_main";
    case "list_documents":
      return ["fixture"];
    case "list_names":
      return page([
        {
          address: "0x1000",
          value: "fixture_main",
          value_truncated: false,
          symbol: {
            primary: true,
            dynamic: false,
            external: false,
            type: "function",
            source: "analysis",
          },
        },
      ]);
    case "list_procedures":
      return page([
        {
          address: "0x1000",
          value: "fixture_main",
          value_truncated: false,
          procedure: { external: false, thunk: false, thunk_target: null },
        },
      ]);
    case "list_segments":
      return [
        {
          name: ".text",
          start: "0x1000",
          end: "0x1100",
          readable: true,
          writable: false,
          executable: true,
          permissions: { available: true, source: "ghidra-memory-block" },
          provenance: "ghidra-memory-block",
          address_space: "ram",
          image_base: "0x1000",
          initialized: true,
          overlay: false,
          sections: [],
        },
      ];
    case "list_strings":
      return page([
        {
          address: "0x2000",
          value: "fixture value",
          value_truncated: false,
          string: {
            encoding: "UTF-8",
            termination: "present_or_not_required",
            byte_length: 14,
          },
        },
      ]);
    case "procedure_address":
      return "0x1000";
    case "resolve_containing_procedure":
      return {
        query_address: "0x1001",
        found: true,
        procedure: { address: "0x1000", name: "fixture_main" },
      };
    case "search_procedures":
      return page([
        {
          address: "0x1000",
          value: "fixture_main",
          value_truncated: false,
        },
      ]);
    case "search_strings":
      return page([
        {
          address: "0x2000",
          value: "fixture value",
          value_truncated: false,
        },
      ]);
    default:
      return undefined;
  }
};
