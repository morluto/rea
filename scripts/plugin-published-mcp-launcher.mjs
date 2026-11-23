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
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { npmInvocation } from "./lib/npm-invocation.mjs";

// Marketplace and Codex checkouts keep source package.json at the plugin root.
// Install the published artifact under an owner-private cache (POSIX tmpdir, or
// Windows LOCALAPPDATA — never a shared TEMP) and run it in-process so the
// plugin client owns the same process that registered shutdown handlers. An
// npx/npm script-shell child can exit without delivering signals or awaiting
// rea, orphaning session/provider resources.
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

/** POSIX uid when the host reports one; Windows uses LOCALAPPDATA + DACL. */
const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

const cacheDirectoryName =
  uid === undefined ? "rea-plugin-mcp" : `rea-plugin-mcp-${uid}`;

/**
 * Parent of the executable cache. POSIX uses the process temp root; Windows
 * uses per-user LOCALAPPDATA so a shared TEMP/TMP (for example C:\\Temp) cannot
 * host a foreign ready cache. Mirrors PrivateRuntimeRoot's Windows privacy
 * boundary at the script layer without the native addon.
 */
const cacheParentRoot = () => {
  if (process.platform !== "win32") return tmpdir();
  const local = process.env.LOCALAPPDATA?.trim();
  if (local) return local;
  throw new Error("LOCALAPPDATA is required for the Windows executable cache");
};

/**
 * Logical spelling until ensurePrivateCacheRoot admits the cache parent and
 * rewrites this to the physical path used for lock and lease identity.
 * Windows prefers LOCALAPPDATA when set; admission still requires it.
 */
let cacheRoot = join(
  process.platform === "win32" && process.env.LOCALAPPDATA?.trim()
    ? process.env.LOCALAPPDATA.trim()
    : tmpdir(),
  cacheDirectoryName,
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

/** Current Windows account name required for icacls owner-private DACLs. */
const windowsCacheUser = () => {
  const user = process.env.USERNAME?.trim();
  if (!user)
    throw new Error("USERNAME is required to verify Windows cache ownership");
  return user;
};

/**
 * Trusted Windows system root for absolute helper paths. Prefer SystemRoot /
 * windir; fall back to C:\Windows when neither is set. Bare-name CreateProcess
 * lookup would search the caller's CWD first (WindowsExecutable policy).
 */
const windowsSystemRoot = () =>
  process.env.SystemRoot?.trim() || process.env.windir?.trim() || "C:\\Windows";

/** Absolute System32 helper — never a bare name that restarts CWD lookup. */
const windowsSystem32Helper = (...segments) =>
  win32.join(windowsSystemRoot(), "System32", ...segments);

const windowsIcacls = () => windowsSystem32Helper("icacls.exe");
const windowsTaskkill = () => windowsSystem32Helper("taskkill.exe");
const windowsPowerShell = () =>
  windowsSystem32Helper("WindowsPowerShell", "v1.0", "powershell.exe");

/**
 * Windows PowerShell environment for SID ACL observers. Drop a caller's
 * PSModulePath so pwsh module paths cannot break Windows PowerShell.
 */
const windowsPowerShellEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name.toLowerCase() !== "psmodulepath",
    ),
  );

/** Bound a hung powershell.exe ACL observer (cold start on a starved host). */
const WINDOWS_PRIVATE_ACL_OBSERVER_TIMEOUT_MS = 60_000;

/**
 * SYSTEM well-known SID. Matches native verifyPrivate / PrivateRuntimeRoot:
 * private objects allow only the current user and SYSTEM — never Administrators
 * or display-name trustees.
 */
const WINDOWS_SYSTEM_SID = "S-1-5-18";

/**
 * Set the Windows object owner to the current account. Elevated tokens default
 * new-object owners to Administrators; inspectWindowsPrivateAcl requires the
 * account SID (native filesystem.cc SetSecurityDescriptorOwner). Call only
 * after lstat rejected symlinks/junctions — icacls follows links.
 */
const establishWindowsPrivateOwner = (path, kind) => {
  const user = windowsCacheUser();
  const result = spawnSync(windowsIcacls(), [path, "/setowner", user], {
    encoding: "utf8",
    windowsHide: true,
    // Neutral cwd: bare-name resolution is already avoided; still refuse to
    // inherit an untrusted plugin checkout as the helper working directory.
    cwd: tmpdir(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `executable cache ${kind} could not establish user ownership${detail ? `: ${detail}` : ""}`,
    );
  }
};

/**
 * Apply account ownership plus a user+SYSTEM protected DACL matching native
 * PrivateRuntimeRoot. Call only after lstat rejected symlinks/junctions —
 * icacls follows links.
 */
const applyWindowsPrivateAcl = (path, kind) => {
  establishWindowsPrivateOwner(path, kind);
  const user = windowsCacheUser();
  const grant =
    kind === "entry" || kind === "ready"
      ? [`${user}:F`, "SYSTEM:F"]
      : [`${user}:(OI)(CI)F`, "SYSTEM:(OI)(CI)F"];
  const result = spawnSync(
    windowsIcacls(),
    [path, "/inheritance:r", "/grant:r", grant[0], "/grant:r", grant[1]],
    { encoding: "utf8", windowsHide: true, cwd: tmpdir() },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `executable cache ${kind} could not establish a private DACL${detail ? `: ${detail}` : ""}`,
    );
  }
};

/**
 * Confirm owner and every access ACE by SID, matching native verifyPrivate.
 * Root directories require a protected DACL; files may inherit safe ACEs from
 * that private parent — AreAccessRulesProtected is not itself inherited, so
 * npm/writeFileSync entries inside a private staging tree stay unprotected.
 * Display-name icacls text cannot prove ownership or exclude foreign writers;
 * unresolved identity stays unknown and refuses the warm cache (fail closed).
 * Reads only SecurityIdentifier forms — never Get-Acl / NTAccount translation.
 */
const inspectWindowsPrivateAcl = (path, kind) => {
  const fileKind = kind === "entry" || kind === "ready";
  // Keep account-name resolution out of the observer: DirectorySecurity /
  // FileSecurity + GetOwner/GetAccessRules with SecurityIdentifier only.
  const observer = `
$ErrorActionPreference = 'Stop'
$p = $env:REA_PLUGIN_CACHE_ACL_PATH
if ([string]::IsNullOrEmpty($p)) { throw 'cache path is unresolved' }
$sid = [Security.Principal.SecurityIdentifier]
$sections = [Security.AccessControl.AccessControlSections]'Access, Owner'
$security = if ($env:REA_PLUGIN_CACHE_ACL_FILE -eq '1') {
  [Security.AccessControl.FileSecurity]::new($p, $sections)
} else {
  [Security.AccessControl.DirectorySecurity]::new($p, $sections)
}
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($user -eq $null -or $user -isnot $sid) { throw 'current user SID is unresolved' }
$owner = $security.GetOwner($sid)
if ($owner -isnot $sid) { throw 'ACL owner observation must stay in SID form' }
if ($owner.Value -ne $user.Value) { throw 'owner is not the current user' }
# Match verifyPrivate(root): only the private root directory requires
# SE_DACL_PROTECTED. Files keep SID owner/ACE checks with inherited ACLs.
if ($env:REA_PLUGIN_CACHE_ACL_FILE -ne '1' -and -not $security.AreAccessRulesProtected) {
  throw 'private DACL must be protected'
}
$rules = $security.GetAccessRules($true, $true, $sid)
if ($rules.Count -ne 2) { throw 'private DACL contains unexpected trustees' }
$sawUser = $false
$sawSystem = $false
foreach ($rule in $rules) {
  $trustee = $rule.IdentityReference
  if ($trustee -isnot $sid) { throw 'ACL rule observation must stay in SID form' }
  if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
    throw 'private DACL contains unsupported ACE type'
  }
  if ($trustee.Value -eq $user.Value) { $sawUser = $true; continue }
  if ($trustee.Value -eq '${WINDOWS_SYSTEM_SID}') { $sawSystem = $true; continue }
  throw 'private DACL permits an unrelated principal'
}
if (-not ($sawUser -and $sawSystem)) {
  throw 'private DACL must allow only current user and SYSTEM'
}
`;
  const result = spawnSync(
    windowsPowerShell(),
    ["-NoProfile", "-NonInteractive", "-Command", observer],
    {
      encoding: "utf8",
      windowsHide: true,
      cwd: tmpdir(),
      timeout: WINDOWS_PRIVATE_ACL_OBSERVER_TIMEOUT_MS,
      env: {
        ...windowsPowerShellEnvironment(),
        REA_PLUGIN_CACHE_ACL_PATH: path,
        REA_PLUGIN_CACHE_ACL_FILE: fileKind ? "1" : "0",
      },
    },
  );
  if (result.error) {
    throw new Error(
      `executable cache ${kind} ownership cannot be verified: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    const ownership =
      /owner is not the current user/iu.test(detail) ||
      /current user SID is unresolved/iu.test(detail) ||
      /ACL owner observation must stay in SID form/iu.test(detail);
    throw new Error(
      ownership
        ? `executable cache ${kind} is not owned by this user${detail ? `: ${detail}` : ""}`
        : `executable cache ${kind} is not private to this user${detail ? `: ${detail}` : ""}`,
    );
  }
};

const verifyWindowsOwnedCachePath = (path, kind) => {
  try {
    inspectWindowsPrivateAcl(path, kind);
  } catch (cause) {
    if (kind === "entry" || kind === "ready") throw cause;
    // Directories may still carry a parent-inherited ACL after mkdir; tighten
    // then re-check, matching POSIX tightenOwnedDirectory after ownership.
    applyWindowsPrivateAcl(path, kind);
    inspectWindowsPrivateAcl(path, kind);
  }
};

/**
 * Refuse foreign or group/other-writable cache paths before trusting an
 * executable entry. Owner-only directories match PrivateRuntimeRoot's POSIX
 * boundary; Windows uses a verified user+SYSTEM DACL under LOCALAPPDATA.
 * Files must not be group/other-writable. Never chmod or icacls a path before
 * an lstat ownership/symlink check — path chmod and icacls follow links.
 */
const verifyOwnedCachePath = (path, kind) => {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink())
    throw new Error(`executable cache ${kind} must not be a symlink`);
  if (kind === "root" || kind === "prefix" || kind === "lock") {
    if (!stats.isDirectory())
      throw new Error(`executable cache ${kind} must be a directory`);
  } else if (!stats.isFile()) {
    throw new Error(`executable cache ${kind} must be a regular file`);
  }
  if (process.platform === "win32") {
    verifyWindowsOwnedCachePath(path, kind);
    return;
  }
  if (uid === undefined)
    throw new Error(`executable cache ${kind} ownership cannot be verified`);
  if (stats.uid !== uid)
    throw new Error(`executable cache ${kind} is not owned by this user`);
  const foreign = kind === "entry" || kind === "ready" ? 0o022 : 0o077;
  if ((stats.mode & foreign) === 0) return;
  if (kind === "entry" || kind === "ready")
    throw new Error(`executable cache ${kind} is writable by others`);
  tightenOwnedDirectory(path, kind);
};

/**
 * Physical spelling of a temporary root. Symlink-equivalent TMPDIR values must
 * share cache lock and lease-socket identity; keep the selected spelling when
 * the host cannot resolve it. Use native realpath so a symlink-then-`..`
 * spelling is not collapsed lexically before the filesystem resolves it.
 */
const resolvedTemporaryRoot = (temporaryRoot = tmpdir()) => {
  try {
    return realpathSync.native(temporaryRoot);
  } catch {
    return temporaryRoot;
  }
};

const ensurePrivateCacheRoot = () => {
  const parent = cacheParentRoot();
  // Admit the selected parent before canonicalizing so symlink-equivalent
  // TMPDIR/LOCALAPPDATA spellings share one physical cache and lease identity
  // (PrivateRuntimeRoot physical-path boundary). `${parent}/.` keeps a POSIX
  // symlink-then-`..` TMPDIR unnormalized; path.join would collapse it first.
  statSync(parent === "" ? parent : `${parent}/.`);
  cacheRoot = join(resolvedTemporaryRoot(parent), cacheDirectoryName);
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  // verifyOwnedCachePath lstats before any icacls/chmod so a planted
  // junction/symlink cannot redirect a privacy rewrite to its target.
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
 * sockaddr_un.sun_path usable bytes (excluding the NUL). Darwin is 104 total
 * (103 usable); Linux is 108 (107 usable). Matches the platform split in
 * GhidraTransport without OpenJDK's two-byte NIO reservation.
 */
const POSIX_SOCKET_PATH_LIMIT = process.platform === "darwin" ? 103 : 107;

const leaseDirectoryName = () =>
  uid === undefined ? "rea-mcp-l" : `rea-mcp-l-${uid}`;

/**
 * Owner-private lease directory whose complete socket pathname fits sun_path.
 * Prefer the resolved process temp root so short and long symlink spellings of
 * the same directory share one socket; when that root is already long (nested
 * TMPDIR hygiene layouts), fall back to `/tmp` so hashing the filename alone
 * cannot still exceed the Unix-socket pathname limit.
 */
const leaseSocketRootPath = () => {
  const name = leaseDirectoryName();
  const sampleName = `${"0".repeat(32)}.sock`;
  for (const root of [
    join(resolvedTemporaryRoot(), name),
    join("/tmp", name),
  ]) {
    if (
      Buffer.byteLength(join(root, sampleName), "utf8") <=
      POSIX_SOCKET_PATH_LIMIT
    )
      return root;
  }
  return join("/tmp", name);
};

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
  // Hashed name under a length-checked owner-private directory.
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
    // Missing or refused lease is not proof of abandonment; grace decides.
  }
  if (ownerAlive) return { acquired: false };
  // Fresh lock without a listening lease: the claimant may still be mid-bind
  // after mkdirSync and before the lease starts listening. Ownership of the
  // lock directory is not readiness of the lease; treat that window as pending.
  if (!isOlderThanGrace(lockPath)) return { acquired: false };

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
    // A failed install may release the old lock after the outer age check, and
    // a third client can claim the pathname before this recheck. The fresh
    // claimant has not bound its lease yet, so ownership of the lock directory
    // is not readiness of the lease; treat that window as pending.
    if (!isOlderThanGrace(lockPath)) return { acquired: false };

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
  if (process.platform === "win32") {
    // Elevated npm/writeFileSync may leave Administrators as owner (native
    // process.cc normalizes the child's default owner). Establish the account
    // SID on installer outputs without rewriting inherited file DACLs.
    establishWindowsPrivateOwner(cacheEntry(staging), "entry");
    establishWindowsPrivateOwner(readyMarkerPath(staging), "ready");
  }
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
    spawnSync(windowsTaskkill(), ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      cwd: tmpdir(),
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
 * Same capacity ownStdioStartupInput uses via
 * `@modelcontextprotocol/server`'s STDIO_DEFAULT_MAX_BUFFER_SIZE. The launcher
 * cannot import that package before the published install finishes.
 */
const STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;

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
  let retainedBytes = 0;
  /** @type {Buffer | undefined} */
  let tail;
  let tailBytes = 0;
  let cancelled;
  let released = false;
  const requestCancel = (signal, capacityExceeded = false) => {
    if (cancelled !== undefined) return;
    cancelled = { signal, capacityExceeded };
    onCancel(cancelled);
  };
  const onSignal = (signal) => requestCancel(signal);
  const onInputEnd = () => requestCancel(undefined);
  const detachInput = () => {
    process.stdin.pause();
    process.stdin.off("data", onData);
    process.stdin.off("end", onInputEnd);
    process.stdin.off("close", onInputEnd);
  };
  const onData = (chunk) => {
    const incomingBytes = Buffer.isBuffer(chunk)
      ? chunk.byteLength
      : Buffer.byteLength(chunk);
    // Match ownStdioStartupInput: stop reading and cancel before retaining an
    // overflowing chunk so acquisition cannot grow without bound.
    if (retainedBytes + incomingBytes > STDIO_DEFAULT_MAX_BUFFER_SIZE) {
      detachInput();
      requestCancel(undefined, true);
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.byteLength) {
      // Bound chunk bookkeeping too, even when stdin delivers one byte per event.
      tail ??= Buffer.allocUnsafe(
        Math.min(64 * 1024, STDIO_DEFAULT_MAX_BUFFER_SIZE - retainedBytes),
      );
      const copied = Math.min(
        tail.byteLength - tailBytes,
        bytes.byteLength - offset,
      );
      bytes.copy(tail, tailBytes, offset, offset + copied);
      offset += copied;
      retainedBytes += copied;
      tailBytes += copied;
      if (tailBytes === tail.byteLength) {
        chunks.push(tail);
        tail = undefined;
        tailBytes = 0;
      }
    }
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
      detachInput();
      // Preserve buffered protocol input for the runtime when acquisition
      // succeeds; discard only when the client already disconnected or the
      // stdio capacity refused further retention.
      if (cancelled === undefined) {
        if (tail !== undefined && tailBytes > 0)
          chunks.push(tail.subarray(0, tailBytes));
        for (let index = chunks.length - 1; index >= 0; index -= 1)
          process.stdin.unshift(chunks[index]);
        // Leave stdin paused until a later data listener owns it. Resuming
        // here would drain the unshifted handshake before serveStdio (or a
        // fixture transport) attaches; the deferred path never resumes a
        // paused stdin itself, unlike eagerRuntime's explicit handoff/resume.
        const resumeWhenOwned = (event) => {
          if (event !== "data") return;
          process.stdin.off("newListener", resumeWhenOwned);
          queueMicrotask(() => {
            if (!process.stdin.readableEnded && !process.stdin.destroyed)
              process.stdin.resume();
          });
        };
        process.stdin.on("newListener", resumeWhenOwned);
      }
      chunks.length = 0;
      tail = undefined;
      tailBytes = 0;
      retainedBytes = 0;
    },
  };
};

/**
 * Own the cold-start installer until it exits. Caller retains cancel ownership
 * through staging cleanup and lock release; release only before the in-process
 * runtime registers its own handlers (or before exiting after finalization).
 *
 * @param {{
 *   command: string,
 *   arguments: string[],
 * }} invocation
 * @param {{
 *   child: import("node:child_process").ChildProcess | undefined,
 *   forceTimer: ReturnType<typeof setTimeout> | undefined,
 *   shutdown: { signal?: string, capacityExceeded?: boolean } | undefined,
 * }} installer Mutable installer supervision state shared with the cancel observer.
 */
const runOwnedInstaller = (invocation, installer) =>
  new Promise((resolve, reject) => {
    try {
      installer.child = spawn(invocation.command, invocation.arguments, {
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
      reject(cause);
      return;
    }

    const child = installer.child;
    if (installer.shutdown !== undefined) {
      const signal = installer.shutdown.signal ?? "SIGTERM";
      signalInstaller(child, signal);
      installer.forceTimer = setTimeout(() => {
        if (installer.child !== undefined)
          signalInstaller(installer.child, "SIGKILL");
      }, 1_000);
      installer.forceTimer.unref?.();
    }

    child.once("error", (cause) => {
      if (installer.forceTimer !== undefined)
        clearTimeout(installer.forceTimer);
      reject(cause);
    });
    child.once("exit", (status, signal) => {
      if (installer.forceTimer !== undefined)
        clearTimeout(installer.forceTimer);
      if (installer.shutdown !== undefined) {
        // npm is gone; make sure nothing it started outlives staging cleanup.
        signalInstaller(child, "SIGKILL");
        resolve({
          cancelled: true,
          signal: installer.shutdown.signal,
          capacityExceeded: installer.shutdown.capacityExceeded === true,
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

const cancelExitCode = (signal) =>
  signal === undefined ? 0 : (SIGNAL_EXIT_CODES[signal] ?? 1);

/**
 * Let queued callbacks and pending OS signals run while a cancel observer is
 * still installed. Matches dispatchQueuedInterrupts: one macrotask for queued
 * work, then one for signal handlers a prior sync section left pending (for
 * example SIGTERM during removeStaging's rmSync).
 */
const allowPendingCancellation = async () => {
  await nextMacrotask();
  await nextMacrotask();
};

/**
 * Own SIGINT/SIGTERM only through startup retained-staging cleanup. Do not
 * observe stdin here: a ready-cache launch must still deliver client input to
 * the in-process runtime, and acquisition installs its own stdin cancel later.
 */
const observeStartupCleanupCancel = () => {
  /** @type {{ signal: string, capacityExceeded: false } | undefined} */
  let cancelled;
  let released = false;
  const onSignal = (signal) => {
    if (cancelled !== undefined) return;
    cancelled = { signal, capacityExceeded: false };
  };
  for (const signal of Object.keys(SIGNAL_EXIT_CODES))
    process.on(signal, onSignal);
  return {
    get cancelled() {
      return cancelled;
    },
    release() {
      if (released) return;
      released = true;
      for (const signal of Object.keys(SIGNAL_EXIT_CODES))
        process.off(signal, onSignal);
    },
  };
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
        return {
          cancelled: true,
          signal: cancel.cancelled.signal,
          capacityExceeded: cancel.cancelled.capacityExceeded === true,
        };
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
      if (lock.acquired) {
        // SIGTERM during the awaited acquisition is recorded on this observer;
        // recheck before handing the lock to the installer, which starts a new
        // observer that cannot see an already-consumed signal. Yield first so a
        // signal that arrived during sync lock work can run before release.
        await allowPendingCancellation();
        if (cancel.cancelled !== undefined) {
          releaseInstallLock(lockPath, lock.server);
          return {
            cancelled: true,
            signal: cancel.cancelled.signal,
            capacityExceeded: cancel.cancelled.capacityExceeded === true,
          };
        }
        return { cancelled: false, acquired: true, server: lock.server };
      }
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

/** Fail like ownStdioStartupInput when acquisition stdin exceeds stdio capacity. */
const applyAcquisitionCancel = (cancelled) => {
  if (cancelled.capacityExceeded) {
    process.stderr.write(
      "MCP input exceeded the stdio buffer capacity before startup completed.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.exitCode = cancelExitCode(cancelled.signal);
};

if (process.exitCode === 1) {
  // Argument validation already failed.
} else {
  let entry;
  /** @type {import("node:net").Server | undefined} */
  let lockServer;
  /** @type {string} */
  let prefix;
  /** @type {string} */
  let lockPath;
  /** @type {string} */
  let staging;

  // Keep signal cancel owned through retained-staging cleanup retry so a
  // SIGTERM during rmSync cannot abandon an unmarked tree (marker may already
  // be gone while sibling files remain). Match install-finalization ownership
  // for signals only; stdin stays for the ready runtime or later acquisition.
  const startupCancel = observeStartupCleanupCancel();
  try {
    ensurePrivateCacheRoot();
    // Derive install paths from the admitted physical cache root so lease
    // identity cannot diverge across symlink-equivalent TMPDIR spellings.
    prefix = join(cacheRoot, installKey);
    lockPath = join(cacheRoot, `${installKey}.lock`);
    staging = join(cacheRoot, `${installKey}.staging-${String(process.pid)}`);
    retryRetainedStagingCleanup();
    // Yield so a SIGTERM that arrived during sync rmSync can run while this
    // observer is still installed (Node cannot deliver it until JavaScript yields).
    await allowPendingCancellation();
    if (startupCancel.cancelled !== undefined) {
      applyAcquisitionCancel(startupCancel.cancelled);
    }
  } catch (cause) {
    refuseUntrustedCache(cause);
  } finally {
    startupCancel.release();
  }

  if (startupCancel.cancelled !== undefined) {
    process.exit(process.exitCode ?? 0);
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
          applyAcquisitionCancel(waited);
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
      /** @type {{
       *   child: import("node:child_process").ChildProcess | undefined,
       *   forceTimer: ReturnType<typeof setTimeout> | undefined,
       *   shutdown: { signal?: string, capacityExceeded?: boolean } | undefined,
       * }} */
      const installer = {
        child: undefined,
        forceTimer: undefined,
        shutdown: undefined,
      };
      // Keep cancel owned through staging cleanup and lock release so a signal
      // during finalization is deferred instead of abandoning an unmarked tree.
      const cancel = observeAcquisitionCancel((requested) => {
        installer.shutdown = requested;
        if (installer.child === undefined) return;
        const signal = requested.signal ?? "SIGTERM";
        signalInstaller(installer.child, signal);
        installer.forceTimer = setTimeout(() => {
          if (installer.child !== undefined)
            signalInstaller(installer.child, "SIGKILL");
        }, 1_000);
        installer.forceTimer.unref?.();
      });
      try {
        removeStaging(staging);
        mkdirSync(staging, { recursive: true, mode: 0o700 });
        verifyOwnedCachePath(staging, "prefix");

        let invocation;
        try {
          // --prefix alone does not override ambient global=true /
          // npm_config_global; Unix then writes {prefix}/lib/node_modules while
          // cacheEntry() requires {prefix}/node_modules.
          invocation = npmInvocation(
            [
              "install",
              "--omit=dev",
              "--no-fund",
              "--no-audit",
              "--no-update-notifier",
              "--global=false",
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
          const install = await runOwnedInstaller(invocation, installer);
          if (install.cancelled) {
            applyAcquisitionCancel(install);
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
          // A signal during finalization was only recorded; apply it after
          // cleanup and lock release so exit status matches the client request.
          // Yield first so a SIGTERM that arrived during sync rmSync can run
          // while this observer is still installed (Node cannot deliver it
          // until JavaScript yields).
          await allowPendingCancellation();
          if (cancel.cancelled !== undefined) {
            applyAcquisitionCancel(cancel.cancelled);
            entry = undefined;
          }
          cancel.release();
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
