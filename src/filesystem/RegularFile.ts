import { constants } from "node:fs";
import { constants as osConstants } from "node:os";
import type { BigIntStats, Stats } from "node:fs";
import { lstat, open, stat, type FileHandle } from "node:fs/promises";

import { OwnedFileHandle } from "./OwnedFileHandle.js";

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

/** Admission failed and the opened descriptor could not be confirmed closed. */
export class RegularFileAdmissionFailure extends Error {
  override readonly cause: unknown;

  constructor(
    readonly path: string,
    admissionCause: unknown,
    readonly cleanupCause: unknown,
    readonly owner: OwnedFileHandle,
  ) {
    super(
      `Selected input failed admission and its descriptor close failed: ${path}`,
    );
    this.name = "RegularFileAdmissionFailure";
    this.cause = admissionCause;
  }
}

/** A regular input no longer matches the extent or identity admitted for reading. */
export class RegularFileChangedError extends Error {
  readonly code = "ESTALE";
  constructor(readonly path: string) {
    super(`Selected input changed while being read: ${path}`);
    this.name = "RegularFileChangedError";
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
  ).catch(async (cause: unknown) => {
    const nonRegular = await nonRegularOpenFailure(
      path,
      options.symlinks,
      cause,
    );
    if (nonRegular === undefined) throw cause;
    // Cancellation during the metadata probe outranks the reclassification.
    options.signal?.throwIfAborted();
    throw nonRegular;
  });
  const owner = new OwnedFileHandle(handle);
  try {
    options.signal?.throwIfAborted();
    const metadata = await handle.stat();
    options.signal?.throwIfAborted();
    if (!metadata.isFile())
      throw new NonRegularFileReadError(path, metadata.isDirectory());
    // O_NOFOLLOW is unavailable on Windows. Recheck the name only on hosts
    // where open could have followed a symlink, while the descriptor is owned.
    if (options.symlinks === "reject" && (constants.O_NOFOLLOW ?? 0) === 0) {
      const named = await lstat(path);
      options.signal?.throwIfAborted();
      if (named.isSymbolicLink())
        throw new NonRegularFileReadError(path, false);
      if (!sameRegularFileState(metadata, named))
        throw new RegularFileChangedError(path);
    }
    return handle;
  } catch (cause: unknown) {
    try {
      await owner.close();
    } catch (cleanupCause: unknown) {
      throw new RegularFileAdmissionFailure(path, cause, cleanupCause, owner);
    }
    throw cause;
  }
};

/**
 * Some non-regular files cannot be opened at all: a Unix socket fails with
 * ENXIO on Linux and EOPNOTSUPP on macOS. Confirm such a failure against the
 * path's own metadata before reporting a non-regular selection.
 */
const nonRegularOpenFailure = async (
  path: string,
  symlinks: "follow" | "reject",
  cause: unknown,
): Promise<NonRegularFileReadError | undefined> => {
  // Only errors meaning "this file type cannot be opened" are reclassified;
  // permission, symlink-rejection and resource failures keep their codes.
  if (!isUnopenableFileTypeError(cause)) return undefined;
  const metadata = await (symlinks === "reject" ? lstat : stat)(path).catch(
    () => undefined,
  );
  if (metadata === undefined || metadata.isFile()) return undefined;
  return new NonRegularFileReadError(path, metadata.isDirectory());
};

// Match by errno: libuv has no name for macOS EOPNOTSUPP (102) and reports
// "Unknown system error -102" as its code.
const errnos: Partial<Record<string, number>> = osConstants.errno;
const UNOPENABLE_FILE_TYPE_ERRNOS: ReadonlySet<number> = new Set(
  [errnos.ENXIO, errnos.EOPNOTSUPP, errnos.ENOTSUP].flatMap((errno) =>
    errno === undefined ? [] : [-errno],
  ),
);

const isUnopenableFileTypeError = (cause: unknown): boolean =>
  cause instanceof Error &&
  "errno" in cause &&
  typeof cause.errno === "number" &&
  UNOPENABLE_FILE_TYPE_ERRNOS.has(cause.errno);

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
  ("mtimeNs" in expected && "mtimeNs" in observed
    ? expected.mtimeNs === observed.mtimeNs &&
      expected.ctimeNs === observed.ctimeNs
    : expected.mtimeMs === observed.mtimeMs &&
      expected.ctimeMs === observed.ctimeMs);
