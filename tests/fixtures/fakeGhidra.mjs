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
  bridge_version: 1,
  run_id: sessionRunId,
  profile_digest: digest,
  provider: { id: "ghidra", version },
  read_only: true,
  analysis_complete: !timedOut,
  analysis_timed_out: timedOut,
  capabilities: ["ping", "shutdown"],
  target: {
    name: "fixture",
    language_id: "x86:LE:64:default",
    compiler_spec_id: "gcc",
  },
});
