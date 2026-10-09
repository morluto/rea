import { constants } from "node:fs";
import { open } from "node:fs/promises";

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

/** Admit a regular file without waiting for a pipe, then read its verified handle. */
export const readRegularFile = async (
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> => {
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
    const bytes = await handle.readFile({ signal });
    signal?.throwIfAborted();
    return bytes;
  } finally {
    await handle.close();
  }
};
