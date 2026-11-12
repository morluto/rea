#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { npmInvocation } from "./lib/npm-invocation.mjs";

// Marketplace and Codex checkouts keep source package.json at the plugin root.
// Install the published artifact under an owner-private cache in os.tmpdir() and
// run it in-process so the plugin client owns the same process that registered
// shutdown handlers. An npx/npm script-shell child can exit without delivering
// signals or awaiting rea, orphaning session/provider resources.
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

/** POSIX uid when the host reports one; Windows TEMP is already per-user. */
const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

const cacheRoot = join(
  tmpdir(),
  uid === undefined ? "rea-plugin-mcp" : `rea-plugin-mcp-${uid}`,
);

/**
 * Refuse foreign or group/other-writable cache paths before trusting an
 * executable entry. Owner-only directories match PrivateRuntimeRoot's POSIX
 * boundary; files must not be group/other-writable.
 */
const verifyOwnedCachePath = (path, kind) => {
  if (uid === undefined) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink())
    throw new Error(`executable cache ${kind} must not be a symlink`);
  if (kind === "root" || kind === "prefix") {
    if (!stats.isDirectory())
      throw new Error(`executable cache ${kind} must be a directory`);
  } else if (!stats.isFile()) {
    throw new Error("executable cache entry must be a regular file");
  }
  if (stats.uid !== uid)
    throw new Error(`executable cache ${kind} is not owned by this user`);
  const foreign = kind === "entry" ? 0o022 : 0o077;
  if ((stats.mode & foreign) === 0) return;
  if (kind === "entry")
    throw new Error("executable cache entry is writable by others");
  chmodSync(path, 0o700);
  const after = lstatSync(path);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    after.uid !== uid ||
    (after.mode & 0o077) !== 0
  )
    throw new Error(`executable cache ${kind} is not private to this user`);
};

const ensurePrivateCacheRoot = () => {
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  if (uid !== undefined) chmodSync(cacheRoot, 0o700);
  verifyOwnedCachePath(cacheRoot, "root");
};

const refuseUntrustedCache = (cause) => {
  process.stderr.write(
    `REA plugin refused an untrusted executable cache: ${cause.message}.\n`,
  );
  process.exitCode = 1;
};

if (process.exitCode === 1) {
  // Argument validation already failed.
} else {
  const prefix = join(cacheRoot, version);
  const entry = join(prefix, "node_modules", PACKAGE, "scripts", "rea.mjs");

  try {
    ensurePrivateCacheRoot();
  } catch (cause) {
    refuseUntrustedCache(cause);
  }

  let ready = false;
  if (process.exitCode !== 1) {
    try {
      verifyOwnedCachePath(prefix, "prefix");
      verifyOwnedCachePath(entry, "entry");
      accessSync(entry);
      ready = true;
    } catch (cause) {
      const missing =
        cause !== null &&
        typeof cause === "object" &&
        "code" in cause &&
        cause.code === "ENOENT";
      if (
        cause instanceof Error &&
        cause.message.includes("executable cache")
      ) {
        refuseUntrustedCache(cause);
      } else if (!missing) {
        ready = false;
      }
    }
  }

  if (process.exitCode !== 1 && !ready) {
    try {
      mkdirSync(prefix, { recursive: true, mode: 0o700 });
      if (uid !== undefined) chmodSync(prefix, 0o700);
      verifyOwnedCachePath(prefix, "prefix");
    } catch (cause) {
      refuseUntrustedCache(cause);
    }
  }

  if (process.exitCode !== 1 && !ready) {
    let invocation;
    try {
      invocation = npmInvocation(
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
        process.env,
      );
    } catch (cause) {
      process.stderr.write(
        `REA plugin failed to resolve npm for ${PACKAGE}@${version}: ${cause.message}.\n`,
      );
      process.exitCode = 1;
    }

    if (process.exitCode !== 1) {
      const install = spawnSync(invocation.command, invocation.arguments, {
        // Keep install away from the plugin checkout package.json.
        cwd: tmpdir(),
        env: process.env,
        // Route installer chatter off the MCP JSON-RPC stdout stream.
        stdio: ["ignore", process.stderr, "inherit"],
        windowsHide: true,
      });
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
  }

  if (process.exitCode !== 1) {
    try {
      verifyOwnedCachePath(entry, "entry");
      accessSync(entry);
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.message.includes("executable cache")
      ) {
        refuseUntrustedCache(cause);
      } else {
        process.stderr.write(
          `REA plugin installed ${PACKAGE}@${version} without scripts/rea.mjs.\n`,
        );
        process.exitCode = 1;
      }
    }
  }

  if (process.exitCode !== 1) {
    process.argv = [process.execPath, entry, "mcp"];
    await import(pathToFileURL(entry).href);
  }
}
