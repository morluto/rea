#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";

const exec = promisify(execFile);
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
  try {
    await client.connect(server);
    const catalog = await client.listTools();
    const expected = TOOL_CONTRACTS.map(({ name }) => name).sort(
      (left, right) => left.localeCompare(right),
    );
    const actual = catalog.tools
      .map(({ name }) => name)
      .sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        "Packaged Windows MCP catalog drifted from TOOL_CONTRACTS",
      );
  } finally {
    await client.close();
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      platform: process.platform,
      package: packageResult.filename,
      tools: TOOL_CONTRACTS.length,
      ghidra_bridge: "present",
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
