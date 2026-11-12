#!/usr/bin/env node

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

// Marketplace and Codex checkouts keep source package.json at the plugin root.
// npx would prefer that unbuilt package over the published artifact, so this
// launcher always resolves rea-agents@VERSION from the OS temporary directory.
const [version, ...extra] = process.argv.slice(2);
try {
  if (
    extra.length !== 0 ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version ?? "")
  )
    throw new Error("requires one exact rea-agents@VERSION pin");
} catch (cause) {
  process.stderr.write(`REA plugin ${cause.message}.\n`);
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  const child = spawn("npx", ["-y", `rea-agents@${version}`, "mcp"], {
    cwd: tmpdir(),
    env: process.env,
    stdio: "inherit",
    // Windows resolves the npx.cmd shim only through a shell.
    shell: process.platform === "win32",
    windowsHide: true,
  });
  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  child.on("error", (error) => {
    process.stderr.write(
      `REA plugin failed to launch npx: ${error.message}.\n`,
    );
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}
