import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { FileState, ProcessScenario } from "../domain/processCapture.js";
import type { Stats } from "node:fs";

export interface SnapshotResult {
  readonly files: readonly FileState[];
  readonly truncated: boolean;
}

const isWithin = (candidate: string, root: string): boolean =>
  candidate === root ||
  candidate.startsWith(`${root.endsWith("/") ? root.slice(0, -1) : root}/`);

const hasSameIdentity = (
  before: Stats,
  after: Stats,
  expected: "directory" | "symlink",
): boolean =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  (expected === "directory" ? after.isDirectory() : after.isSymbolicLink());

const lstatIfPresent = async (path: string): Promise<Stats | undefined> => {
  try {
    return await lstat(path);
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
};

const hashFile = async (
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | null> => {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) return null;
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
    if (after.size !== stats.size || after.mtimeMs !== stats.mtimeMs)
      return null;
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
  let remainingBytes = scenario.limits.file_bytes;
  let truncated = false;
  const visit = async (
    root: string,
    rootAlias: string,
    path: string,
    depth: number,
  ): Promise<void> => {
    signal?.throwIfAborted();
    if (
      entries.length >= scenario.limits.files ||
      depth > scenario.limits.filesystem_depth
    ) {
      truncated = true;
      return;
    }
    const stats = await lstatIfPresent(path);
    if (stats === undefined) return;
    const relativePath = relative(root, path) || ".";
    if (stats.isSymbolicLink()) {
      const target = resolve(dirname(path), await readlink(path));
      const afterRead = await lstat(path);
      if (!hasSameIdentity(stats, afterRead, "symlink")) {
        truncated = true;
        return;
      }
      const safeTarget = isWithin(target, root)
        ? relative(root, target) || "."
        : "<outside-declared-root>";
      if (safeTarget === "<outside-declared-root>") truncated = true;
      entries.push({
        path: `${rootAlias}:${relativePath}`,
        type: "symlink",
        mode: stats.mode,
        size: stats.size,
        sha256: null,
        symlink_target: safeTarget,
      });
      return;
    }
    if (stats.isFile()) {
      const sha256 =
        remainingBytes >= stats.size
          ? await hashFile(path, remainingBytes, signal)
          : null;
      remainingBytes -= sha256 === null ? 0 : stats.size;
      if (sha256 === null) truncated = true;
      entries.push({
        path: `${rootAlias}:${relativePath}`,
        type: "file",
        mode: stats.mode,
        size: stats.size,
        sha256,
        symlink_target: null,
      });
      return;
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
    if (type !== "directory") return;
    const children = await readdir(path);
    const afterRead = await lstat(path);
    if (!hasSameIdentity(stats, afterRead, "directory")) {
      truncated = true;
      return;
    }
    for (const child of children.sort())
      await visit(root, rootAlias, join(path, child), depth + 1);
  };
  for (const [index, root] of scenario.filesystem_roots.entries())
    await visit(root, `root_${String(index)}`, root, 0);
  return { files: entries, truncated };
};
