import { rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";

import {
  FAKE_GHIDRA_SHUTDOWN_ACK,
  fakeGhidraAddressNameReply,
  fakeGhidraFileOffsetReply,
  fakeGhidraInventoryReply,
  fakeGhidraSessionInfo,
  fakeGhidraStringItem,
} from "./fakeGhidraReplies.mjs";

const configuration = JSON.parse(
  process.env.REA_GHIDRA_FIXTURE_CONFIG ?? "null",
);
const {
  endpointPath,
  token,
  runId,
  providerVersion,
  profileDigest,
  targetSha256,
  transport,
  mode = "success",
  handshakeReports = {},
} = configuration ?? {};

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

const OOME_LINE =
  "ERROR Abort due to Headless analyzer error: Java heap space (HeadlessAnalyzer) java.lang.OutOfMemoryError: Java heap space\n";
// Exceeds the 8 MiB diagnostic retention budget in many small chunks.
const floodStdout = async () => {
  const line = "INFO  fixture analyzer progress line\n";
  const block = line.repeat(Math.ceil((64 * 1024) / line.length));
  for (let written = 0; written < 10.5 * 1024 * 1024;) {
    if (!process.stdout.write(block))
      await new Promise((resolve) => process.stdout.once("drain", resolve));
    written += block.length;
  }
};

// The retention boundary ends exactly at the class-name prefix of a different identifier.
const cutIdentifierAtBudget = async () => {
  const marker = "java.lang.OutOfMemoryError";
  let remaining = 8 * 1024 * 1024 - marker.length;
  const block = Buffer.alloc(64 * 1024, 0x70);
  while (remaining > 0) {
    const part = block.subarray(0, Math.min(remaining, block.length));
    if (!process.stdout.write(part))
      await new Promise((resolve) => process.stdout.once("drain", resolve));
    remaining -= part.length;
  }
  await new Promise((resolve, reject) =>
    process.stdout.write(`${marker}Custom\n`, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  process.exit(74);
};

const writeThen = (stream, text, then) =>
  stream.write(text, () => setTimeout(then, 10));

if (mode === "remote_error" || mode === "remote_startup_error")
  await new Promise((resolve) =>
    process.stdout.write("Fixture launcher startup output\n", resolve),
  );

let endpointPublication;
if (mode === "exit") process.exit(73);
if (mode === "flood_silent") {
  await floodStdout();
  setInterval(() => undefined, 1_000);
} else if (mode === "silent") setInterval(() => undefined, 1_000);
else {
  await rm(endpointPath, { force: true });
  const sockets = new Set();
  let rejectedConnections = 0;
  const server = createServer((socket) => {
    if (
      mode === "reject_all_connections" ||
      (mode === "reject_first_connection" && rejectedConnections++ === 0)
    ) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    const state = {
      buffer: { value: "" },
      pings: { value: 0 },
      emittedOome: false,
      mode,
      token,
      runId,
      providerVersion,
      profileDigest,
      targetSha256,
    };
    socket.on("data", (chunk) => onSocketData(socket, server, chunk, state));
  });
  process.on("message", (message) => {
    if (message !== "disconnect") return;
    for (const socket of sockets) socket.destroy();
    process.send?.({ event: "disconnected" });
  });
  if (transport === "unix-socket") server.listen(endpointPath);
  else {
    endpointPublication = (async () => {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string") process.exit(65);
      const pending = `${endpointPath}.pending`;
      await writeFile(
        pending,
        `${JSON.stringify({
          host: "127.0.0.1",
          port: address.port,
        })}\n`,
        { flag: "wx" },
      );
      await rename(pending, endpointPath);
    })();
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
    process.send?.({ method: request.method });
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

/** Tool-request failures that follow process output, as the Ghidra JVM prints them. */
const handleOutputFailure = (socket, state) => {
  const oome = () =>
    writeThen(process.stderr, OOME_LINE, () => process.exit(1));
  if (state.mode === "prefix_cut_identifier_exit_tools")
    void cutIdentifierAtBudget();
  else if (state.mode === "oom_exit_tools") oome();
  else if (state.mode === "sigkill_tools")
    writeThen(process.stdout, "WARN Decompiling 14005c790, pcode error\n", () =>
      process.kill(process.pid, "SIGKILL"),
    );
  else if (state.mode === "flood_then_oom_exit_tools")
    void floodStdout().then(oome);
  else if (state.mode === "flood_then_exit_tools")
    void floodStdout().then(() => process.exit(74));
  else if (state.mode === "flood_then_malformed")
    void floodStdout().then(() => socket.write("{invalid\n"));
  else return false;
  return true;
};

const handleRequest = (socket, server, request, state) => {
  if (state.mode.startsWith("checkpoint")) {
    if (request.method === "set_address_name") {
      state.checkpointDirty = true;
      socket.write(
        JSON.stringify({
          id: request.id,
          ok: true,
          result: fakeGhidraAddressNameReply(request.params),
        }) + "\n",
      );
      return;
    }
    if (request.method === "checkpoint_program") {
      void handleCheckpoint(socket, request, state);
      return;
    }
    // A tool that never answers, so a caller is still active during close.
    if (
      state.mode === "checkpoint_hold_close_hang_tool" &&
      request.method === "list_documents"
    )
      return;
  }
  if (request.method === "ping") {
    handlePing(socket, request, state);
    return;
  }
  if (
    ["import_identity_unavailable", "import_identity_mismatch"].includes(
      state.mode,
    ) &&
    request.method !== "shutdown"
  ) {
    socket.write(
      `${JSON.stringify({
        id: request.id,
        ok: false,
        error: {
          code: state.mode,
          message: "Ghidra imported identity admission failed",
        },
      })}\n`,
    );
    return;
  }
  if (
    state.mode === "late_identity_failure" &&
    request.method === "list_strings"
  ) {
    socket.write(
      `${JSON.stringify({
        id: request.id,
        ok: false,
        error: {
          code: "import_identity_mismatch",
          message: "Unexpected later failure",
        },
      })}\n`,
    );
    return;
  }
  if (
    state.mode === "old_oom_then_malformed" &&
    request.method === "list_documents" &&
    !state.emittedOome
  ) {
    state.emittedOome = true;
    process.stderr.write(
      "ERROR Abort due to Headless analyzer error: Java heap space (HeadlessAnalyzer) java.lang.OutOfMemoryError:\n",
      () => setTimeout(() => handleRequest(socket, server, request, state), 10),
    );
    return;
  }
  if (
    state.mode === "old_oom_then_malformed" &&
    request.method === "list_procedures" &&
    state.emittedOome
  ) {
    process.stderr.write("Current operation diagnostic: 雪\n", () =>
      setTimeout(() => socket.write("{invalid\n"), 10),
    );
    return;
  }
  if (state.mode === "remote_error" && request.method === "list_procedures") {
    writeThen(
      process.stdout,
      "Fixture request rejected: missing procedure\n",
      () =>
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: false,
            error: {
              code: "not_found",
              message: "Unknown Ghidra procedure name",
            },
          })}\n`,
        ),
    );
    return;
  }
  if (state.mode === "exit_tools" && request.method !== "shutdown")
    process.exit(74);
  if (
    state.mode === "sigkill_after_first_tool" &&
    request.method !== "shutdown" &&
    (state.toolRequests = (state.toolRequests ?? 0) + 1) > 1
  )
    process.kill(process.pid, "SIGKILL");
  if (request.method !== "shutdown" && handleOutputFailure(socket, state))
    return;
  if (state.mode === "hang_tools" && request.method !== "shutdown") return;
  if (
    state.mode === "unicode_search" &&
    ["search_procedures", "search_strings"].includes(request.method)
  ) {
    const params = request.params;
    const insensitiveLiteral =
      params.mode === "literal" && params.case_sensitive === false;
    // Fixed producer expectations deliberately do not reuse the host derivation.
    const candidates = new Map([
      ["source", "source"],
      ["ſOURCE", "source"],
      ["Σ", null],
    ]);
    const valid = insensitiveLiteral
      ? candidates.has(params.pattern) &&
        Object.hasOwn(params, "literal_ascii_candidate") &&
        params.literal_ascii_candidate === candidates.get(params.pattern)
      : !Object.hasOwn(params, "literal_ascii_candidate");
    if (!valid) {
      socket.write(
        `${JSON.stringify({
          id: request.id,
          ok: false,
          error: {
            code: "invalid_request",
            message: "Literal candidate wire fields drifted",
          },
        })}\n`,
      );
      return;
    }
  }
  // The bridge's per-procedure deadline: only this request fails.
  if (
    state.mode === "decompile_timed_out" &&
    request.method === "procedure_pseudo_code"
  ) {
    socket.write(
      `${JSON.stringify({
        id: request.id,
        ok: false,
        error: {
          code: "decompile_timed_out",
          message:
            "Ghidra decompilation of 0x1000 exceeded the 1-second configured decompilation limit (ghidra.decompile_timeout_seconds; launch seed REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS)",
        },
      })}\n`,
    );
    return;
  }
  if (request.method === "address_to_file_offset") {
    socket.write(
      `${JSON.stringify({ id: request.id, ...fakeGhidraFileOffsetReply(request.params.address) })}\n`,
    );
    return;
  }
  if (["valid_then_invalid", "valid_then_invalid_split"].includes(state.mode)) {
    if (request.method === "list_procedures") return;
    if (request.method === "list_strings") {
      const valid = Buffer.from(
        `${JSON.stringify({ id: request.id, ok: true, result: "completed" })}\n`,
      );
      const invalid = Buffer.concat([
        Buffer.from(`{"id":${request.id + 1},"ok":true,"result":"`),
        Buffer.from([0xff]),
        Buffer.from('"}\n'),
      ]);
      if (state.mode === "valid_then_invalid")
        socket.write(Buffer.concat([valid, invalid]));
      else {
        socket.write(valid);
        setTimeout(() => socket.write(invalid), 5);
      }
      return;
    }
  }
  if (request.method === "list_strings" && state.mode === "valid_utf8_end") {
    socket.end(JSON.stringify({ id: request.id, ok: true, result: "�雪🦊" }));
    return;
  }
  if (request.method === "list_strings" && state.mode === "invalid_utf8_end") {
    socket.end(
      Buffer.concat([
        Buffer.from(`{"id":${request.id},"ok":true,"result":"`),
        Buffer.from([0xe2]),
      ]),
    );
    return;
  }
  if (
    request.method === "list_strings" &&
    state.mode === "invalid_utf8_split"
  ) {
    socket.write(
      Buffer.concat([
        Buffer.from(
          `{"id":${request.id},"ok":true,"result":[{"address":"0x2000","value":"`,
        ),
        Buffer.from([0xe2]),
      ]),
    );
    setTimeout(
      () =>
        socket.write(Buffer.from([0x28, 0xa1, 0x22, 0x7d, 0x5d, 0x7d, 0x0a])),
      5,
    );
    return;
  }
  if (request.method === "list_strings" && state.mode === "invalid_utf8") {
    socket.write(
      Buffer.concat([
        Buffer.from(
          `{"id":${request.id},"ok":true,"result":[{"address":"0x2000","value":"`,
        ),
        Buffer.from([0xff]),
        Buffer.from('"}]}\n'),
      ]),
    );
    return;
  }
  const inventory =
    request.method === "list_strings" && state.mode === "fragmented"
      ? [fakeGhidraStringItem("0x2000", "fixture �雪🦊")]
      : request.method === "list_strings" && state.mode === "oversized_result"
        ? [fakeGhidraStringItem("0x2000", "x".repeat(64 * 1024 * 1024 + 1))]
        : state.mode === "unicode_search" &&
            ["search_procedures", "search_strings"].includes(request.method)
          ? [
              { address: "0x1000", value: "ſource" },
              { address: "0x1001", value: "SOURCE" },
              { address: "0x1002", value: "İource" },
              { address: "0x1003", value: "unrelated" },
            ]
          : fakeGhidraInventoryReply(request.method, request.params);
  if (inventory !== undefined) {
    const response = `${JSON.stringify({ id: request.id, ok: true, result: inventory })}\n`;
    if (state.mode === "fragmented") {
      const bytes = Buffer.from(response, "utf8");
      const unicodeOffset = bytes.indexOf(Buffer.from("雪", "utf8"));
      const midpoint =
        unicodeOffset >= 0 ? unicodeOffset + 1 : Math.floor(bytes.length / 2);
      socket.write(bytes.subarray(0, midpoint));
      setTimeout(() => socket.write(bytes.subarray(midpoint)), 5);
    } else socket.write(response);
    return;
  }
  if (request.method === "shutdown") {
    socket.end(
      `${JSON.stringify({
        id: request.id,
        ...(state.mode === "shutdown_error"
          ? {
              ok: false,
              error: {
                code: "shutdown_fixture_failure",
                message: `Shutdown denied for ${state.token}: /tmp/password-fixture http://localhost/secret?token=public-value`,
              },
            }
          : {
              ok: true,
              result:
                state.mode === "invalid_shutdown_ack"
                  ? { ...FAKE_GHIDRA_SHUTDOWN_ACK, shutdown: false }
                  : FAKE_GHIDRA_SHUTDOWN_ACK,
            }),
      })}\n`,
    );
    server.close(() => process.exit(0));
  }
};

async function handleCheckpoint(socket, request, state) {
  const { path, force } = request.params;
  if (!force && !state.checkpointDirty) {
    socket.write(
      JSON.stringify({ id: request.id, ok: true, result: { saved: false } }) +
        "\n",
    );
    return;
  }
  if (
    !force &&
    state.mode === "checkpoint_fail_close" &&
    !state.failedCheckpoint
  ) {
    state.failedCheckpoint = true;
    await writeFile(path, "controlled incomplete packed Program");
    socket.write(
      JSON.stringify({
        id: request.id,
        ok: false,
        error: {
          code: "checkpoint_failed",
          message: "Controlled checkpoint failure",
        },
      }) + "\n",
    );
    return;
  }
  await writeFile(
    path,
    `fixture checkpoint ${state.checkpointDirty ? "edited" : "initial"}`,
  );
  if (
    (force && state.mode === "checkpoint_hold_startup") ||
    (!force &&
      (state.mode === "checkpoint_hold_close" ||
        state.mode === "checkpoint_hold_close_hang_tool"))
  ) {
    await new Promise((resolve) => {
      const release = (message) => {
        if (message === "release_checkpoint") {
          process.off("message", release);
          resolve();
        }
      };
      process.on("message", release);
      process.send?.({ event: "checkpoint-held" });
    });
  }
  state.checkpointDirty = false;
  socket.write(
    JSON.stringify({
      id: request.id,
      ok: true,
      result: { saved: true, path },
    }) + "\n",
  );
}

const handlePing = (socket, request, state) => {
  if (
    ["import_identity_unavailable", "import_identity_mismatch"].includes(
      state.mode,
    )
  ) {
    socket.write(
      `${JSON.stringify({
        id: request.id,
        ok: false,
        error: {
          code: state.mode,
          message: "Ghidra project identity admission failed",
        },
      })}\n`,
    );
    return;
  }
  if (state.mode === "remote_startup_error") {
    socket.write(
      `${JSON.stringify({
        id: request.id,
        ok: false,
        error: {
          code: "invalid_request",
          message: "Fixture rejected startup handshake",
        },
      })}\n`,
    );
    return;
  }
  state.pings.value += 1;
  if (state.mode === "diagnostic_output" && state.pings.value === 1) {
    const retainedTokenPrefixBytes = Math.floor(state.token.length / 2);
    const preservedMarker = "source=/tmp/local-evidence.bin?cursor=keep&";
    const fillLength = 8 * 1024 * 1024 - retainedTokenPrefixBytes;
    const fill = "x".repeat(fillLength - Buffer.byteLength(preservedMarker));
    process.stderr.write(`${fill}${preservedMarker}`);
    setImmediate(() => {
      process.stderr.write(state.token);
    });
  }
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
  if (state.mode === "future_id") {
    socket.write(
      `${JSON.stringify({ id: request.id + 10, ok: true, result: null })}\n`,
    );
    return;
  }
  if (state.mode === "hang_after_start" && state.pings.value > 1) return;
  const result = {
    ...fakeGhidraSessionInfo({
      runId: state.runId,
      transport,
      providerVersion:
        state.mode === "wrong_identity" ? "0.0.0" : state.providerVersion,
      profileDigest: state.profileDigest,
      targetSha256: state.targetSha256,
      timedOut: state.mode === "analysis_timeout",
    }),
    ...handshakeReports,
  };
  const response = `${JSON.stringify({ id: request.id, ok: true, result })}\n`;
  if (state.mode === "fragmented") {
    const split = Math.floor(response.length / 2);
    socket.write(response.slice(0, split));
    setTimeout(() => socket.write(response.slice(split)), 5);
  } else socket.write(response);
};

await endpointPublication;
