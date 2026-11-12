#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { accessSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Marketplace and Codex checkouts keep source package.json at the plugin root.
// Install the published artifact under os.tmpdir() and run it in-process so the
// plugin client owns the same process that registered shutdown handlers. An
// npx/npm script-shell child can exit without delivering signals or awaiting
// rea, orphaning session/provider resources.
const PACKAGE = "rea-agents";
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
  const prefix = join(tmpdir(), "rea-plugin-mcp", version);
  const entry = join(prefix, "node_modules", PACKAGE, "scripts", "rea.mjs");
  try {
    accessSync(entry);
  } catch {
    mkdirSync(prefix, { recursive: true });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const install = spawnSync(
      npm,
      [
        "install",
        "--omit=dev",
        "--no-fund",
        "--no-audit",
        "--no-update-notifier",
        "--prefix",
        prefix,
        `${PACKAGE}@${version}`,
      ],
      {
        // Keep install away from the plugin checkout package.json.
        cwd: tmpdir(),
        env: process.env,
        stdio: ["ignore", "inherit", "inherit"],
        shell: process.platform === "win32",
        windowsHide: true,
      },
    );
    if (install.error) {
      process.stderr.write(
        `REA plugin failed to install ${PACKAGE}@${version}: ${install.error.message}.\n`,
      );
      process.exitCode = 1;
    } else if (install.status !== 0) {
      process.stderr.write(
        `REA plugin failed to install ${PACKAGE}@${version}.\n`,
      );
      process.exitCode = 1;
    }
  }

  if (process.exitCode !== 1) {
    try {
      accessSync(entry);
    } catch {
      process.stderr.write(
        `REA plugin installed ${PACKAGE}@${version} without scripts/rea.mjs.\n`,
      );
      process.exitCode = 1;
    }
  }

  if (process.exitCode !== 1) {
    process.argv = [process.execPath, entry, "mcp"];
    await import(pathToFileURL(entry).href);
  }
}
