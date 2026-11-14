import { stat } from "node:fs/promises";

import type { LibraryFileProbe } from "../domain/desktop/libraryPackages.js";

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

/**
 * The stat failure that ld.so searches past: a candidate under a directory it
 * cannot search. glibc's open_path continues only after ENOENT and EACCES, and
 * fails the load on any other error (observed with glibc 2.36: a looping
 * symlink candidate ends the search). An EACCES candidate is therefore not the
 * object the linker loads with the same credentials, but REA's credentials may
 * differ, so it stays unknown rather than absent.
 */
const UNREACHABLE_CODES = new Set(["EACCES"]);

/** The host file at `path`, with why a check could not tell it. */
export const probeHostFile = async (
  path: string,
): Promise<LibraryFileProbe> => {
  try {
    return { kind: "file", isFile: (await stat(path)).isFile() };
  } catch (cause: unknown) {
    const code = (cause as NodeJS.ErrnoException).code ?? "";
    // Only a missing name establishes that no file is there.
    return code === "ENOENT" || code === "ENOTDIR"
      ? { kind: "file", isFile: false }
      : { kind: "unknown", unreachable: UNREACHABLE_CODES.has(code) };
  }
};

/** Whether a host path names a regular file, following links; null when the check could not tell, such as a denied parent folder. */
export const hostFileKind = async (path: string): Promise<boolean | null> => {
  const probe = await probeHostFile(path);
  return probe.kind === "file" ? probe.isFile : null;
};
