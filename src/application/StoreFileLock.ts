import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";

/** One acquired store transaction lock with cleanup bound to its unique owner. */
export interface StoreFileLock {
  readonly release: () => Promise<void>;
}

class StoreFileLockOccupied extends Error {
  readonly code = "EEXIST";

  constructor(cause?: unknown) {
    super("Store transaction lock is occupied", { cause });
  }
}

/** Atomically publish a populated directory so another owner cannot replace a live lock. */
export const createStoreFileLock = async (
  path: string,
): Promise<StoreFileLock> => {
  if (await exists(path)) throw new StoreFileLockOccupied();
  const staged = await mkdtemp(join(dirname(path), ".rea-store-lock-"));
  const owner = `owner-${randomUUID()}`;
  try {
    const handle = await open(join(staged, owner), "wx", 0o600);
    try {
      await handle.writeFile(`${String(process.pid)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // Rename cannot replace a nonempty directory: the owner entry is present before publication.
      await rename(staged, path);
    } catch (cause: unknown) {
      if (await exists(path)) throw new StoreFileLockOccupied(cause);
      throw cause;
    }
    return {
      release: async () => {
        await removeOwner(path, owner).catch((cause: unknown) => {
          // best-effort cleanup: lock release must not reject unhandled.
          void cause;
        });
      },
    };
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
};

/** Recover a dead owner's directory lock or a legacy PID file; leave live and unknown owners intact. */
export const removeStaleStoreFileLock = async (
  path: string,
): Promise<boolean> => {
  try {
    const stats = await lstat(path);
    if (stats.isFile()) {
      if (!(await ownerIsDead(path))) return false;
      await unlink(path);
      return true;
    }
    if (!stats.isDirectory()) return false;
    const entries = await readdir(path);
    if (entries.length === 0) {
      await rmdir(path);
      return true;
    }
    const owner = entries[0];
    if (
      entries.length !== 1 ||
      owner === undefined ||
      !/^owner-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(owner) ||
      !(await ownerIsDead(join(path, owner)))
    )
      return false;
    await removeOwner(path, owner);
    return true;
  } catch (cause: unknown) {
    // best-effort cleanup: stale lock probing; failure means the lock stands.
    void cause;
    return false;
  }
};

const removeOwner = async (path: string, owner: string): Promise<void> => {
  // A successor has a different entry, so stale cleanup cannot make its directory empty.
  await unlink(join(path, owner));
  await rmdir(path);
};

const ownerIsDead = async (path: string): Promise<boolean> => {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.size > 32) return false;
  const handle = await open(path, "r");
  let bytes: Buffer | undefined;
  try {
    bytes = await readBoundedFileBytes(handle, 32);
  } finally {
    await handle.close();
  }
  const encoded = bytes?.toString("utf8").trim();
  return (
    encoded !== undefined &&
    /^[1-9][0-9]{0,9}$/u.test(encoded) &&
    !processIsAlive(Number(encoded))
  );
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (cause: unknown) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    return errorCode(cause) !== "ESRCH";
  }
};

const errorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? cause.code
    : undefined;
