import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOwnedMcpStdioTransport } from "./lib/owned-mcp-stdio.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { createVerifierMcpOwner } from "./lib/verifier-mcp-owner.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

/** Verify default-path CLI registration, client parsing and owned MCP discovery. */
const repo = fileURLToPath(new URL("..", import.meta.url));
const command = process.env.REA_VERIFY_CLINE_COMMAND ?? "cline";
const reaEntry = join(repo, "scripts/rea.mjs");
const run = createVerifierRun();
const lab = await mkdtemp(join(tmpdir(), "rea-cline-client-"));
const home = join(lab, "home");
await mkdir(home, { recursive: true });
const dataDirectory = join(home, ".cline", "data");
const configPath = join(dataDirectory, "settings", "cline_mcp_settings.json");
const locationOverrides = [
  "CLINE_MCP_SETTINGS_PATH",
  "CLINE_DATA_DIR",
  "CLINE_DIR",
];
const isolatedOverrides = locationOverrides.filter(
  (name) => process.env[name] !== undefined,
);
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  HOPPER_LAUNCHER_PATH: join(lab, "missing-hopper"),
  GHIDRA_INSTALL_DIR: join(lab, "missing-ghidra"),
  JAVA_HOME: join(lab, "missing-java"),
};
// Exercise Cline's default path without letting inherited selectors escape HOME.
for (const name of locationOverrides) delete environment[name];

const commands = await createVerifierCommands();
const report = await withVerifierCleanup(async () => {
  let clineVersion;
  try {
    const { stdout } = await commands.exec(command, ["--version"], {
      cwd: home,
      env: environment,
      timeout: 60_000,
    });
    clineVersion = stdout.trim();
  } catch (cause) {
    return {
      status: "skipped",
      reason: `Could not verify ${command} --version (${cause.code ?? cause.message}). Set REA_VERIFY_CLINE_COMMAND to an installed Cline CLI.`,
      command,
    };
  }

  await commands.exec(
    process.execPath,
    [
      reaEntry,
      "setup",
      "--client",
      "cline",
      "--skill=false",
      "--yes",
      "--json",
    ],
    { cwd: home, env: environment, timeout: 180_000 },
  );
  const settings = JSON.parse(await readFile(configPath, "utf8"));
  const registration = settings.mcpServers?.rea;
  assert(
    registration,
    "setup must write mcpServers.rea into Cline's default settings file",
  );
  assert(Array.isArray(registration.args), "the registration must carry args");
  assert.equal(
    registration.args.at(-1),
    "mcp",
    "the registration must launch the MCP entry point",
  );

  const listed = await commands.exec(
    command,
    ["--data-dir", dataDirectory, "config", "mcp"],
    { cwd: home, env: environment, timeout: 120_000 },
  );
  assert.match(
    listed.stdout,
    /rea \[stdio\]/,
    "Cline must list the REA server REA wrote",
  );

  const mcp = createVerifierMcpOwner();
  commands.adopt(mcp, "Cline MCP discovery");
  const transport = await createOwnedMcpStdioTransport({
    command: registration.command,
    arguments: registration.args,
    hostEnvironment: { ...environment, ...registration.env },
    cwd: home,
    expectedCommand: null,
    sweepTokenOwnedProcesses: true,
  });
  const client = new Client({ name: "rea-cline-verifier", version: "1" });
  // The SDK keeps stdin open through delayed initialization and tool discovery.
  const connection = await mcp.open(client, transport);
  assert.equal(
    client.getServerVersion()?.name,
    "rea",
    "initialize must identify rea",
  );
  assert(
    connection.definitions.size > 0,
    "the registered server must expose tools",
  );

  return {
    status: "verified",
    client: "cline",
    client_version: clineVersion,
    configuration_path: configPath,
    registration_command: registration.command,
    registration_arguments: registration.args,
    tool_count: connection.definitions.size,
    covered: [
      "rea setup writes the default Cline registration without path overrides",
      "Cline lists the REA server from that file",
      "the registered command completes owned MCP discovery and cleanup",
    ],
    unverified: [
      "Cline's independent default-home discovery (listing selects --data-dir)",
      "a model-driven tool call inside Cline (providers.json is versioned and auth-shaped)",
      "the IDE extension, whose settings are UI-managed",
    ],
    isolated_overrides: isolatedOverrides,
  };
}, [() => commands.close()]);

// Publish lineage only after every command and the MCP owner have finished cleanup.
console.log(
  JSON.stringify(
    {
      ...report,
      process_run:
        report.status === "verified" ? await completeVerifierRun(run) : run,
    },
    null,
    2,
  ),
);
if (report.status === "skipped") process.exitCode = 2;
