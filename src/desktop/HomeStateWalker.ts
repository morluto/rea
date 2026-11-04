import type { BigIntStats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  DesktopPathState,
  DesktopWalk,
} from "../domain/desktop/desktopStateDiff.js";
import { isWithinAny } from "../domain/desktop/desktopStateDiff.js";

const LSTAT_CONCURRENCY = 64;

/** One stat walk of the observed roots. */
export interface HomeStateWalk extends DesktopWalk {
  readonly truncated: boolean;
  readonly unreadableDirectories: number;
}

const pathState = (stats: BigIntStats): DesktopPathState => ({
  type: stats.isFile()
    ? "file"
    : stats.isDirectory()
      ? "directory"
      : stats.isSymbolicLink()
        ? "symlink"
        : "other",
  size: Number(stats.size),
  mode: Number(stats.mode & 0o7777n),
  mtime_ns: stats.mtimeNs.toString(),
  inode: `${stats.dev.toString()}:${stats.ino.toString()}`,
});

/** A path's metadata, null when it is absent, undefined when that is unknown. */
const statPath = async (
  path: string,
): Promise<BigIntStats | null | undefined> => {
  try {
    return await lstat(path, { bigint: true });
  } catch (cause: unknown) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? null
      : undefined;
  }
};

interface WalkProgress {
  readonly entries: Map<string, DesktopPathState>;
  readonly pending: string[];
  readonly maxEntries: number;
  truncated: boolean;
}

/** Record one directory's entries; true when every one of them was recorded. */
const listDirectory = async (
  directory: string,
  names: readonly string[],
  excluded: readonly string[],
  progress: WalkProgress,
): Promise<boolean> => {
  const paths = names
    .map((name) => join(directory, name))
    .filter((path) => !isWithinAny(path, excluded));
  let complete = true;
  for (let offset = 0; offset < paths.length; offset += LSTAT_CONCURRENCY) {
    const batch = paths.slice(offset, offset + LSTAT_CONCURRENCY);
    const stats = await Promise.all(batch.map(statPath));
    for (const [index, stat] of stats.entries()) {
      const path = batch[index];
      if (path === undefined || stat === null) continue;
      if (stat === undefined) {
        complete = false;
        continue;
      }
      if (progress.entries.size >= progress.maxEntries) {
        progress.truncated = true;
        return false;
      }
      progress.entries.set(path, pathState(stat));
      if (stat.isDirectory()) progress.pending.push(path);
    }
  }
  return complete;
};

/**
 * Record every path under the roots without following symbolic links. The walk
 * stops adding entries at `maxEntries` and reports itself truncated. A
 * directory counts as listed only when every one of its entries was recorded.
 */
export const walkHomeState = async (
  roots: readonly string[],
  excluded: readonly string[],
  maxEntries: number,
  signal?: AbortSignal,
): Promise<HomeStateWalk> => {
  const progress: WalkProgress = {
    entries: new Map(),
    pending: [],
    maxEntries,
    truncated: false,
  };
  const listed = new Set<string>();
  const checkedRoots = new Set<string>();
  let unreadableDirectories = 0;
  for (const root of roots) {
    if (isWithinAny(root, excluded)) continue;
    const stats = await statPath(root);
    if (stats === undefined) continue;
    checkedRoots.add(root);
    if (stats === null) continue;
    progress.entries.set(root, pathState(stats));
    if (stats.isDirectory()) progress.pending.push(root);
  }
  while (progress.pending.length > 0 && !progress.truncated) {
    signal?.throwIfAborted();
    const directory = progress.pending.pop() ?? "";
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      unreadableDirectories += 1;
      continue;
    }
    if (await listDirectory(directory, names, excluded, progress))
      listed.add(directory);
  }
  return {
    entries: progress.entries,
    listed,
    roots: checkedRoots,
    truncated: progress.truncated,
    unreadableDirectories,
  };
};
