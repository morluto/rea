import { stat } from "node:fs/promises";

import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactFileCleanupFailure } from "../artifacts/ArtifactFileOperation.js";
import {
  RegularFileCleanupFailure,
  withOwnedRegularFile,
} from "../filesystem/OwnedRegularFile.js";
import {
  NonRegularFileReadError,
  RegularFileChangedError,
  isSelectedRegularFileError,
} from "../filesystem/RegularFile.js";
import {
  RegularFileCapacityError,
  readStableFileBytes,
} from "../filesystem/readStableFileBytes.js";

const DENIED_CODES = new Set(["EACCES", "EPERM"]);

/** A read the inventory reports as unreadable rather than failing on. */
export const isRefusedRead = (cause: unknown): boolean =>
  cause instanceof RegularFileCapacityError ||
  cause instanceof RegularFileChangedError ||
  cause instanceof NonRegularFileReadError ||
  isSelectedRegularFileError(cause) ||
  DENIED_CODES.has((cause as NodeJS.ErrnoException).code ?? "");

/**
 * A host read whose close failed, as a cleanup failure with a lease on the
 * exact handle: the capture reports the file and keeps its owner, even when
 * cancelled or beside another failure.
 */
export const hostCloseFailure = (
  cause: RegularFileCleanupFailure,
): ArtifactFileCleanupFailure =>
  new ArtifactFileCleanupFailure(
    cause,
    new AnalysisCleanupLease(() => cause.owner.close(), [cause.path]),
  );

/** A small host file's bytes, following links; `missing` when the path names nothing. */
export const readHostFile = async (
  path: string,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  preserveCapacity = false,
): Promise<Buffer | "missing" | "unreadable"> => {
  const options = {
    symlinks: "follow" as const,
    ...(signal === undefined ? {} : { signal }),
  };
  try {
    return await withOwnedRegularFile(path, options, ({ handle }) =>
      readStableFileBytes(handle, path, maximumBytes, options),
    );
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure)
      throw hostCloseFailure(cause);
    if (preserveCapacity && cause instanceof RegularFileCapacityError)
      throw cause;
    signal?.throwIfAborted();
    if (!isRefusedRead(cause)) throw cause;
    return (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unreadable";
  }
};

/** Whether a host path names a regular file, following links; null when the check could not tell, such as a denied parent folder. */
export const hostFileKind = async (path: string): Promise<boolean | null> => {
  try {
    return (await stat(path)).isFile();
  } catch (cause: unknown) {
    // Only a missing name establishes that no file is there.
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ||
      (cause as NodeJS.ErrnoException).code === "ENOTDIR"
      ? false
      : null;
  }
};

/** Whether a host path names a regular file, following links; false when the check could not tell. */
export const isHostFile = async (path: string): Promise<boolean> =>
  (await hostFileKind(path)) === true;
