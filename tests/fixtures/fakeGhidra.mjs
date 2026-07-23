import { rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";

const [
  endpointPath,
  token,
  runId,
  providerVersion,
  profileDigest,
  targetSha256,
  transport,
  mode = "success",
] = process.argv.slice(2);

if (
  endpointPath === undefined ||
  token === undefined ||
  runId === undefined ||
  providerVersion === undefined ||
  profileDigest === undefined ||
  targetSha256 === undefined ||
  !["unix-socket", "authenticated-loopback-tcp"].includes(transport)
) {
  process.exit(64);
}

if (mode === "exit") process.exit(73);
if (mode === "silent") setInterval(() => undefined, 1_000);
else {
  await rm(endpointPath, { force: true });
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    const state = {
      buffer: { value: "" },
      pings: { value: 0 },
      mode,
      token,
      runId,
      providerVersion,
      profileDigest,
      targetSha256,
    };
    socket.on("data", (chunk) => onSocketData(socket, server, chunk, state));
  });
  if (transport === "unix-socket") server.listen(endpointPath);
  else {
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      if (address === null || typeof address === "string") process.exit(65);
      const pending = `${endpointPath}.pending`;
      await writeFile(
        pending,
        `${JSON.stringify({
          schema_version: 1,
          host: "127.0.0.1",
          port: address.port,
        })}\n`,
        { flag: "wx" },
      );
      await rename(pending, endpointPath);
    });
  }
}

const onSocketData = (socket, server, chunk, state) => {
  state.buffer.value += chunk;
  let newline = state.buffer.value.indexOf("\n");
  while (newline >= 0) {
    const line = state.buffer.value.slice(0, newline);
    state.buffer.value = state.buffer.value.slice(newline + 1);
    newline = state.buffer.value.indexOf("\n");
    const request = JSON.parse(line);
    if (request.token !== state.token) {
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: false,
          error: { code: "auth", message: "Authentication failed" },
        })}\n`,
      );
      continue;
    }
    handleRequest(socket, server, request, state);
  }
};

const handleRequest = (socket, server, request, state) => {
  if (request.method === "ping") {
    handlePing(socket, request, state);
    return;
  }
  if (state.mode === "remote_error" && request.method === "list_procedures") {
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
    return;
  }
  if (state.mode === "exit_tools" && request.method !== "shutdown")
    process.exit(74);
  if (state.mode === "hang_tools" && request.method !== "shutdown") return;
  const inventory = inventoryResultFor(request.method);
  if (inventory !== undefined) {
    socket.write(
      `${JSON.stringify({ id: request.id, ok: true, result: inventory })}\n`,
    );
    return;
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
};

const handlePing = (socket, request, state) => {
  state.pings.value += 1;
  if (state.mode === "malformed") {
    socket.write("{invalid\n");
    return;
  }
  if (state.mode === "contradictory") {
    socket.write(
      `${JSON.stringify({
        id: request.id,
        ok: false,
        result: { unexpected: true },
        error: { code: "failure", message: "Failed" },
      })}\n`,
    );
    return;
  }
  if (state.mode === "oversized_whitespace") {
    socket.write(`${" ".repeat(1024 * 1024 + 1)}\n`);
    return;
  }
  if (state.mode === "future_id") {
    socket.write(
      `${JSON.stringify({ id: request.id + 10, ok: true, result: null })}\n`,
    );
    return;
  }
  if (state.mode === "hang_after_start" && state.pings.value > 1) return;
  const result = sessionInfo({
    runId: state.runId,
    providerVersion:
      state.mode === "wrong_identity" ? "0.0.0" : state.providerVersion,
    profileDigest: state.profileDigest,
    targetSha256: state.targetSha256,
    timedOut: state.mode === "analysis_timeout",
  });
  const response = `${JSON.stringify({ id: request.id, ok: true, result })}\n`;
  if (state.mode === "fragmented") {
    const split = Math.floor(response.length / 2);
    socket.write(response.slice(0, split));
    setTimeout(() => socket.write(response.slice(split)), 5);
  } else socket.write(response);
};

const sessionInfo = ({
  runId: sessionRunId,
  providerVersion: version,
  profileDigest: digest,
  targetSha256: sha256,
  timedOut,
}) => ({
  name: "REA Ghidra bridge",
  bridge_version: 5,
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
    "analyze_function",
    "procedure_assembly",
    "procedure_callees",
    "procedure_callers",
    "procedure_info",
    "procedure_pseudo_code",
    "read_function_instructions",
    "procedure_references",
    "xrefs",
  ],
  target: {
    name: "fixture",
    language_id: "x86:LE:64:default",
    compiler_spec_id: "gcc",
    image_base: "0x1000",
    default_address_space: "ram",
    sha256,
  },
});

const inventoryResultFor = (method) => {
  switch (method) {
    case "address_name":
      return "fixture_main";
    case "list_documents":
      return ["fixture"];
    case "list_names":
      return page(method, [nameItem()]);
    case "list_procedures":
      return page(method, [procedureItem()]);
    case "list_segments":
      return [segmentItem()];
    case "list_strings":
      return page(method, [stringItem("0x2000", "fixture value")]);
    case "procedure_address":
      return "0x1000";
    case "resolve_containing_procedure":
      return containingProcedureResult();
    case "search_procedures":
      return page(method, [procedureSearchItem()]);
    case "search_strings":
      return page(method, [stringSearchItem()]);
    default:
      return undefined;
  }
};

const page = (method, items) => ({
  items,
  offset: 0,
  limit: method.startsWith("search_") ? 100 : 500,
  total: items.length,
  next_offset: null,
  has_more: false,
});

const nameItem = () => ({
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
});

const procedureItem = () => ({
  address: "0x1000",
  value: "fixture_main",
  value_truncated: false,
  procedure: { external: false, thunk: false, thunk_target: null },
});

const segmentItem = () => ({
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
});

const stringItem = (address, value) => ({
  address,
  value,
  value_truncated: false,
  string: {
    encoding: "UTF-8",
    termination: "present_or_not_required",
    byte_length: value.length + 1,
  },
});

const containingProcedureResult = () => ({
  query_address: "0x1001",
  found: true,
  procedure: {
    address: "0x1000",
    name: "fixture_main",
    classification: {
      external: false,
      thunk: false,
      thunk_target: null,
      provenance: "ghidra-function-manager",
    },
  },
});

const procedureSearchItem = () => ({
  address: "0x1000",
  value: "fixture_main",
  value_truncated: false,
});

const stringSearchItem = () => ({
  address: "0x2000",
  value: "fixture value",
  value_truncated: false,
});
