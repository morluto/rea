import { stat } from "node:fs/promises";

import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import {
  ArtifactFileCancelled,
  ArtifactFileCleanupFailure,
  artifactOperationCause,
} from "../artifacts/ArtifactFileOperation.js";
import {
  RegularFileCleanupFailure,
  RegularFileCancelled,
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

/** Preserve physical failures and normalize only cancellation recorded by the file owner. */
export const hostReadFailure = (
  cause: unknown,
  cancellationFailure?: (reason: unknown) => Error,
): unknown => {
  if (cause instanceof RegularFileCleanupFailure)
    return new ArtifactFileCleanupFailure(
      cause,
      new AnalysisCleanupLease(() => cause.owner.close(), [cause.path]),
    );
  const cancellation = regularFileCancellation(cause);
  if (cancellation !== undefined && cancellationFailure !== undefined)
    return cancellationFailure(cancellation.reason);
  if (cause instanceof RegularFileCancelled)
    return new ArtifactFileCancelled(cause);
  return artifactOperationCause(cause);
};

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
    const failure = hostReadFailure(cause, cancellationFailure);
    if (failure !== cause) throw failure;
    if (preserveCapacity && cause instanceof RegularFileCapacityError)
      throw cause;
    // This caller requires the physical failure rather than an optional omission after abort.
    if (cancellationFailure !== undefined && signal?.aborted === true)
      throw cause;
    if (!isRefusedRead(cause)) throw cause;
    return (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unreadable";
  }
};

/** Whether a host path names a regular file, following links. */
export const isHostFile = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => undefined))?.isFile() === true;
