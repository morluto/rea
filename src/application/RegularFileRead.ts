import type { Stats } from "node:fs";
import { lstat, stat, type FileHandle } from "node:fs/promises";

import {
  openRegularFile,
  sameRegularFileState,
  RegularFileChangedError,
} from "../filesystem/RegularFile.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";

/** Filesystem admission policy for one selected regular input. */
export interface RegularFileReadOptions {
  readonly signal?: AbortSignal | undefined;
  readonly symlinks?: "follow" | "reject";
}

/** Admit one regular-file handle, retain it through the consumer, and always close it. */
export const withRegularFile = async <Value>(
  path: string,
  read: (handle: FileHandle, stats: Stats) => Promise<Value>,
  options: RegularFileReadOptions = {},
): Promise<Value> => {
  const { signal } = options;
  const handle = await openRegularFile(path, {
    symlinks: options.symlinks ?? "follow",
    signal,
  });
  try {
    const stats = await handle.stat();
    signal?.throwIfAborted();
    const value = await read(handle, stats);
    signal?.throwIfAborted();
    const [opened, currentPath] = await Promise.all([
      handle.stat(),
      options.symlinks === "reject" ? lstat(path) : stat(path),
    ]);
    if (
      !sameRegularFileState(stats, opened) ||
      !sameRegularFileState(stats, currentPath)
    )
      throw new RegularFileChangedError(path);
    return value;
  } finally {
    await handle.close();
  }
};

/** Admit a regular file without waiting for a pipe, then read its verified handle. */
export const readRegularFile = (
  path: string,
  options: RegularFileReadOptions = {},
): Promise<Buffer> =>
  withRegularFile(
    path,
    async (handle, stats) => {
      const bytes = await readBoundedFileBytes(
        handle,
        stats.size,
        options.signal,
      );
      if (bytes === undefined || bytes.length !== stats.size)
        throw new RegularFileChangedError(path);
      return bytes;
    },
    options,
  );

/** Read one admitted regular file as UTF-8 without waiting on a pipe. */
export const readRegularFileText = async (
  path: string,
  options: RegularFileReadOptions = {},
): Promise<string> => (await readRegularFile(path, options)).toString("utf8");
