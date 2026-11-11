import { stat } from "node:fs/promises";

import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactFileCleanupFailure } from "../artifacts/ArtifactFileOperation.js";
import {
  RegularFileCleanupFailure,
  regularFileCancellation,
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
  cancellationFailure?: (reason: unknown) => Error,
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
    if (cancellationFailure !== undefined) {
      const cancellation = regularFileCancellation(cause);
      if (cancellation !== undefined)
        throw cancellationFailure(cancellation.reason);
      if (signal?.aborted === true) throw cause;
    }
    signal?.throwIfAborted();
    if (!isRefusedRead(cause)) throw cause;
    return (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unreadable";
  }
};

/** Whether a host path names a regular file, following links. */
export const isHostFile = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => undefined))?.isFile() === true;
