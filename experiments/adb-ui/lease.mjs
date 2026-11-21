import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

// Shared across worktrees, output directories and ADB server spellings. Using
// serial alone deliberately also serializes equal serials on different servers.
const DEFAULT_DIRECTORY = join(
  userInfo().homedir,
  ".cache",
  "rea",
  "adb-ui-leases",
);

/** Persistent cooperative lease; never infer safe recovery from a stale PID. */
export async function acquireFixtureLease({
  serial,
  packageName,
  output,
  directory = DEFAULT_DIRECTORY,
}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  assert(
    parent.isDirectory() &&
      (process.getuid === undefined || parent.uid === process.getuid()),
    "Fixture lease directory is not owned by this user",
  );
  assert(
    process.platform === "win32" || (parent.mode & 0o077) === 0,
    "Fixture lease directory must be private",
  );
  const key = createHash("sha256")
    .update(JSON.stringify([serial, packageName]))
    .digest("hex");
  const path = join(directory, `${key}.json`);
  const record = {
    run_id: randomUUID(),
    serial,
    package: packageName,
    output_directory: output,
  };
  const handle = await open(path, "wx", 0o600).catch((cause) => {
    throw new Error(
      `Fixture lease is unavailable at ${path}; reconcile the recorded run before removing its lease`,
      { cause },
    );
  });
  let removed = false;
  let closed = false;
  const lease = {
    path,
    record,
    async release() {
      if (closed) return;
      if (!removed) {
        const [opened, named] = await Promise.all([handle.stat(), lstat(path)]);
        // Identity, not the validity of the record's text, authorizes removal.
        assert(
          named.isFile() &&
            opened.dev === named.dev &&
            opened.ino === named.ino,
          "Fixture lease pathname no longer identifies this run's file",
        );
        await unlink(path);
        removed = true;
      }
      await handle.close();
      closed = true;
    },
  };
  try {
    await handle.writeFile(JSON.stringify(record, null, 2));
    await handle.sync();
    return lease;
  } catch (cause) {
    try {
      await lease.release();
    } catch (cleanup) {
      const error = new AggregateError(
        [cause, cleanup],
        "Fixture lease initialization cleanup failed",
        { cause },
      );
      error.cleanupLease = lease;
      throw error;
    }
    throw cause;
  }
}
