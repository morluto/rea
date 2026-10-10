import { constants } from "node:fs";
import type { BigIntStats, Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

/** Identifies a selected path that cannot be read as one regular file. */
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

/** One admitted file descriptor and the metadata that identified its contents. */
export interface StableRegularFileDescriptor {
  readonly handle: FileHandle;
  readonly initial: Stats;
}

/** Open and verify the selected file descriptor without blocking on pipes. */
export const openRegularFile = async (
  path: string,
  options: {
    readonly symlinks: "follow" | "reject";
    readonly signal?: AbortSignal | undefined;
  },
): Promise<FileHandle> => {
  options.signal?.throwIfAborted();
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NONBLOCK ?? 0) |
      (constants.O_NOCTTY ?? 0) |
      (options.symlinks === "reject" ? (constants.O_NOFOLLOW ?? 0) : 0),
  );
  try {
    options.signal?.throwIfAborted();
    const metadata = await handle.stat();
    options.signal?.throwIfAborted();
    if (!metadata.isFile())
      throw new NonRegularFileReadError(path, metadata.isDirectory());
    return handle;
  } catch (cause: unknown) {
    await handle.close().catch(() => undefined);
    throw cause;
  }
};

/** Compare one regular file's identity and mutable metadata across a read. */
export const sameRegularFileState = (
  expected: Stats | BigIntStats,
  observed: Stats | BigIntStats,
): boolean =>
  observed.isFile() &&
  expected.dev === observed.dev &&
  expected.ino === observed.ino &&
  expected.size === observed.size &&
  expected.mode === observed.mode &&
  expected.mtimeMs === observed.mtimeMs &&
  expected.ctimeMs === observed.ctimeMs;
