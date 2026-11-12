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

/**
 * Whether a host path names a regular file, following links. A failed check is
 * either one no retry can change, which settles the candidate the same way for
 * the linker, or a transient failure, which leaves it unresolved.
 */
export type HostFileProbe =
  | { readonly kind: "file"; readonly isFile: boolean }
  | {
      readonly kind: "unknown";
      /** The check settled the candidate; the linker cannot use this path either. */
      readonly unreachable: boolean;
    };

/**
 * Codes whose failure means the candidate cannot be reached at all.
 *
 * A denied folder is one; so are a name the filesystem refuses to look up and a
 * link chain that loops. The loader treats a RUNPATH/RPATH entry that makes
 * `stat` fail this way as unusable and goes on to the next entry, so retrying
 * it in place would stop the walk before the candidate that was actually
 * loaded. It still continues to the linker cache, so this stays `unreachable`
 * rather than a settled absence.
 */
const UNREACHABLE_CODES = new Set(["EACCES", "EPERM", "ENAMETOOLONG", "ELOOP"]);

/** The host file at `path`, with why a check could not tell it. */
export const probeHostFile = async (path: string): Promise<HostFileProbe> => {
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
