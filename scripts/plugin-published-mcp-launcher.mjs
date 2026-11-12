#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const READY_MARKER = ".rea-plugin-ready";
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };
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
 * Tighten an already-admitted owner directory without following a replacement
 * symlink. Matches OwnedLease's O_DIRECTORY|O_NOFOLLOW + fchmod boundary.
 */
const tightenOwnedDirectory = (path, kind) => {
  const fd = openSync(
    path,
    fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(fd);
    if (opened.isSymbolicLink() || !opened.isDirectory() || opened.uid !== uid)
      throw new Error(`executable cache ${kind} is not owned by this user`);
    if ((opened.mode & 0o077) === 0) return;
    fchmodSync(fd, 0o700);
    const after = fstatSync(fd);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      after.uid !== uid ||
      (after.mode & 0o077) !== 0
    )
      throw new Error(`executable cache ${kind} is not private to this user`);
  } finally {
    closeSync(fd);
  }
};

/**
 * Refuse foreign or group/other-writable cache paths before trusting an
 * executable entry. Owner-only directories match PrivateRuntimeRoot's POSIX
 * boundary; files must not be group/other-writable. Never chmod a path before
 * an lstat ownership/symlink check — path chmod follows symlinks.
 */
const verifyOwnedCachePath = (path, kind) => {
  if (uid === undefined) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink())
    throw new Error(`executable cache ${kind} must not be a symlink`);
  if (kind === "root" || kind === "prefix" || kind === "lock") {
    if (!stats.isDirectory())
      throw new Error(`executable cache ${kind} must be a directory`);
  } else if (!stats.isFile()) {
    throw new Error(`executable cache ${kind} must be a regular file`);
  }
  if (stats.uid !== uid)
    throw new Error(`executable cache ${kind} is not owned by this user`);
  const foreign = kind === "entry" || kind === "ready" ? 0o022 : 0o077;
  if ((stats.mode & foreign) === 0) return;
  if (kind === "entry" || kind === "ready")
    throw new Error(`executable cache ${kind} is writable by others`);
  tightenOwnedDirectory(path, kind);
};

const ensurePrivateCacheRoot = () => {
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  verifyOwnedCachePath(cacheRoot, "root");
};

const refuseUntrustedCache = (cause) => {
  process.stderr.write(
    `REA plugin refused an untrusted executable cache: ${cause.message}.\n`,
  );
  process.exitCode = 1;
};

const cacheEntry = (prefix) =>
  join(prefix, "node_modules", PACKAGE, "scripts", "rea.mjs");

const readyMarkerPath = (prefix) => join(prefix, READY_MARKER);

const inspectReadyCache = (prefix) => {
  const entry = cacheEntry(prefix);
  const marker = readyMarkerPath(prefix);
  verifyOwnedCachePath(prefix, "prefix");
  verifyOwnedCachePath(entry, "entry");
  verifyOwnedCachePath(marker, "ready");
  accessSync(entry);
  accessSync(marker);
  if (readFileSync(marker, "utf8") !== version)
    throw new Error("ready marker does not match the pin");
  return entry;
};

const isIncompleteCache = (cause) => {
  if (
    cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    cause.code === "ENOENT"
  )
    return true;
  return (
    cause instanceof Error &&
    cause.message.includes("ready marker does not match")
  );
};

const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(
      cause !== null &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "ESRCH"
    );
  }
};

const isPathExistsError = (cause) =>
  cause !== null &&
  typeof cause === "object" &&
  "code" in cause &&
  cause.code === "EEXIST";

const claimInstallLock = (lockPath) => {
  mkdirSync(lockPath, { mode: 0o700 });
  verifyOwnedCachePath(lockPath, "lock");
  writeFileSync(join(lockPath, "pid"), `${String(process.pid)}\n`, {
    mode: 0o600,
  });
};

const readLockHolder = (lockPath) => {
  verifyOwnedCachePath(lockPath, "lock");
  return Number.parseInt(readFileSync(join(lockPath, "pid"), "utf8"), 10);
};

/**
 * Exclusive install lock; reclaim only when the recorded holder is gone.
 * Stale cleanup is serialized through a sibling recovery directory, matching
 * OwnedLease: never delete the lock pathname from an earlier PID read alone.
 */
const tryAcquireInstallLock = (lockPath) => {
  try {
    claimInstallLock(lockPath);
    return true;
  } catch (cause) {
    if (!isPathExistsError(cause)) throw cause;
  }

  let holder = NaN;
  try {
    holder = readLockHolder(lockPath);
  } catch {
    return false;
  }
  if (processAlive(holder)) return false;

  // Serialize stale cleanup through the replacement mkdir: otherwise two
  // recoverers can unlink the lock that one of them has just acquired.
  const recoveryPath = `${lockPath}.recovery`;
  try {
    mkdirSync(recoveryPath, { mode: 0o700 });
  } catch (cause) {
    if (isPathExistsError(cause)) return false;
    throw cause;
  }

  try {
    try {
      claimInstallLock(lockPath);
      return true;
    } catch (cause) {
      if (!isPathExistsError(cause)) throw cause;
    }

    let current = NaN;
    try {
      current = readLockHolder(lockPath);
    } catch {
      current = NaN;
    }
    if (processAlive(current)) return false;

    rmSync(lockPath, { recursive: true, force: true });
    try {
      claimInstallLock(lockPath);
      return true;
    } catch (cause) {
      if (!isPathExistsError(cause)) throw cause;
      return false;
    }
  } finally {
    try {
      rmdirSync(recoveryPath);
    } catch {
      // Retain a recovery directory whose removal failed.
    }
  }
};

const releaseInstallLock = (lockPath) => {
  rmSync(lockPath, { recursive: true, force: true });
};

const publishInstalledPrefix = (staging, prefix) => {
  writeFileSync(readyMarkerPath(staging), version, { mode: 0o600 });
  verifyOwnedCachePath(staging, "prefix");
  verifyOwnedCachePath(cacheEntry(staging), "entry");
  verifyOwnedCachePath(readyMarkerPath(staging), "ready");
  rmSync(prefix, { recursive: true, force: true });
  renameSync(staging, prefix);
};

/**
 * Own the cold-start installer until it exits. Signal handlers stay attached
 * only for this acquisition stage; the in-process runtime registers its own.
 */
const runOwnedInstaller = (invocation) => {
  const signalExitCodes = SIGNAL_EXIT_CODES;
  let child;
  let forceTimer;
  let shutdownSignal;
  const onSignal = (signal) => {
    if (shutdownSignal !== undefined) return;
    shutdownSignal = signal;
    if (child !== undefined && child.exitCode === null) {
      child.kill(signal);
      forceTimer = setTimeout(() => child?.kill("SIGKILL"), 1_000);
      forceTimer.unref?.();
    }
  };
  for (const signal of Object.keys(signalExitCodes))
    process.on(signal, onSignal);

  return new Promise((resolve, reject) => {
    try {
      child = spawn(invocation.command, invocation.arguments, {
        // Keep install away from the plugin checkout package.json.
        cwd: tmpdir(),
        env: process.env,
        // Route installer chatter off the MCP JSON-RPC stdout stream.
        stdio: ["ignore", process.stderr, "inherit"],
        windowsHide: true,
      });
    } catch (cause) {
      for (const signal of Object.keys(signalExitCodes))
        process.off(signal, onSignal);
      reject(cause);
      return;
    }

    child.once("error", (cause) => {
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      for (const signal of Object.keys(signalExitCodes))
        process.off(signal, onSignal);
      reject(cause);
    });
    child.once("exit", (status, signal) => {
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      for (const signal of Object.keys(signalExitCodes))
        process.off(signal, onSignal);
      if (shutdownSignal !== undefined) {
        resolve({
          cancelled: true,
          signal: shutdownSignal,
          status,
          childSignal: signal,
        });
        return;
      }
      resolve({
        cancelled: false,
        status,
        signal,
      });
    });
  });
};

const waitForReadyOrLock = async (prefix, lockPath) => {
  const signalExitCodes = SIGNAL_EXIT_CODES;
  let shutdownSignal;
  /** @type {(() => void) | undefined} */
  let wakeWait;
  const onSignal = (signal) => {
    if (shutdownSignal !== undefined) return;
    shutdownSignal = signal;
    wakeWait?.();
  };
  for (const signal of Object.keys(signalExitCodes))
    process.on(signal, onSignal);
  try {
    for (;;) {
      if (shutdownSignal !== undefined)
        return { cancelled: true, signal: shutdownSignal };
      try {
        return { cancelled: false, entry: inspectReadyCache(prefix) };
      } catch (cause) {
        if (
          cause instanceof Error &&
          cause.message.includes("executable cache")
        )
          throw cause;
        if (!isIncompleteCache(cause)) throw cause;
      }
      if (tryAcquireInstallLock(lockPath))
        return { cancelled: false, acquired: true };
      // Keep the timer referenced so a waiter cannot exit with an unsettled
      // top-level await while another installer still holds the lock.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 50);
        wakeWait = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wakeWait = undefined;
    }
  } finally {
    for (const signal of Object.keys(signalExitCodes))
      process.off(signal, onSignal);
  }
};

if (process.exitCode === 1) {
  // Argument validation already failed.
} else {
  const prefix = join(cacheRoot, version);
  const lockPath = join(cacheRoot, `${version}.lock`);
  const staging = join(cacheRoot, `${version}.staging-${String(process.pid)}`);
  let entry;

  try {
    ensurePrivateCacheRoot();
  } catch (cause) {
    refuseUntrustedCache(cause);
  }

  if (process.exitCode !== 1) {
    try {
      entry = inspectReadyCache(prefix);
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.message.includes("executable cache")
      ) {
        refuseUntrustedCache(cause);
      } else if (!isIncompleteCache(cause)) {
        process.stderr.write(
          `REA plugin failed to read ${PACKAGE}@${version} cache: ${cause instanceof Error ? cause.message : String(cause)}.\n`,
        );
        process.exitCode = 1;
      }
    }
  }

  if (process.exitCode !== 1 && entry === undefined) {
    let holdLock = tryAcquireInstallLock(lockPath);
    if (!holdLock) {
      try {
        const waited = await waitForReadyOrLock(prefix, lockPath);
        if (waited.cancelled) {
          process.exitCode = SIGNAL_EXIT_CODES[waited.signal] ?? 1;
        } else if (waited.entry !== undefined) {
          entry = waited.entry;
        } else {
          holdLock = true;
        }
      } catch (cause) {
        if (
          cause instanceof Error &&
          cause.message.includes("executable cache")
        ) {
          refuseUntrustedCache(cause);
        } else {
          process.stderr.write(
            `REA plugin failed while waiting for ${PACKAGE}@${version}: ${cause instanceof Error ? cause.message : String(cause)}.\n`,
          );
          process.exitCode = 1;
        }
      }
    }

    if (process.exitCode !== 1 && entry === undefined && holdLock) {
      try {
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging, { recursive: true, mode: 0o700 });
        verifyOwnedCachePath(staging, "prefix");

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
              staging,
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
          const install = await runOwnedInstaller(invocation);
          if (install.cancelled) {
            process.exitCode = SIGNAL_EXIT_CODES[install.signal] ?? 1;
          } else if (install.status !== 0) {
            process.stderr.write(
              `REA plugin failed to install ${PACKAGE}@${version}.\n`,
            );
            process.exitCode = 1;
          } else {
            try {
              publishInstalledPrefix(staging, prefix);
              entry = inspectReadyCache(prefix);
            } catch (cause) {
              if (
                cause instanceof Error &&
                cause.message.includes("executable cache")
              ) {
                refuseUntrustedCache(cause);
              } else {
                process.stderr.write(
                  `REA plugin installed ${PACKAGE}@${version} without a complete runtime.\n`,
                );
                process.exitCode = 1;
              }
            }
          }
        }
      } catch (cause) {
        if (
          cause instanceof Error &&
          cause.message.includes("executable cache")
        ) {
          refuseUntrustedCache(cause);
        } else {
          process.stderr.write(
            `REA plugin failed to install ${PACKAGE}@${version}: ${cause instanceof Error ? cause.message : String(cause)}.\n`,
          );
          process.exitCode = 1;
        }
      } finally {
        rmSync(staging, { recursive: true, force: true });
        releaseInstallLock(lockPath);
      }
    }
  }

  if (process.exitCode !== 1 && entry !== undefined) {
    process.argv = [process.execPath, entry, "mcp"];
    await import(pathToFileURL(entry).href);
  }
}
