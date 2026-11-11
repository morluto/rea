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
  HOPPER_LAUNCHER_PATH: join(lab, "missing-hopper"),
  GHIDRA_INSTALL_DIR: join(lab, "missing-ghidra"),
  JAVA_HOME: join(lab, "missing-java"),
};

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
const tools = await new Promise((resolve, reject) => {
  const child = spawn(registration.command, registration.args, {
    env: { ...environment, ...registration.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const deadline = setTimeout(() => {
    child.kill("SIGKILL");
    reject(
      new Error(
        `the registered server did not answer tools/list within 120s: ${stderr.slice(-400)}`,
      ),
    );
  }, 120_000);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("error", (cause) => {
    clearTimeout(deadline);
    reject(cause);
  });
  child.on("close", () => {
    clearTimeout(deadline);
    try {
      const messages = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
      const initialized = messages.find(({ id }) => id === 1);
      assert(
        initialized?.result?.serverInfo?.name === "rea",
        "initialize must identify rea",
      );
      const listedTools = messages.find(({ id }) => id === 2);
      resolve(listedTools?.result?.tools ?? []);
    } catch (cause) {
      reject(cause);
    }
  });
  for (const message of [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "rea-cline-verifier", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ])
    child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
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
      process_run: await completeVerifierRun(run),
    },
    null,
    2,
  ),
);
