import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { FileState, ProcessScenario } from "../domain/processCapture.js";

export interface SnapshotResult {
  readonly files: readonly FileState[];
  readonly truncated: boolean;
}

const isWithin = (candidate: string, root: string): boolean =>
  candidate === root ||
  candidate.startsWith(`${root.endsWith("/") ? root.slice(0, -1) : root}/`);

const hashFile = async (
  path: string,
  maxBytes: number,
): Promise<string | null> => {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) return null;
    return createHash("sha256")
      .update(await handle.readFile())
      .digest("hex");
  } finally {
    await handle.close();
  }
};

/** Capture bounded, root-aliased filesystem state without following symlinks. */
export const snapshotRoots = async (
  scenario: ProcessScenario,
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
    if (
      entries.length >= scenario.limits.files ||
      depth > scenario.limits.filesystem_depth
    ) {
      truncated = true;
      return;
    }
    let stats;
    try {
      stats = await lstat(path);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    const relativePath = relative(root, path) || ".";
    if (stats.isSymbolicLink()) {
      const target = resolve(dirname(path), await readlink(path));
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
          ? await hashFile(path, remainingBytes)
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
    for (const child of (await readdir(path)).sort())
      await visit(root, rootAlias, join(path, child), depth + 1);
  };
  for (const [index, root] of scenario.filesystem_roots.entries())
    await visit(root, `root_${String(index)}`, root, 0);
  return { files: entries, truncated };
};
