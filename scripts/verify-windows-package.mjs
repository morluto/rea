#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { supportedClients } from "../dist/application/SupportedClients.js";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { verifyCompleteToolCatalog } from "./lib/verify-package-core.mjs";
import { verifyPackageUpdate } from "./verify-package-update.mjs";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const exec = promisify(execFile);
const verifierRun = createVerifierRun();
const root = process.cwd();
const workspace = await mkdtemp(join(tmpdir(), "rea-windows-package-"));
const prefix = join(workspace, "prefix");

try {
  const packed = JSON.parse(
    (
      await npm(
        ["pack", "--json", "--silent", "--pack-destination", workspace],
        root,
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
    "bridge/ghidra/ReaGhidraBridge.java",
    "native/windows/build/manifest.json",
    "native/windows/build/rea-windows-x64.node",
    "dist/main.js",
    "dist/cli.js",
    "scripts/rea.mjs",
  ])
    if (!packagedPaths.has(required))
      throw new Error(`Windows package omitted ${required}`);

  const tarball = join(workspace, packageResult.filename);
  await access(tarball);
  await npm(
    ["install", "--no-package-lock", "--no-save", "--prefix", prefix, tarball],
    workspace,
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
  const help = await exec(process.execPath, [entry, "--help"], {
    env: environment,
    windowsHide: true,
  });
  if (
    !/^\s{2}inspect\s/mu.test(help.stdout) ||
    !/^\s{2}decompile\s/mu.test(help.stdout) ||
    !/^\s{2}providers\s/mu.test(help.stdout)
  )
    throw new Error("Packaged Windows CLI help omitted analysis commands");

  const server = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mcp"],
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "rea-windows-package", version: "1.0.0" });
  let toolCount = 0;
  try {
    await client.connect(server);
    toolCount = (await verifyCompleteToolCatalog(client)).length;
  } finally {
    await client.close();
  }

  const home = join(workspace, "home");
  const setupEnvironment = {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    OPENCODE_CONFIG: join(home, ".config", "opencode", "opencode.jsonc"),
    COPILOT_HOME: join(home, ".copilot"),
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
      await exec(process.execPath, [entry, ...setupArgs], {
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
      await exec(process.execPath, [entry, ...setupArgs], {
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
  const uninstalled = JSON.parse(
    (
      await exec(process.execPath, [entry, "uninstall", "--json"], {
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

  if (process.platform !== "win32")
    await npm(
      ["install", "--global", "--ignore-scripts", "--prefix", prefix, tarball],
      workspace,
    );
  const update = await verifyPackageUpdate({
    prefix,
    packageRoot:
      process.platform === "win32"
        ? join(prefix, "node_modules", "rea-agents")
        : join(prefix, "lib", "node_modules", "rea-agents"),
    tarball,
    workspace,
    environment,
  });

  process.stdout.write(
    `${JSON.stringify({
      verifier_run: await completeVerifierRun(verifierRun),
      ok: true,
      platform: process.platform,
      package: packageResult.filename,
      tools: toolCount,
      ghidra_bridge: "present",
      agent_setup: ["opencode", "vscode", "copilot_cli"],
      setup_idempotent: true,
      uninstall: true,
      update,
    })}\n`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

function npm(arguments_, cwd) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath === undefined
    ? exec(process.platform === "win32" ? "npm.cmd" : "npm", arguments_, {
        cwd,
        windowsHide: true,
      })
    : exec(process.execPath, [npmExecPath, ...arguments_], {
        cwd,
        windowsHide: true,
      });
}
