import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

import { openRegularFile } from "../filesystem/RegularFile.js";

/** Admit one regular-file handle, retain it through the consumer, and always close it. */
export const withRegularFile = async <Value>(
  path: string,
  read: (handle: FileHandle, stats: Stats) => Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> => {
  const handle = await openRegularFile(path, { symlinks: "follow", signal });
  try {
    const stats = await handle.stat();
    signal?.throwIfAborted();
    const value = await read(handle, stats);
    signal?.throwIfAborted();
    return value;
  } finally {
    await handle.close();
  }
};

/** Admit a regular file without waiting for a pipe, then read its verified handle. */
export const readRegularFile = (
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> =>
  withRegularFile(path, (handle) => handle.readFile({ signal }), signal);
