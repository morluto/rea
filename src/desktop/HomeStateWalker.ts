import type { BigIntStats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { DesktopPathState } from "../domain/desktop/desktopStateDiff.js";
import { isWithinAny } from "../domain/desktop/desktopStateDiff.js";

const LSTAT_CONCURRENCY = 64;

/** One stat walk of the observed roots. */
export interface HomeStateWalk {
  readonly entries: ReadonlyMap<string, DesktopPathState>;
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

const statOrUndefined = async (
  path: string,
): Promise<BigIntStats | undefined> => {
  try {
    return await lstat(path, { bigint: true });
  } catch {
    // A path removed or denied between listing and stat is absent from this walk.
    return undefined;
  }
};

/**
 * Record every path under the roots without following symbolic links. The walk
 * stops adding entries at `maxEntries` and reports itself truncated.
 */
export const walkHomeState = async (
  roots: readonly string[],
  excluded: readonly string[],
  maxEntries: number,
  signal?: AbortSignal,
): Promise<HomeStateWalk> => {
  const entries = new Map<string, DesktopPathState>();
  let truncated = false;
  let unreadableDirectories = 0;
  const pending: string[] = [];
  for (const root of roots) {
    const stats = await statOrUndefined(root);
    if (stats === undefined || isWithinAny(root, excluded)) continue;
    entries.set(root, pathState(stats));
    if (stats.isDirectory()) pending.push(root);
  }
  while (pending.length > 0 && !truncated) {
    signal?.throwIfAborted();
    const directory = pending.pop() ?? "";
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      unreadableDirectories += 1;
      continue;
    }
    const paths = names
      .map((name) => join(directory, name))
      .filter((path) => !isWithinAny(path, excluded));
    for (let offset = 0; offset < paths.length; offset += LSTAT_CONCURRENCY) {
      const batch = paths.slice(offset, offset + LSTAT_CONCURRENCY);
      const stats = await Promise.all(batch.map(statOrUndefined));
      for (const [index, stat] of stats.entries()) {
        const path = batch[index];
        if (stat === undefined || path === undefined) continue;
        if (entries.size >= maxEntries) {
          truncated = true;
          break;
        }
        entries.set(path, pathState(stat));
        if (stat.isDirectory()) pending.push(path);
      }
      if (truncated) break;
    }
  }
  return { entries, truncated, unreadableDirectories };
};
