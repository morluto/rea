import {
  lstat,
  readFile,
  readlink,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { withOwnedRegularFile } from "../filesystem/OwnedRegularFile.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import { parseLinuxProcessStat } from "../process/LinuxProcessStat.js";

/** Scenario profile directories REA creates directly inside the temp root. */
export const SCENARIO_PROFILE_PREFIX = "rea-browser-scenario-";

/** Marker the launching REA process writes inside the profile it owns. */
export const SCENARIO_PROFILE_OWNER_FILE = ".rea-scenario-owner.json";

/** Bound the marker before parsing it: it is only a small owner record. */
const OWNER_MARKER_MAX_BYTES = 8 * 1024;
const OWNER_MARKER_READ_TIMEOUT_MS = 2_000;
const OWNER_IDENTITY_TIMEOUT_MS = 5_000;

/** Singleton entries Chromium creates while a profile is open. */
const SINGLETON_LOCK = "SingletonLock";
const SINGLETON_COOKIE = "SingletonCookie";
const SINGLETON_SOCKET = "SingletonSocket";
const SINGLETON_ENTRIES = [
  SINGLETON_LOCK,
  SINGLETON_COOKIE,
  SINGLETON_SOCKET,
] as const;

/** One observation of the process start identity behind a recorded pid. */
export type ScenarioOwnerIdentityObservation =
  | { readonly state: "readable"; readonly identity: string }
  | { readonly state: "gone" }
  | { readonly state: "unavailable" };

/** What one launching process records, so a later run can prove staleness. */
export interface ScenarioProfileOwner {
  readonly schema: 2;
  readonly pid: number;
  readonly created_at: string;
  /**
   * Native start identity of the owning process. A pid alone cannot survive
   * reuse, so an unavailable identity keeps the profile instead of guessing.
   */
  readonly start_identity: string | undefined;
}

/** Filesystem seam used to inspect Chromium's singleton entries. */
export interface SingletonFileSystem {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly readlink: (path: string) => Promise<string>;
}

const DEFAULT_SINGLETON_FILE_SYSTEM: SingletonFileSystem = {
  lstat,
  readlink,
};

/** Whether a process id is still live; EPERM still means the process exists. */
export const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Read a stable process start identity without compiling a native helper.
 * Linux exposes it in procfs; macOS exposes it through `ps`. Other platforms
 * report it as unavailable so reclamation stays fail-closed there.
 */
export const observeScenarioOwnerIdentity = async (
  pid: number,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): Promise<ScenarioOwnerIdentityObservation> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unavailable" };
  if (platform === "linux") {
    let raw: string;
    try {
      raw = await readFile(`/proc/${String(pid)}/stat`, "utf8");
    } catch (cause: unknown) {
      return (cause as NodeJS.ErrnoException).code === "ENOENT"
        ? { state: "gone" }
        : { state: "unavailable" };
    }
    const stat = parseLinuxProcessStat(raw);
    if (stat === undefined) return { state: "unavailable" };
    if (stat.lifecycle === "zombie" || stat.lifecycle === "dead")
      return { state: "gone" };
    return { state: "readable", identity: `linux-starttime:${stat.startTime}` };
  }
  if (platform === "darwin") {
    try {
      const { stdout } = await execFileOutput(
        "ps",
        ["-o", "lstart=", "-p", String(pid)],
        { timeout: OWNER_IDENTITY_TIMEOUT_MS },
      );
      const start = stdout.trim();
      return start === ""
        ? { state: "gone" }
        : { state: "readable", identity: `darwin-lstart:${start}` };
    } catch (cause: unknown) {
      const failure = execFileOutputFailure(cause);
      // `ps -p` exits 1 with no output when no process has that pid.
      if (failure?.code === 1 && (failure.stdout ?? "").trim() === "")
        return { state: "gone" };
      return { state: "unavailable" };
    }
  }
  return { state: "unavailable" };
};

/**
 * Record the owning process and its start identity before the profile is
 * opened. A profile without a recognized marker is never reclaimed, so an
 * older REA release's directory and any foreign directory stay untouched.
 */
export const writeScenarioProfileOwner = async (
  profilePath: string,
  options: {
    readonly pid?: number;
    readonly now?: () => Date;
    readonly platform?: NodeJS.Platform;
    readonly observeIdentity?: (
      pid: number,
    ) => Promise<ScenarioOwnerIdentityObservation>;
  } = {},
): Promise<void> => {
  const pid = options.pid ?? process.pid;
  const platform = options.platform ?? HOST_PLATFORM.platform;
  const observed = await (
    options.observeIdentity ??
    ((ownerPid: number) => observeScenarioOwnerIdentity(ownerPid, platform))
  )(pid);
  const owner: ScenarioProfileOwner = {
    schema: 2,
    pid,
    created_at: (options.now?.() ?? new Date()).toISOString(),
    start_identity:
      observed.state === "readable" ? observed.identity : undefined,
  };
  await writeFile(
    join(profilePath, SCENARIO_PROFILE_OWNER_FILE),
    `${JSON.stringify(owner)}\n`,
    { mode: 0o600 },
  );
};

/**
 * Admit the marker as one bounded regular file. O_NONBLOCK prevents a writer-
 * less named pipe from holding a libuv worker, O_NOFOLLOW prevents following a
 * replacement link, and the deadline bounds the read before JSON parsing.
 */
const readScenarioProfileOwner = async (
  profilePath: string,
): Promise<ScenarioProfileOwner | undefined> => {
  const path = join(profilePath, SCENARIO_PROFILE_OWNER_FILE);
  const signal = AbortSignal.timeout(OWNER_MARKER_READ_TIMEOUT_MS);
  let bytes: Buffer | undefined;
  try {
    bytes = await withOwnedRegularFile(
      path,
      { symlinks: "reject", signal },
      (source) =>
        readBoundedFileBytes(source.handle, OWNER_MARKER_MAX_BYTES, { signal }),
    );
  } catch {
    return undefined;
  }
  if (bytes === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const {
      schema,
      pid,
      created_at: createdAt,
      start_identity: startIdentity,
    } = parsed as Record<string, unknown>;
    if (
      schema !== 2 ||
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof createdAt !== "string" ||
      (startIdentity !== undefined && typeof startIdentity !== "string")
    )
      return undefined;
    return {
      schema: 2,
      pid,
      created_at: createdAt,
      start_identity: startIdentity,
    };
  } catch {
    return undefined;
  }
};

/** The process id Chromium encodes in a SingletonLock target, when readable. */
const singletonLockPid = (target: string): number | undefined => {
  const match = /^(.+)-(\d+)$/u.exec(target);
  if (match === null) return undefined;
  const pid = Number.parseInt(match[2] ?? "", 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

/**
 * Whether some process may still hold this profile open. Only SingletonLock
 * carries a process id: SingletonCookie holds an opaque token and
 * SingletonSocket a socket path. Every answer we cannot prove is "yes": a
 * missing lock, a non-link entry, a failed inspection, an unparseable lock
 * target, or a live lock owner keeps the directory.
 */
const profileLockIsHeld = async (
  profilePath: string,
  isProcessAlive: (pid: number) => boolean,
  fileSystem: SingletonFileSystem,
): Promise<boolean> => {
  let lockTarget: string | undefined;
  for (const entry of SINGLETON_ENTRIES) {
    const path = join(profilePath, entry);
    let stats: Stats;
    try {
      stats = await fileSystem.lstat(path);
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      // A failed inspection is not evidence that no browser holds the profile.
      return true;
    }
    // The Windows singleton form is a regular file; a non-link is unproven.
    if (!stats.isSymbolicLink()) return true;
    let target: string;
    try {
      target = await fileSystem.readlink(path);
    } catch {
      return true;
    }
    if (entry === SINGLETON_LOCK) lockTarget = target;
    // Cookie and socket targets are deliberately not parsed as a lock pid.
  }
  // Chromium publishes the lock before it uses a profile. Without one, an
  // interrupted startup may still leave an orphaned browser using the path.
  if (lockTarget === undefined) return true;
  const pid = singletonLockPid(lockTarget);
  return pid === undefined || isProcessAlive(pid);
};

export interface ScenarioProfileReclamation {
  readonly reclaimed: readonly string[];
  readonly skipped: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
}

/**
 * Reclaim scenario profiles an earlier, terminated REA run could not remove.
 * A profile is removed only when it carries this process's own marker, the
 * recorded owner's start identity is proven gone, and Chromium's published
 * singleton lock names a dead process. Every other directory is reported as
 * skipped and left untouched.
 */
export const reclaimStaleScenarioProfiles = async (
  options: {
    readonly root?: string;
    readonly platform?: NodeJS.Platform;
    readonly isProcessAlive?: (pid: number) => boolean;
    readonly observeIdentity?: (
      pid: number,
    ) => Promise<ScenarioOwnerIdentityObservation>;
    readonly singletonFileSystem?: SingletonFileSystem;
  } = {},
): Promise<ScenarioProfileReclamation> => {
  const root = options.root ?? tmpdir();
  const platform = options.platform ?? HOST_PLATFORM.platform;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const observeIdentity =
    options.observeIdentity ??
    ((pid: number) => observeScenarioOwnerIdentity(pid, platform));
  const singletonFileSystem =
    options.singletonFileSystem ?? DEFAULT_SINGLETON_FILE_SYSTEM;
  const reclaimed: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { reclaimed, skipped };
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(SCENARIO_PROFILE_PREFIX)) continue;
    // A symlink is never a directory REA owns, even when it resolves to one.
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const owner = await readScenarioProfileOwner(path);
    if (owner === undefined) {
      skipped.push({ path, reason: "no owner marker" });
      continue;
    }
    if (owner.start_identity === undefined) {
      skipped.push({ path, reason: "owner identity unknown" });
      continue;
    }
    let observed: ScenarioOwnerIdentityObservation;
    try {
      observed = await observeIdentity(owner.pid);
    } catch {
      observed = { state: "unavailable" };
    }
    if (observed.state === "unavailable") {
      skipped.push({ path, reason: "owner identity unknown" });
      continue;
    }
    if (
      observed.state === "readable" &&
      observed.identity === owner.start_identity
    ) {
      skipped.push({ path, reason: "owner is live" });
      continue;
    }
    if (await profileLockIsHeld(path, isProcessAlive, singletonFileSystem)) {
      skipped.push({ path, reason: "profile lock is held" });
      continue;
    }
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
      reclaimed.push(path);
    } catch {
      skipped.push({ path, reason: "removal failed" });
    }
  }
  return { reclaimed, skipped };
};
