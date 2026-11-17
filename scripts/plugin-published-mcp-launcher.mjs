#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
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
const CLEANUP_OWNER = ".rea-plugin-cleanup-owner";
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };
// A lock or recovery directory with no readable owner record is only legitimate
// for the instant between mkdir and the lease bind; older than this it was
// abandoned by a launcher that died in between.
const ABANDONED_LOCK_GRACE_MS = 5_000;
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

// Native bindings (for example Frida) are arch-specific. ARM64 and Rosetta x64
// clients under the same user must not share one install prefix or lock.
const installKey = `${version}-${process.arch}`;

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

const isPathExistsError = (cause) =>
  cause !== null &&
  typeof cause === "object" &&
  "code" in cause &&
  cause.code === "EEXIST";

const isOlderThanGrace = (path) => {
  try {
    return Date.now() - statSync(path).mtimeMs > ABANDONED_LOCK_GRACE_MS;
  } catch {
    return false;
  }
};

/** Keep listening servers reachable so GC cannot drop a live install lease. */
const heldLockServers = new Set();

/** Bounded digest so POSIX socket paths and Windows pipe names stay unique. */
const lockIdentityKey = (lockPath) =>
  createHash("sha256").update(lockPath).digest("hex").slice(0, 32);

/**
 * Short per-uid lease directory under the process temp root. Lock directories
 * under long TMPDIR paths exceed Linux's ~107-byte pathname limit when the
 * socket lives beside the lock.
 */
const leaseSocketRootPath = () =>
  join(tmpdir(), uid === undefined ? "rea-mcp-l" : `rea-mcp-l-${uid}`);

const ensureLeaseSocketRoot = () => {
  const root = leaseSocketRootPath();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  verifyOwnedCachePath(root, "root");
  return root;
};

const leaseSocketPath = (lockPath) => {
  const key = lockIdentityKey(lockPath);
  if (process.platform === "win32") {
    // Named pipes vanish with the last handle; hash the full lock path so
    // long TEMP prefixes for different pins cannot share a truncated name.
    return `\\\\.\\pipe\\rea-plugin-mcp-lock-${key}`;
  }
  // Hashed name under a short temp directory stays within Linux sun_path.
  return join(leaseSocketRootPath(), `${key}.sock`);
};

/**
 * Live lease for the install lock. The OS ends the listening socket when this
 * process exits, so a reused PID cannot keep the lock (OwnedLease pattern).
 */
const bindLockLease = (lockPath) => {
  const socketPath = leaseSocketPath(lockPath);
  if (process.platform !== "win32") {
    ensureLeaseSocketRoot();
    try {
      rmSync(socketPath, { force: true });
    } catch {
      // A missing socket is the common case for a fresh lock directory.
    }
  }
  const server = createServer();
  server.unref();
  return new Promise((resolve, reject) => {
    const onError = (cause) => {
      server.off("error", onError);
      reject(cause);
    };
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      if (process.platform !== "win32") {
        try {
          // Owner-only socket matches OwnedLease's chmod boundary.
          chmodSync(socketPath, 0o600);
        } catch {
          // Best-effort; directory mode already restricts the parent.
        }
      }
      heldLockServers.add(server);
      writeFileSync(join(lockPath, "pid"), `${String(process.pid)}\n`, {
        mode: 0o600,
      });
      resolve(server);
    });
  });
};

const releaseLockLease = (server) => {
  if (server === undefined) return;
  heldLockServers.delete(server);
  try {
    server.close();
  } catch {
    // The lease may already have ended with the process.
  }
};

/** True only while the recorded lock holder still serves its live lease. */
const lockOwnerAlive = (lockPath) =>
  new Promise((resolve) => {
    const socket = createConnection(leaseSocketPath(lockPath));
    const done = (alive) => {
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {
        // Already closed.
      }
      resolve(alive);
    };
    socket.setTimeout(100);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });

const claimInstallLock = async (lockPath) => {
  mkdirSync(lockPath, { mode: 0o700 });
  verifyOwnedCachePath(lockPath, "lock");
  return bindLockLease(lockPath);
};

/**
 * Exclusive install lock; reclaim only when the live lease is gone.
 * Stale cleanup is serialized through a sibling recovery directory, matching
 * OwnedLease: never delete the lock pathname from an earlier PID read alone.
 */
const tryAcquireInstallLock = async (lockPath) => {
  try {
    return { acquired: true, server: await claimInstallLock(lockPath) };
  } catch (cause) {
    if (!isPathExistsError(cause)) throw cause;
  }

  let ownerAlive = false;
  try {
    verifyOwnedCachePath(lockPath, "lock");
    ownerAlive = await lockOwnerAlive(lockPath);
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("executable cache"))
      throw cause;
    // No owner lease yet: a claimant may be mid-bind. Only an old directory
    // is abandoned; otherwise keep waiting.
    if (!isOlderThanGrace(lockPath)) return { acquired: false };
  }
  if (ownerAlive) return { acquired: false };

  // Serialize stale cleanup through the replacement mkdir: otherwise two
  // recoverers can unlink the lock that one of them has just acquired.
  const recoveryPath = `${lockPath}.recovery`;
  try {
    mkdirSync(recoveryPath, { mode: 0o700 });
  } catch (cause) {
    if (!isPathExistsError(cause)) throw cause;
    // A recoverer that died mid-recovery leaves this directory behind and
    // would otherwise block every later launch.
    if (isOlderThanGrace(recoveryPath)) {
      try {
        rmdirSync(recoveryPath);
      } catch {
        // Another launcher removed or replaced it first; retry on the next poll.
      }
    }
    return { acquired: false };
  }

  try {
    try {
      return { acquired: true, server: await claimInstallLock(lockPath) };
    } catch (cause) {
      if (!isPathExistsError(cause)) throw cause;
    }

    if (await lockOwnerAlive(lockPath)) return { acquired: false };

    rmSync(lockPath, { recursive: true, force: true });
    try {
      return { acquired: true, server: await claimInstallLock(lockPath) };
    } catch (cause) {
      if (!isPathExistsError(cause)) throw cause;
      return { acquired: false };
    }
  } finally {
    try {
      rmdirSync(recoveryPath);
    } catch {
      // Retain a recovery directory whose removal failed.
    }
  }
};

const releaseInstallLock = (lockPath, server) => {
  releaseLockLease(server);
  rmSync(lockPath, { recursive: true, force: true });
};

const cleanupOwnerPath = (staging) => join(staging, CLEANUP_OWNER);

/**
 * Remove a staging tree. On failure, retain an owner record so a later launch
 * can retry cleanup instead of abandoning the residue under a new PID path.
 */
const removeStaging = (staging) => {
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch (cause) {
    try {
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      writeFileSync(
        cleanupOwnerPath(staging),
        `${String(process.pid)}\n${staging}\n`,
        { mode: 0o600 },
      );
    } catch {
      // Keep the original cleanup failure as the reported cause.
    }
    throw cause;
  }
};

/** Retry cleanup for staging directories this install key previously retained. */
const retryRetainedStagingCleanup = () => {
  let entries;
  try {
    entries = readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const prefix = `${installKey}.staging-`;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const staging = join(cacheRoot, entry.name);
    try {
      verifyOwnedCachePath(staging, "prefix");
    } catch {
      continue;
    }
    try {
      accessSync(cleanupOwnerPath(staging));
    } catch {
      continue;
    }
    try {
      removeStaging(staging);
    } catch (cause) {
      process.stderr.write(
        `REA plugin retained staging cleanup ownership at ${staging}: ${cause instanceof Error ? cause.message : String(cause)}.\n`,
      );
    }
  }
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
 * Signal the installer's whole process group on POSIX, or its process tree on
 * Windows. npm runs lifecycle scripts (for example the Frida install script)
 * as children; stopping npm alone leaves them running after the launcher exits
 * and can overlap a retry while staging is removed.
 */
const signalInstaller = (child, signal) => {
  if (process.platform === "win32") {
    if (child.pid === undefined) return;
    // taskkill /T waits for the tree; child.kill() would leave npm's children.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (cause) {
      if (cause?.code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The installer already exited.
  }
};

/**
 * Observe signals and MCP stdin during acquisition. A data listener keeps the
 * stream flowing so end/close fire on disconnect (paused pipes alone do not),
 * while retained chunks are unshifted back for the in-process runtime handoff —
 * the same ownership pattern as StdioStartupInput / processShutdown.
 */
const observeAcquisitionCancel = (onCancel) => {
  const signalExitCodes = SIGNAL_EXIT_CODES;
  /** @type {Buffer[]} */
  const chunks = [];
  let cancelled;
  let released = false;
  const requestCancel = (signal) => {
    if (cancelled !== undefined) return;
    cancelled = { signal };
    onCancel(cancelled);
  };
  const onSignal = (signal) => requestCancel(signal);
  const onInputEnd = () => requestCancel(undefined);
  const onData = (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };
  for (const signal of Object.keys(signalExitCodes))
    process.on(signal, onSignal);
  // data + resume keep the pipe flowing so client EOF reaches end/close;
  // paused stdin alone never delivers disconnect during acquisition.
  process.stdin.on("data", onData);
  process.stdin.on("end", onInputEnd);
  process.stdin.on("close", onInputEnd);
  process.stdin.resume();
  if (process.stdin.readableEnded || process.stdin.destroyed)
    queueMicrotask(onInputEnd);
  return {
    get cancelled() {
      return cancelled;
    },
    release() {
      if (released) return;
      released = true;
      for (const signal of Object.keys(signalExitCodes))
        process.off(signal, onSignal);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stdin.off("end", onInputEnd);
      process.stdin.off("close", onInputEnd);
      // Preserve buffered protocol input for the runtime when acquisition
      // succeeds; discard only when the client already disconnected.
      if (cancelled === undefined) {
        for (let index = chunks.length - 1; index >= 0; index -= 1)
          process.stdin.unshift(chunks[index]);
      }
      chunks.length = 0;
    },
  };
};

/**
 * Own the cold-start installer until it exits. Cancel handlers stay attached
 * only for this acquisition stage; the in-process runtime registers its own.
 */
const runOwnedInstaller = (invocation) => {
  let child;
  let forceTimer;
  /** @type {{ signal?: string } | undefined} */
  let shutdown;
  const cancel = observeAcquisitionCancel((requested) => {
    shutdown = requested;
    if (child === undefined) return;
    const signal = requested.signal ?? "SIGTERM";
    signalInstaller(child, signal);
    forceTimer = setTimeout(() => {
      if (child !== undefined) signalInstaller(child, "SIGKILL");
    }, 1_000);
    forceTimer.unref?.();
  });

  return new Promise((resolve, reject) => {
    try {
      child = spawn(invocation.command, invocation.arguments, {
        // Keep install away from the plugin checkout package.json.
        cwd: tmpdir(),
        env: process.env,
        // Route installer chatter off the MCP JSON-RPC stdout stream.
        stdio: ["ignore", process.stderr, "inherit"],
        windowsHide: true,
        // Lead a new process group on POSIX so cancellation reaches the
        // installer's lifecycle scripts, not just npm.
        detached: process.platform !== "win32",
      });
    } catch (cause) {
      cancel.release();
      reject(cause);
      return;
    }

    if (shutdown !== undefined) {
      const signal = shutdown.signal ?? "SIGTERM";
      signalInstaller(child, signal);
      forceTimer = setTimeout(() => {
        if (child !== undefined) signalInstaller(child, "SIGKILL");
      }, 1_000);
      forceTimer.unref?.();
    }

    child.once("error", (cause) => {
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      cancel.release();
      reject(cause);
    });
    child.once("exit", (status, signal) => {
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      cancel.release();
      if (shutdown !== undefined) {
        // npm is gone; make sure nothing it started outlives staging cleanup.
        signalInstaller(child, "SIGKILL");
        resolve({
          cancelled: true,
          signal: shutdown.signal,
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
  /** @type {(() => void) | undefined} */
  let wakeWait;
  const cancel = observeAcquisitionCancel(() => {
    wakeWait?.();
  });
  try {
    for (;;) {
      if (cancel.cancelled !== undefined)
        return { cancelled: true, signal: cancel.cancelled.signal };
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
      const lock = await tryAcquireInstallLock(lockPath);
      if (lock.acquired)
        return { cancelled: false, acquired: true, server: lock.server };
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
    cancel.release();
  }
};

const cancelExitCode = (signal) =>
  signal === undefined ? 0 : (SIGNAL_EXIT_CODES[signal] ?? 1);

if (process.exitCode === 1) {
  // Argument validation already failed.
} else {
  const prefix = join(cacheRoot, installKey);
  const lockPath = join(cacheRoot, `${installKey}.lock`);
  const staging = join(
    cacheRoot,
    `${installKey}.staging-${String(process.pid)}`,
  );
  let entry;
  /** @type {import("node:net").Server | undefined} */
  let lockServer;

  try {
    ensurePrivateCacheRoot();
    retryRetainedStagingCleanup();
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
    let holdLock = false;
    {
      const lock = await tryAcquireInstallLock(lockPath);
      holdLock = lock.acquired === true;
      lockServer = lock.server;
    }
    if (!holdLock) {
      try {
        const waited = await waitForReadyOrLock(prefix, lockPath);
        if (waited.cancelled) {
          process.exitCode = cancelExitCode(waited.signal);
        } else if (waited.entry !== undefined) {
          entry = waited.entry;
        } else {
          holdLock = true;
          lockServer = waited.server;
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
      // Another client may have published the cache between our first miss and
      // acquiring the lock. Reuse it: installing again would replace a prefix a
      // running MCP process is already importing from.
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
      if (entry !== undefined || process.exitCode === 1) {
        releaseInstallLock(lockPath, lockServer);
        lockServer = undefined;
        holdLock = false;
      }
    }

    if (process.exitCode !== 1 && entry === undefined && holdLock) {
      try {
        removeStaging(staging);
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
            process.exitCode = cancelExitCode(install.signal);
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
        try {
          removeStaging(staging);
        } catch (cause) {
          process.stderr.write(
            `REA plugin retained staging cleanup ownership at ${staging}: ${cause instanceof Error ? cause.message : String(cause)}.\n`,
          );
        } finally {
          releaseInstallLock(lockPath, lockServer);
          lockServer = undefined;
        }
      }
    }
  }

  if (process.exitCode !== 1 && entry !== undefined) {
    process.argv = [process.execPath, entry, "mcp"];
    await import(pathToFileURL(entry).href);
  } else if (entry === undefined) {
    process.exit(process.exitCode ?? 0);
  }
}
