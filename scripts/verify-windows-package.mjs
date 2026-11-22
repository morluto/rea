#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { supportedClients } from "../dist/application/SupportedClients.js";
import { GHIDRA_BRIDGE_SOURCES } from "../src/ghidra/GhidraBridgeSources.ts";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { verifyCompleteToolCatalog } from "./lib/verify-package-core.mjs";
import { createPackageVerifierCommands } from "./lib/verify-package-commands.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { verifyPackageUpdate } from "./verify-package-update.mjs";
import {
  completeVerifierRun,
  createVerifierPhaseTimings,
  createVerifierRun,
} from "./lib/verifier-run.mjs";
import { VerifierFixture } from "./lib/verifier-fixture.mjs";

const verifierRun = createVerifierRun();
const timings = createVerifierPhaseTimings();
const root = process.cwd();
// Windows children write beneath the root; a private root's DELETE handle would block them.
const fixture = await VerifierFixture.open({
  prefix: "rea-windows-package-",
  private: false,
});
const workspace = fixture.path;
// The package command owner releases the fixture after its commands close.
const workspaceOwner = { path: workspace, close: () => fixture.release() };
const prefix = join(workspace, "prefix");
let commands;
const closeWorkspace = async () => {
  timings.begin("cleanup");
  try {
    await (commands === undefined ? workspaceOwner.close() : commands.close());
  } catch (cause) {
    timings.finish("failed");
    throw cause;
  }
  timings.finish();
};
const reportFailureTimings = () =>
  process.stderr.write(
    `${JSON.stringify({ phase_timings: timings.snapshot() })}\n`,
  );
let report;

try {
  timings.begin("command_setup");
  commands = await createPackageVerifierCommands({ workspace: workspaceOwner });
  timings.begin("pack");
  const packed = JSON.parse(
    (
      await commands.execNpm(
        ["pack", "--json", "--silent", "--pack-destination", workspace],
        { cwd: root, windowsHide: true },
      )
    ).stdout,
  );
  const packageResult = packed[0];
  if (
    packageResult === undefined ||
    typeof packageResult.filename !== "string" ||
    !Array.isArray(packageResult.files)
  )
    throw new Error(
      `npm pack returned invalid metadata: ${JSON.stringify(packed)}`,
    );
  const packagedPaths = new Set(packageResult.files.map(({ path }) => path));
  for (const required of [
    ...Object.values(GHIDRA_BRIDGE_SOURCES).map(
      (name) => `bridge/ghidra/${name}`,
    ),
    "native/windows/build/manifest.json",
    "native/windows/build/rea-windows-x64.node",
    "dist/android/JadxWorkspaceRoot.js",
    "dist/main.js",
    "dist/cli.js",
    "scripts/rea-android-workspace-guardian.mjs",
    "scripts/rea.mjs",
  ])
    if (!packagedPaths.has(required))
      throw new Error(`Windows package omitted ${required}`);

  const tarball = join(workspace, packageResult.filename);
  await access(tarball);
  timings.begin("install");
  await commands.execNpm(
    [
      "install",
      "--no-package-lock",
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--prefix",
      prefix,
      tarball,
    ],
    { cwd: workspace, windowsHide: true },
  );
  const entry = join(
    prefix,
    "node_modules",
    "rea-agents",
    "scripts",
    "rea.mjs",
  );
  const environment = {
    ...process.env,
    REA_ANALYSIS_PROVIDER: "auto",
  };
  timings.begin("cli_help");
  const help = await commands.exec(process.execPath, [entry, "--help"], {
    env: environment,
    windowsHide: true,
  });
  if (
    !/^\s{2}inspect\s/mu.test(help.stdout) ||
    !/^\s{2}decompile\s/mu.test(help.stdout) ||
    !/^\s{2}providers\s/mu.test(help.stdout)
  )
    throw new Error("Packaged Windows CLI help omitted analysis commands");

  timings.begin("mcp_catalog");
  const server = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mcp"],
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "rea-windows-package", version: "1.0.0" });
  let toolCount = 0;
  await withVerifierCleanup(async () => {
    await client.connect(server);
    toolCount = (await verifyCompleteToolCatalog(client)).length;
  }, [
    async () => {
      try {
        await client.close();
      } catch (cause) {
        commands.adopt(client, entry);
        throw cause;
      }
    },
    async () => {
      try {
        await server.close();
      } catch (cause) {
        commands.adopt(server, entry);
        throw cause;
      }
    },
  ]);

  timings.begin("mcp_doctor_target_free");
  const mcpDoctor = JSON.parse(
    (
      await commands.exec(
        process.execPath,
        [entry, "mcp", "doctor", "--json"],
        {
          env: { ...environment, hopper_target_kind: "invalid-fixture-kind" },
          windowsHide: true,
        },
      )
    ).stdout,
  );
  if (mcpDoctor.healthy !== true || mcpDoctor.request_flow?.ok !== true)
    throw new Error("Packaged Windows MCP doctor did not start target-free");

  timings.begin("setup");
  const home = join(workspace, "home");
  const setupEnvironment = {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    CLAUDE_CONFIG_DIR: home,
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"),
    OPENCODE_CONFIG: join(home, ".config", "opencode", "opencode.jsonc"),
    COPILOT_HOME: join(home, ".copilot"),
    GROK_HOME: join(home, ".grok"),
    SAND_DATA_ROOT: join(home, ".grokbot"),
    OMP_PROFILE: undefined,
    PI_CODING_AGENT_DIR: undefined,
    PI_CONFIG_DIR: undefined,
    PI_PROFILE: undefined,
  };
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
  await writeFile(
    setupEnvironment.OPENCODE_CONFIG,
    '{\n  // preserve user settings\n  "theme": "dark",\n}\n',
  );
  const setupArgs = [
    "setup",
    "--yes",
    "--client",
    "opencode",
    "--client",
    "vscode",
    "--client",
    "copilot_cli",
    "--skill=false",
    "--json",
  ];
  const setup = JSON.parse(
    (
      await commands.exec(process.execPath, [entry, ...setupArgs], {
        env: setupEnvironment,
        windowsHide: true,
      })
    ).stdout,
  );
  if (setup.status !== "ready" || setup.appliedActions.length !== 3)
    throw new Error(
      `Packaged agent-only setup failed: ${JSON.stringify(setup)}`,
    );
  const expectedCommand =
    process.platform === "win32"
      ? [process.execPath, entry, "mcp"]
      : [entry, "mcp"];
  const clients = supportedClients(home, process.platform, setupEnvironment);
  for (const id of ["opencode", "vscode", "copilot_cli"]) {
    const clientLocation = clients.find(({ name }) => name === id);
    if (clientLocation === undefined)
      throw new Error(`Missing packaged client ${id}`);
    const text = await readFile(clientLocation.configPath, "utf8");
    const config = parseJsonc(text);
    const registration =
      id === "opencode"
        ? config.mcp?.rea
        : id === "vscode"
          ? config.servers?.rea
          : config.mcpServers?.rea;
    const actualCommand =
      id === "opencode"
        ? registration?.command
        : [registration?.command, ...(registration?.args ?? [])];
    if (JSON.stringify(actualCommand) !== JSON.stringify(expectedCommand))
      throw new Error(
        `Packaged ${id} has an unusable launcher: ${JSON.stringify(actualCommand)}`,
      );
    if (id === "opencode" && !text.includes("// preserve user settings"))
      throw new Error("Packaged setup discarded OpenCode JSONC comments");
  }
  const repeated = JSON.parse(
    (
      await commands.exec(process.execPath, [entry, ...setupArgs], {
        env: setupEnvironment,
        windowsHide: true,
      })
    ).stdout,
  );
  if (
    repeated.status !== "ready" ||
    repeated.plannedActions.length !== 0 ||
    repeated.appliedActions.length !== 0
  )
    throw new Error("Packaged agent setup is not idempotent");
  timings.begin("uninstall");
  const uninstalled = JSON.parse(
    (
      await commands.exec(process.execPath, [entry, "uninstall", "--json"], {
        env: setupEnvironment,
        windowsHide: true,
      })
    ).stdout,
  );
  for (const id of ["opencode", "vscode", "copilot_cli"])
    if (
      uninstalled.items?.find(({ name }) => name === id)?.status !== "removed"
    )
      throw new Error(`Packaged uninstall did not remove ${id}`);

  timings.begin("update");
  if (process.platform !== "win32")
    await commands.execNpm(
      ["install", "--global", "--ignore-scripts", "--prefix", prefix, tarball],
      { cwd: workspace, windowsHide: true },
    );
  const update = await verifyPackageUpdate({
    commands,
    prefix,
    packageRoot:
      process.platform === "win32"
        ? join(prefix, "node_modules", "rea-agents")
        : join(prefix, "lib", "node_modules", "rea-agents"),
    tarball,
    workspace,
    environment,
  });

  report = {
    ok: true,
    platform: process.platform,
    package: packageResult.filename,
    tools: toolCount,
    mcp_doctor_target_free: true,
    ghidra_bridge: "present",
    agent_setup: ["opencode", "vscode", "copilot_cli"],
    setup_idempotent: true,
    uninstall: true,
    update,
  };
} catch (cause) {
  timings.finish("failed");
  try {
    await withVerifierCleanup(() => Promise.reject(cause), [closeWorkspace]);
  } finally {
    reportFailureTimings();
  }
}
try {
  await closeWorkspace();
} catch (cause) {
  reportFailureTimings();
  throw cause;
}
process.stdout.write(
  `${JSON.stringify({ verifier_run: await completeVerifierRun(verifierRun), ...report, phase_timings: timings.snapshot() })}\n`,
);
