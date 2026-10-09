import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type {
  FileState,
  ProcessScenario,
} from "../../domain/process/processCapture.js";
import type { Stats } from "node:fs";
import type { FilesystemCoverage } from "../../domain/process/processCaptureCoverage.js";

export interface SnapshotResult {
  readonly files: readonly FileState[];
  readonly truncated: boolean;
  /** Root aliases whose path enumeration was exhausted, regardless of hash coverage. */
  readonly completeRoots: readonly string[];
  readonly coverage?: FilesystemCoverage;
}

const hasSameIdentity = (
  before: Stats,
  after: Stats,
  expected: "directory" | "symlink",
): boolean =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  (expected === "directory" ? after.isDirectory() : after.isSymbolicLink());

const hasSameFileState = (before: Stats, after: Stats): boolean =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.isFile() &&
  after.isFile() &&
  before.mode === after.mode &&
  before.size === after.size &&
  before.mtimeMs === after.mtimeMs &&
  before.ctimeMs === after.ctimeMs;

const lstatIfPresent = async (path: string): Promise<Stats | undefined> => {
  try {
    return await lstat(path);
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
};

/** Hash a file only when its opened descriptor still matches the captured path state. */
export const hashFile = async (
  path: string,
  expected: Stats,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | null> => {
  signal?.throwIfAborted();
  const handle = await open(
    path,
    fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    signal?.throwIfAborted();
    const stats = await handle.stat();
    signal?.throwIfAborted();
    if (!hasSameFileState(expected, stats) || stats.size > maxBytes)
      return null;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes));
    let position = 0;
    while (position < stats.size) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stats.size - position),
        position,
      );
      if (bytesRead === 0) return null;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    signal?.throwIfAborted();
    if (!hasSameFileState(stats, after)) return null;
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};

/** Capture bounded, root-aliased filesystem state without following symlinks. */
export const snapshotRoots = async (
  scenario: ProcessScenario,
  signal?: AbortSignal,
): Promise<SnapshotResult> => {
  const entries: FileState[] = [];
  const completeRoots: string[] = [];
  let remainingBytes = scenario.limits.file_bytes;
  let truncated = false;
  const enumerationReasons = new Set<
    FilesystemCoverage["enumeration_reasons"][number]
  >();
  const hashOmissions: FilesystemCoverage["hash_omissions"] = [];
  const visit = async (
    root: string,
    rootAlias: string,
    path: string,
    depth: number,
  ): Promise<boolean> => {
    signal?.throwIfAborted();
    if (
      entries.length >= scenario.limits.files ||
      depth > scenario.limits.filesystem_depth
    ) {
      truncated = true;
      if (entries.length >= scenario.limits.files)
        enumerationReasons.add("files_limit");
      if (depth > scenario.limits.filesystem_depth)
        enumerationReasons.add("depth_limit");
      return false;
    }
    const stats = await lstatIfPresent(path);
    if (stats === undefined) return true;
    const relativePath = relative(root, path) || ".";
    if (stats.isSymbolicLink()) {
      const target = resolve(dirname(path), await readlink(path));
      const afterRead = await lstat(path);
      if (!hasSameIdentity(stats, afterRead, "symlink")) {
        truncated = true;
        enumerationReasons.add("identity_changed");
        return false;
      }
      entries.push({
        path: `${rootAlias}:${relativePath}`,
        type: "symlink",
        mode: stats.mode,
        size: stats.size,
        sha256: null,
        symlink_target: target,
      });
      return true;
    }
    if (stats.isFile()) {
      const sha256 =
        remainingBytes >= stats.size
          ? await hashFile(path, stats, remainingBytes, signal)
          : null;
      remainingBytes -= sha256 === null ? 0 : stats.size;
      if (sha256 === null) {
        truncated = true;
        hashOmissions.push({
          path: `${rootAlias}:${relativePath}`,
          size_bytes: stats.size,
          remaining_budget_bytes: remainingBytes,
          reason:
            remainingBytes < stats.size
              ? "file_bytes_budget"
              : "file_changed_or_short_read",
        });
      }
      entries.push({
        path: `${rootAlias}:${relativePath}`,
        type: "file",
        mode: stats.mode,
        size: stats.size,
        sha256,
        symlink_target: null,
      });
      return true;
    }
    const type = stats.isDirectory() ? "directory" : "other";
    entries.push({
      path: `${rootAlias}:${relativePath}`,
      type,
      mode: stats.mode,
      size: stats.size,
      sha256: null,
      symlink_target: null,
    });
    if (type !== "directory") return true;
    const children = await readdir(path);
    const afterRead = await lstat(path);
    if (!hasSameIdentity(stats, afterRead, "directory")) {
      truncated = true;
      enumerationReasons.add("identity_changed");
      return false;
    }
    let complete = true;
    for (const child of children.sort()) {
      if (!(await visit(root, rootAlias, join(path, child), depth + 1)))
        complete = false;
    }
    return complete;
  };
  for (const [index, root] of scenario.filesystem_observation_paths.entries()) {
    const alias = `root_${String(index)}`;
    if ((await lstatIfPresent(root)) === undefined) {
      completeRoots.push(alias);
      continue;
    }
    if (await visit(root, alias, root, 0)) completeRoots.push(alias);
  }
  return {
    files: entries,
    truncated,
    completeRoots,
    coverage: {
      files_limit: scenario.limits.files,
      depth_limit: scenario.limits.filesystem_depth,
      enumeration_truncated:
        completeRoots.length !== scenario.filesystem_observation_paths.length,
      enumeration_reasons: [...enumerationReasons],
      hash_budget_bytes: scenario.limits.file_bytes,
      hashed_bytes: scenario.limits.file_bytes - remainingBytes,
      hash_omissions: hashOmissions,
    },
  };
};
