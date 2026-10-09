import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

/** The opened input cannot supply regular-file bytes. */
export class NonRegularFileReadError extends Error {
  readonly code: "EISDIR" | "ENOTFILE";

  constructor(
    readonly path: string,
    directory: boolean,
  ) {
    super(`Selected input must be a regular file: ${path}`);
    this.name = "NonRegularFileReadError";
    this.code = directory ? "EISDIR" : "ENOTFILE";
  }
}

/** Admit one regular-file handle, retain it through the consumer, and always close it. */
export const withRegularFile = async <Value>(
  path: string,
  read: (handle: FileHandle, stats: Stats) => Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> => {
  signal?.throwIfAborted();
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NONBLOCK ?? 0) |
      (constants.O_NOCTTY ?? 0),
  );
  try {
    signal?.throwIfAborted();
    const stats = await handle.stat();
    signal?.throwIfAborted();
    if (!stats.isFile())
      throw new NonRegularFileReadError(path, stats.isDirectory());
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
