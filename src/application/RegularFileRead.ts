import type { Stats } from "node:fs";
import { lstat, stat, type FileHandle } from "node:fs/promises";

import {
  RegularFileAdmissionFailure,
  openRegularFile,
  sameRegularFileState,
  RegularFileChangedError,
} from "../filesystem/RegularFile.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { AnalysisCleanupObservation } from "../domain/analysisErrorBase.js";

/** Filesystem admission policy for one selected regular input. */
export interface RegularFileReadOptions {
  readonly signal?: AbortSignal | undefined;
  readonly symlinks?: "follow" | "reject";
  readonly resources?: ArtifactResourceScope;
}

export type RegularFileReadOutcome<Value> =
  | { readonly kind: "completed"; readonly value: Value }
  | { readonly kind: "failed"; readonly cause: unknown };

/** A close failed after reading; this error transfers the exact handle owner. */
export class RegularFileCleanupFailure<Value = unknown> extends Error {
  constructor(
    readonly path: string,
    readonly owner: OwnedFileHandle,
    readonly outcome: RegularFileReadOutcome<Value>,
    readonly cleanupCause: unknown,
  ) {
    super(`Regular file cleanup failed: ${path}`, {
      cause: outcome.kind === "failed" ? outcome.cause : cleanupCause,
    });
    this.name = "RegularFileCleanupFailure";
  }
}

/** Retry a failed close through its retained owner and report any remaining cleanup. */
export const retryRegularFileCleanup = async <Value>(
  failure: RegularFileCleanupFailure<Value>,
  resources: ArtifactResourceScope,
): Promise<{
  readonly outcome: RegularFileReadOutcome<Value>;
  readonly cleanup?: AnalysisCleanupObservation;
}> => {
  const released = await resources.release({
    kind: "file-handle",
    handle: failure.owner,
    resource: failure.path,
  });
  if (released.kind === "released") return { outcome: failure.outcome };
  return {
    outcome: failure.outcome,
    cleanup: {
      reason: `${failureMessage(failure.cleanupCause)}; retry: ${failureMessage(released.cause)}`,
      resources: [failure.path],
    },
  };
};

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Admit one regular-file handle, retain it through the consumer, and always close it. */
export const withRegularFile = async <Value>(
  path: string,
  read: (handle: FileHandle, stats: Stats) => Promise<Value>,
  options: RegularFileReadOptions = {},
): Promise<Value> =>
  options.resources === undefined
    ? withRegularFileOwned(path, read, options)
    : options.resources.run(() => withRegularFileOwned(path, read, options));

const withRegularFileOwned = async <Value>(
  path: string,
  read: (handle: FileHandle, stats: Stats) => Promise<Value>,
  options: RegularFileReadOptions,
): Promise<Value> => {
  const { signal } = options;
  let handle: FileHandle;
  try {
    handle = await openRegularFile(path, {
      symlinks: options.symlinks ?? "follow",
      signal,
    });
  } catch (cause: unknown) {
    if (!(cause instanceof RegularFileAdmissionFailure)) throw cause;
    const failure = new RegularFileCleanupFailure(
      path,
      cause.owner,
      { kind: "failed", cause: cause.cause },
      cause.cleanupCause,
    );
    if (options.resources === undefined) throw failure;
    const retry = await retryRegularFileCleanup(failure, options.resources);
    if (retry.cleanup !== undefined) throw failure;
    throw cause.cause;
  }
  const owner = new OwnedFileHandle(handle);
  let outcome: RegularFileReadOutcome<Value>;
  try {
    const stats = await handle.stat();
    signal?.throwIfAborted();
    const value = await read(handle, stats);
    signal?.throwIfAborted();
    const [opened, currentPath] = await Promise.all([
      handle.stat(),
      options.symlinks === "reject" ? lstat(path) : stat(path),
    ]);
    if (
      !sameRegularFileState(stats, opened) ||
      !sameRegularFileState(stats, currentPath)
    )
      throw new RegularFileChangedError(path);
    outcome = { kind: "completed", value };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  try {
    await owner.close();
  } catch (cleanupCause: unknown) {
    const failure = new RegularFileCleanupFailure(
      path,
      owner,
      outcome,
      cleanupCause,
    );
    if (options.resources === undefined) throw failure;
    const retry = await retryRegularFileCleanup(failure, options.resources);
    if (retry.cleanup !== undefined) throw failure;
    if (retry.outcome.kind === "failed") throw retry.outcome.cause;
    return retry.outcome.value;
  }
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.value;
};

/** Admit a regular file without waiting for a pipe, then read its verified handle. */
export const readRegularFile = (
  path: string,
  options: RegularFileReadOptions = {},
): Promise<Buffer> =>
  withRegularFile(
    path,
    async (handle, stats) => {
      const bytes = await readBoundedFileBytes(
        handle,
        stats.size,
        options.signal,
      );
      if (bytes === undefined || bytes.length !== stats.size)
        throw new RegularFileChangedError(path);
      return bytes;
    },
    options,
  );

/** Read one admitted regular file as UTF-8 without waiting on a pipe. */
export const readRegularFileText = async (
  path: string,
  options: RegularFileReadOptions = {},
): Promise<string> => {
  try {
    return (await readRegularFile(path, options)).toString("utf8");
  } catch (cause: unknown) {
    if (
      cause instanceof RegularFileCleanupFailure &&
      cause.outcome.kind === "completed" &&
      Buffer.isBuffer(cause.outcome.value)
    )
      throw new RegularFileCleanupFailure(
        cause.path,
        cause.owner,
        { kind: "completed", value: cause.outcome.value.toString("utf8") },
        cause.cleanupCause,
      );
    throw cause;
  }
};
