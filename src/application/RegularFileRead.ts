import type { Stats } from "node:fs";
import { lstat, stat, type FileHandle } from "node:fs/promises";

import {
  sameRegularFileState,
  RegularFileChangedError,
  RegularFileOperationCancelled,
  assertRegularFileActive,
} from "../filesystem/RegularFile.js";
import {
  RegularFileCleanupFailure,
  RegularFileCancelled,
  regularFileCancellation,
  withOwnedRegularFile,
  OwnedRegularFileOperationFailure,
  type RegularFileOperationOutcome,
} from "../filesystem/OwnedRegularFile.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import type { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { AnalysisCleanupObservation } from "../domain/analysisErrorBase.js";

/** Filesystem admission policy for one selected regular input. */
export interface RegularFileReadOptions {
  readonly signal?: AbortSignal | undefined;
  readonly symlinks?: "follow" | "reject";
  readonly resources?: ArtifactResourceScope;
  /** Runs on the opened file's own state before any byte is read; throw to refuse the read. */
  readonly admit?: (state: Stats) => void;
  /** Tags cancellation at the bounded reader's cooperative checkpoints. */
  readonly cancellationFailure?: (reason: unknown) => Error;
}

/** Preserves a physical descriptor-read cause until its owner has finalized. */
export class RegularFileReadFailure extends OwnedRegularFileOperationFailure {
  override readonly _tag = "RegularFileReadFailure";

  constructor(operationCause: unknown) {
    super(operationCause);
    this.name = this._tag;
  }
}

export class InvalidUtf8FileError extends TypeError {
  readonly _tag = "InvalidUtf8FileError";
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`File is not valid UTF-8: ${path}`, { cause });
    this.name = this._tag;
  }
}

/**
 * A close that still failed after its retained-owner retry. The scope keeps the
 * descriptor; `cleanupLease` lets the consumer bind its typed error to that
 * exact owner without another close attempt.
 */
export class RegularFileRetainedCleanupFailure<
  Value = unknown,
> extends RegularFileCleanupFailure<Value> {
  constructor(
    failure: RegularFileCleanupFailure<Value>,
    readonly cleanupLease: AnalysisCleanupLease,
    readonly cleanup: AnalysisCleanupObservation,
  ) {
    super(
      failure.path,
      failure.owner,
      failure.outcome,
      failure.cleanupCause,
      failure.retention,
      failure.completionCancellation,
      failure.operationFailure,
    );
  }
}

/** Retry a failed close through its retained owner and report any remaining cleanup. */
export const retryRegularFileCleanup = async <Value>(
  failure: RegularFileCleanupFailure<Value>,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<{
  readonly outcome: RegularFileOperationOutcome<Value>;
  readonly cleanupLease?: AnalysisCleanupLease;
  readonly cleanup?: AnalysisCleanupObservation;
}> => {
  const outcome: RegularFileOperationOutcome<Value> =
    failure.outcome.kind === "failed" &&
    failure.operationFailure === undefined &&
    failure.outcome.cause instanceof RegularFileOperationCancelled &&
    !(signal?.aborted === true && failure.outcome.cause === signal.reason)
      ? { kind: "failed", cause: failure.outcome.cause.reason }
      : failure.outcome;
  const released = await resources.release({
    kind: "file-handle",
    handle: failure.owner,
    resource: failure.path,
  });
  if (released.kind === "released") return { outcome };
  return {
    outcome,
    cleanupLease: released.lease,
    cleanup: {
      reason: `${failureMessage(failure.cleanupCause)}; retry: ${failureMessage(released.cause)}`,
      resources: [failure.path],
    },
  };
};

/** Retry every explicit nested operation owner; close rejection values grant no authority. */
export const retryRegularFileCleanupFailures = async (
  failure: RegularFileCleanupFailure,
  resources: ArtifactResourceScope,
): Promise<{
  readonly primary: unknown;
  readonly failures: readonly RegularFileCleanupFailure[];
  readonly cleanup?: AnalysisCleanupObservation;
}> => {
  const failures: RegularFileCleanupFailure[] = [];
  const observations: AnalysisCleanupObservation[] = [];
  let current = failure;
  let primary: unknown;
  for (;;) {
    failures.push(current);
    const retried = await retryRegularFileCleanup(current, resources);
    if (retried.cleanup !== undefined) observations.push(retried.cleanup);
    primary =
      retried.outcome.kind === "failed"
        ? retried.outcome.cause
        : current.cleanupCause;
    const nested =
      current.operationFailure === undefined &&
      current.outcome.kind === "failed"
        ? current.outcome.cause
        : undefined;
    if (!(nested instanceof RegularFileCleanupFailure)) break;
    current = nested;
  }
  return {
    primary,
    failures,
    ...(observations.length === 0
      ? {}
      : {
          cleanup: {
            reason: observations.map(({ reason }) => reason).join("; "),
            resources: observations.flatMap(({ resources }) => resources),
          },
        }),
  };
};

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Admit one regular-file handle, retain it through the consumer, and always close it. */
export const withRegularFile = async <Value>(
  path: string,
  read: (handle: FileHandle, stats: Stats) => Promise<Value>,
  options: RegularFileReadOptions & {
    /**
     * Identifies a completed value that is itself the consumer's failure. It
     * was settled before the final close, so later cancellation cannot replace it.
     */
    readonly completedFailure?: (value: Value) => boolean;
  } = {},
): Promise<Value> => {
  const { signal, resources } = options;
  let admitted: FileHandle | undefined;
  const operation = async () => {
    try {
      return await withOwnedRegularFile(
        path,
        {
          ...(signal === undefined ? {} : { signal }),
          symlinks: options.symlinks ?? "follow",
        },
        async (handle) => {
          admitted = handle;
          const stats = await handle.stat();
          assertRegularFileActive(signal);
          const value = await read(handle, stats);
          assertRegularFileActive(signal);
          const [opened, currentPath] = await Promise.all([
            handle.stat(),
            options.symlinks === "reject" ? lstat(path) : stat(path),
          ]);
          if (
            !sameRegularFileState(stats, opened) ||
            !sameRegularFileState(stats, currentPath)
          )
            throw new RegularFileChangedError(path);
          assertRegularFileActive(signal);
          return value;
        },
      );
    } catch (cause: unknown) {
      // Caller reasons are opaque, including objects shaped like file failures.
      // They do not transfer ownership of any descriptor to this operation.
      if (signal?.aborted === true && cause === signal.reason) throw cause;
      if (cause instanceof RegularFileReadFailure) throw cause;
      if (
        cause instanceof RegularFileCancelled &&
        cause.owner.handle !== admitted
      )
        throw cause;
      if (
        cause instanceof RegularFileCancelled &&
        options.completedFailure?.(cause.outcome.value as Value) === true
      )
        return cause.outcome.value as Value;
      if (cause instanceof RegularFileCleanupFailure) {
        if (resources === undefined) throw cause;
        const retry = await retryRegularFileCleanup(cause, resources, signal);
        if (retry.cleanup !== undefined)
          throw retry.cleanupLease === undefined
            ? cause
            : new RegularFileRetainedCleanupFailure(
                cause,
                retry.cleanupLease,
                retry.cleanup,
              );
        if (retry.outcome.kind === "failed") {
          if (
            cause.operationFailure === undefined &&
            signal?.aborted === true &&
            retry.outcome.cause === signal.reason
          )
            throw signal.reason;
          const cancellation =
            cause.operationFailure === undefined
              ? (regularFileCancellation(retry.outcome.cause) ??
                regularFileCancellation(cause))
              : undefined;
          if (cancellation !== undefined) {
            if (options.cancellationFailure !== undefined)
              throw options.cancellationFailure(cancellation.reason);
            throw cancellation.reason;
          }
          if (
            cause.operationFailure !== undefined &&
            options.cancellationFailure !== undefined
          )
            throw cause.operationFailure;
          throw retry.outcome.cause;
        }
        return retry.outcome.value;
      }
      const cancellation = regularFileCancellation(cause);
      if (cancellation !== undefined) {
        if (options.cancellationFailure !== undefined)
          throw options.cancellationFailure(cancellation.reason);
        throw cancellation.reason;
      }
      if (options.cancellationFailure !== undefined)
        throw new RegularFileReadFailure(cause);
      throw cause;
    }
  };
  const value = await (resources === undefined
    ? operation()
    : resources.run(operation));
  // A retained close may have recovered after the descriptor owner's outcome
  // was captured. Include that retry and the scope's finalization in cancellation.
  if (signal?.aborted === true && options.completedFailure?.(value) === true)
    return value;
  if (signal?.aborted === true && options.cancellationFailure !== undefined)
    throw options.cancellationFailure(signal.reason);
  signal?.throwIfAborted();
  return value;
};

/** Admit a regular file without waiting for a pipe, then read its verified handle. */
export const readRegularFile = (
  path: string,
  options: RegularFileReadOptions = {},
): Promise<Buffer> => readRegularFileContent(path, (bytes) => bytes, options);

/** Read valid UTF-8 without replacing source bytes or stripping an initial BOM. */
export const readRegularFileText = (
  path: string,
  options: RegularFileReadOptions = {},
): Promise<string> =>
  readRegularFileContent(path, (bytes) => decodeFileText(path, bytes), options);

/** Retain the read owner's verified file state together with its decoded text. */
export const readRegularFileTextSnapshot = (
  path: string,
  options: RegularFileReadOptions = {},
): Promise<{ readonly text: string; readonly state: Stats }> =>
  readRegularFileContent(
    path,
    (bytes, state) => ({
      text: decodeFileText(path, bytes),
      state,
    }),
    options,
  );

const decodeFileText = (path: string, bytes: Buffer): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (cause: unknown) {
    if (!(cause instanceof TypeError)) throw cause;
    throw new InvalidUtf8FileError(path, cause);
  }
};

const readRegularFileContent = <Value>(
  path: string,
  decode: (bytes: Buffer, state: Stats) => Value,
  options: RegularFileReadOptions,
): Promise<Value> => {
  const operation = withRegularFile(
    path,
    async (handle, stats) => {
      try {
        options.admit?.(stats);
        const bytes = await readBoundedFileBytes(handle, stats.size, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          cancellationFailure: (reason) =>
            new RegularFileOperationCancelled(reason),
          operationFailure: (cause) => new RegularFileReadFailure(cause),
        });
        if (bytes === undefined || bytes.length !== stats.size)
          throw new RegularFileChangedError(path);
        return decode(bytes, stats);
      } catch (cause: unknown) {
        if (
          options.cancellationFailure !== undefined &&
          !(cause instanceof RegularFileOperationCancelled) &&
          !(cause instanceof RegularFileReadFailure)
        )
          throw new RegularFileReadFailure(cause);
        throw cause;
      }
    },
    options,
  );
  if (options.cancellationFailure !== undefined) return operation;
  return operation.catch((cause: unknown) => {
    if (cause instanceof RegularFileReadFailure) throw cause.operationCause;
    throw cause;
  });
};
