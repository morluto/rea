#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

import { packageRunnerCommand } from "./lib/packageRunnerCommand.mjs";

// The manifest owns the exact release-managed version; keep the package name here.
// No build, dependency installation or ambient latest-version lookup is needed
// to run this bootstrap from a Git-installed plugin.
const [version, ...extra] = process.argv.slice(2);
if (
  extra.length !== 0 ||
  !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version ?? "")
) {
  process.stderr.write("REA plugin requires one exact package version.\n");
  process.exitCode = 1;
} else {
  await launch(`rea-agents@${version}`);
}

async function launch(packageSpecifier) {
  // npm can satisfy the exact pin from a same-version local checkout. An
  // private prefix prevents a same-version local checkout from shadowing the
  // registry package while preserving the caller's path base for REA requests.
  let workingDirectory;
  try {
    workingDirectory = await mkdtemp(join(tmpdir(), "rea-plugin-launcher-"));
  } catch (cause) {
    process.stderr.write(
      `REA plugin could not create its working directory: ${cause.message}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const [command, ...args] = packageRunnerCommand(
    "npx",
    packageSpecifier,
    process.platform,
    workingDirectory,
  );
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: false,
    windowsVerbatimArguments: process.platform === "win32",
  });
  let spawnFailed = false;
  const signals = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const forward = () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill(signal);
    };
    signals.set(signal, forward);
    process.on(signal, forward);
  }
  const stopForwarding = () => {
    for (const [signal, listener] of signals) process.off(signal, listener);
  };
  child.once("error", (cause) => {
    spawnFailed = true;
    stopForwarding();
    process.stderr.write(
      `REA plugin could not start ${command}: ${cause.message}\n`,
    );
    process.exitCode = 1;
  });
  child.once("close", async (code, signal) => {
    stopForwarding();
    let cleanupFailed = false;
    try {
      await rm(workingDirectory, { recursive: true });
    } catch (cause) {
      cleanupFailed = true;
      process.stderr.write(
        `REA plugin retained its working directory at ${workingDirectory}: ${cause.message}\n`,
      );
    }
    if (spawnFailed) return;
    if (signal !== null && process.platform !== "win32") {
      // Preserve signal termination after the owned child has closed its streams.
      process.kill(process.pid, signal);
    } else {
      process.exitCode =
        code === 0 && cleanupFailed
          ? 1
          : (code ?? 128 + (constants.signals[signal] ?? 1));
    }
  });
}
