#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { verifyCompleteToolCatalog } from "./lib/verify-package-core.mjs";
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

  process.stdout.write(
    `${JSON.stringify({
      verifier_run: await completeVerifierRun(verifierRun),
      ok: true,
      platform: process.platform,
      package: packageResult.filename,
      tools: toolCount,
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
