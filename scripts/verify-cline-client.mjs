import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

/**
 * Verifies REA's Cline registration against an installed Cline CLI, in an
 * isolated HOME that REA itself configures.
 *
 * Covered: REA writes the entry; Cline's own CLI parses that file and lists
 * the server; the exact command and args Cline would spawn complete an MCP
 * handshake with a non-empty tool inventory.
 *
 * Not covered: a model-driven tool call inside Cline. Cline's provider
 * configuration (`providers.json`) is versioned and auth-shaped, so pointing
 * it at the loopback model fixture is not part of this lane. See
 * docs/development/client-verification.md.
 */

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("..", import.meta.url));
const command = process.env.REA_VERIFY_CLINE_COMMAND ?? "cline";
const reaEntry = join(repo, "scripts/rea.mjs");
const node = process.execPath;
const run = createVerifierRun();
const lab = await mkdtemp(join(tmpdir(), "rea-cline-client-"));
const home = join(lab, "home");
const dataDirectory = join(home, ".cline", "data");
const configPath = join(dataDirectory, "settings", "cline_mcp_settings.json");
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  // REA gives CLINE_MCP_SETTINGS_PATH precedence over HOME, so an inherited
  // value would make setup rewrite the caller's real Cline configuration and
  // leave this sandbox empty. Bind it to the sandbox explicitly.
  CLINE_MCP_SETTINGS_PATH: configPath,
  HOPPER_LAUNCHER_PATH: join(lab, "missing-hopper"),
  GHIDRA_INSTALL_DIR: join(lab, "missing-ghidra"),
  JAVA_HOME: join(lab, "missing-java"),
};
const isolatedOverrides = ["CLINE_MCP_SETTINGS_PATH"].filter(
  (name) => process.env[name] !== undefined && process.env[name] !== configPath,
);

const skip = (reason) => {
  console.log(
    JSON.stringify(
      { status: "skipped", reason, command, process_run: run },
      null,
      2,
    ),
  );
  process.exit(2);
};

let clineVersion;
try {
  const { stdout } = await exec(command, ["--version"], {
    env: environment,
    timeout: 60_000,
  });
  clineVersion = stdout.trim();
} catch (cause) {
  skip(
    `${command} is not available (${cause.code ?? cause.message}). Set REA_VERIFY_CLINE_COMMAND to an installed Cline CLI.`,
  );
}

// 1. REA writes the registration into the isolated home.
await exec(
  node,
  [reaEntry, "setup", "--client", "cline", "--skill=false", "--yes", "--json"],
  { cwd: home, env: environment, timeout: 180_000 },
);
const settings = JSON.parse(await readFile(configPath, "utf8"));
const registration = settings.mcpServers?.rea;
assert(
  registration,
  "setup must write mcpServers.rea into the Cline settings file",
);
assert(Array.isArray(registration.args), "the registration must carry args");
assert.equal(
  registration.args.at(-1),
  "mcp",
  "the registration must launch the MCP entry point",
);

// 2. Cline's own CLI parses that file and lists the server.
const listed = await exec(
  command,
  ["--data-dir", dataDirectory, "config", "mcp"],
  {
    env: environment,
    timeout: 120_000,
  },
);
assert.match(
  listed.stdout,
  /rea \[stdio\]/,
  "Cline must list the REA server REA wrote",
);

// 3. The exact command Cline would spawn completes an MCP handshake.
// Sequence is canonical and stdin stays open: with eager startup a premature
// EOF reads as cancellation and would reject a healthy server.
const tools = await new Promise((resolve, reject) => {
  const child = spawn(registration.command, registration.args, {
    env: { ...environment, ...registration.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  let settled = false;
  const deadline = setTimeout(
    () =>
      settle(
        reject,
        new Error(`no tools/list within 120s: ${stderr.slice(-400)}`),
      ),
    120_000,
  );
  function settle(settler, value) {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    child.stdin.end();
    child.kill("SIGKILL");
    settler(value);
  }
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("error", (cause) => settle(reject, cause));
  child.on("close", () => {
    if (!settled)
      settle(
        reject,
        new Error(`server closed before tools/list: ${stderr.slice(-400)}`),
      );
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === 1) {
        assert(
          message.result?.serverInfo?.name === "rea",
          "initialize must identify rea",
        );
        send({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      }
      if (message.id === 2) settle(resolve, message.result?.tools ?? []);
    }
  });
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "rea-cline-verifier", version: "1" },
    },
  });
});
assert(tools.length > 0, "the registered server must expose tools");

console.log(
  JSON.stringify(
    {
      status: "verified",
      client: "cline",
      client_version: clineVersion,
      configuration_path: configPath,
      registration_command: registration.args[0],
      tool_count: tools.length,
      covered: [
        "rea setup writes the Cline registration",
        "Cline lists the REA server from that file",
        "the registered command completes an MCP handshake",
      ],
      unverified: [
        "a model-driven tool call inside Cline (providers.json is versioned and auth-shaped)",
        "the IDE extension, whose settings are UI-managed",
      ],
      isolated_overrides: isolatedOverrides,
      process_run: await completeVerifierRun(run),
    },
    null,
    2,
  ),
);
