// Loaded with --import in place of `rea mcp`, so the verifier's real SDK client
// and transport launch and frame a disposable child whose exit timing is authored.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.env.GO_VERIFIER_CHILD_MODE;
const lifetime = setTimeout(() => process.exit(1), 30_000);

if (mode === "ignores-termination") process.on("SIGTERM", () => {});
// Write more than the transport's stderr buffers hold before anything reads it.
if (mode === "noisy-stderr") process.stderr.write("x".repeat(1024 * 1024));

const reply = (message) => {
  if (message.method !== "initialize") return;
  process.stdout.write(
    `${JSON.stringify(
      mode === "refuses-handshake"
        ? {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: "authored handshake refusal" },
          }
        : {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params.protocolVersion,
              capabilities: {},
              serverInfo: { name: "go-verifier-child", version: "1" },
            },
          },
    )}\n`,
  );
};

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (;;) {
    const end = buffered.indexOf("\n");
    if (end === -1) return;
    reply(JSON.parse(buffered.slice(0, end)));
    buffered = buffered.slice(end + 1);
  }
});
process.stdin.on("end", () => {
  if (mode === "ignores-termination") return;
  if (mode === "leaves-pipe-holder") {
    // Exit first, leaving a reparented process that the lineage walk cannot see.
    const { NODE_OPTIONS: _options, ...environment } = process.env;
    const holder = spawn(
      process.execPath,
      ["--eval", "setTimeout(() => {}, 30000)"],
      {
        detached: true,
        env: environment,
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    writeFileSync(join(tmpdir(), "pipe-holder.pid"), String(holder.pid));
    holder.unref();
  }
  clearTimeout(lifetime);
  process.exit(0);
});

// Own the process in place of the entrypoint this module was loaded before.
await new Promise(() => {});
