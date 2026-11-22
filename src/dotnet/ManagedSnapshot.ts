import { createHash } from "node:crypto";
import { invariantViolation } from "../domain/internalInvariant.js";
import type { BigIntStats, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

import { MANAGED_STATIC_PROVIDER } from "../domain/investigationProviders.js";
import {
  RegularFileCleanupFailure,
  regularFileCancellation,
} from "../filesystem/OwnedRegularFile.js";
import {
  bindRegularFileCleanup,
  withRegularFileCompletion,
  type RegularFileReadOptions,
} from "../process/RegularFileRead.js";
import { ArtifactReaderFailure } from "../resources/index.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisArtifactChangedError,
  AnalysisResourceConstraintError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import { DEFAULT_MANAGED_SNAPSHOT_BYTES } from "../domain/managed/managedInspectionLimits.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  RegularFileChangedError,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import { classifyBinaryTargetFilesystemFailure } from "../domain/binaryTargetFilesystemFailure.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

interface ManagedSourceObservation {
  readonly byteLength: number;
  readonly sha256: string;
  readonly bytes?: Buffer;
  readonly state?: BigIntStats;
}

interface ManagedSnapshot extends ManagedSourceObservation {
  readonly bytes: Buffer;
  readonly state: BigIntStats;
}

interface ManagedSnapshotReadOptions extends RegularFileReadOptions {
  readonly expectedSha256?: string;
  readonly maxBytes?: number;
  /** When present and unchanged on the opened descriptor, reuse the verified digest without re-hashing. */
  readonly cached?: {
    readonly state: BigIntStats;
    readonly sha256: string;
    readonly byteLength: number;
  };
}

/** Admit one observed source digest before any parser or cache consumes its bytes. */
export const verifyManagedSourceIdentity = (
  target: { readonly path: string; readonly sha256: string },
  observed: Pick<ManagedSourceObservation, "sha256" | "byteLength">,
  operation: string,
): Result<null, AnalysisArtifactChangedError> =>
  observed.sha256 === target.sha256
    ? ok(null)
    : err(
        new AnalysisArtifactChangedError(
          operation,
          target.path,
          `Managed artifact digest changed after open: expected ${target.sha256}, observed ${observed.sha256} at ${target.path}`,
          {
            diagnostics: {
              expected_sha256: target.sha256,
              observed_sha256: observed.sha256,
              observed_bytes: observed.byteLength,
            },
          },
        ),
      );

const managedSnapshotCapacityError = (
  operation: string,
  maxBytes: number,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    operation,
    "memory",
    "Managed static inspection requires an eagerly retained PE snapshot within its input byte budget.",
    { max_snapshot_bytes: maxBytes },
    {
      retryable: false,
      remediationAction: `Increase max_snapshot_bytes above ${String(maxBytes)} bytes on the next inspection to admit the complete selected file. No REA restart is required. Metadata representation, transport and host memory limits remain independent; repeating the unchanged request cannot raise this budget.`,
      limit: {
        control_kind: "parameter",
        parameter: "max_snapshot_bytes",
        effective_value: maxBytes,
        unit: "bytes",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        default_value: DEFAULT_MANAGED_SNAPSHOT_BYTES,
        applies_at: "next_call",
      },
    },
  );

export const readManagedSnapshot = async (
  path: string,
  operation: string,
  options: ManagedSnapshotReadOptions = {},
): Promise<ManagedSnapshot> => {
  const maxBytes = snapshotBudget(options);
  return readManagedFile(
    path,
    operation,
    async (handle, metadata) => {
      const signal = options.signal;
      if (metadata.size > maxBytes)
        throw managedSnapshotCapacityError(operation, maxBytes);
      const state = await handle.stat({ bigint: true });
      const bytes = await readBoundedFileBytes(handle, maxBytes, { signal });
      if (bytes === undefined)
        throw managedSnapshotCapacityError(operation, maxBytes);
      signal?.throwIfAborted();
      return {
        byteLength: bytes.length,
        sha256: sha256Hex(bytes),
        bytes,
        state,
      };
    },
    options,
  );
};

export const hashManagedSource = async (
  path: string,
  operation: string,
  options: ManagedSnapshotReadOptions = {},
): Promise<ManagedSourceObservation> => {
  const maxBytes = snapshotBudget(options);
  return readManagedFile(
    path,
    operation,
    async (handle, metadata) => {
      const signal = options.signal;
      if (metadata.size > maxBytes)
        throw managedSnapshotCapacityError(operation, maxBytes);
      if (options.cached !== undefined) {
        const currentState = await handle.stat({ bigint: true });
        signal?.throwIfAborted();
        if (sameRegularFileState(options.cached.state, currentState))
          return {
            byteLength: options.cached.byteLength,
            sha256: options.cached.sha256,
            state: currentState,
          };
      }
      const digest = createHash("sha256");
      let byteLength = 0;
      const chunk = Buffer.allocUnsafe(256 * 1024);
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, maxBytes - byteLength + 1),
          null,
        );
        signal?.throwIfAborted();
        if (bytesRead === 0) break;
        if (bytesRead > maxBytes - byteLength)
          throw managedSnapshotCapacityError(operation, maxBytes);
        byteLength += bytesRead;
        digest.update(chunk.subarray(0, bytesRead));
      }
      return { byteLength, sha256: digest.digest("hex") };
    },
    options,
  );
};

const snapshotBudget = (options: ManagedSnapshotReadOptions): number => {
  const maxBytes = options.maxBytes ?? DEFAULT_MANAGED_SNAPSHOT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw invariantViolation(
      "max_snapshot_bytes must be a positive safe integer",
    );
  return maxBytes;
};

const readManagedFile = <Value extends ManagedSourceObservation>(
  path: string,
  operation: string,
  read: (handle: FileHandle, metadata: Stats) => Promise<Value>,
  options: ManagedSnapshotReadOptions,
): Promise<Value> =>
  withRegularFileCompletion(path, read, options)
    .then(({ value, cancellation }) => {
      if (cancellation !== undefined) {
        const identity =
          options.expectedSha256 === undefined
            ? undefined
            : verifyManagedSourceIdentity(
                { path, sha256: options.expectedSha256 },
                value,
                operation,
              );
        const failure =
          identity !== undefined && !identity.ok
            ? identity.error
            : cancelledBy(operation, carriedReason(cancellation.reason));
        throw failure.retainPartialObservation({
          kind: "file-snapshot-hash",
          path,
          bytes: value.byteLength,
          sha256: value.sha256,
        });
      }
      return value;
    })
    .catch((cause: unknown) => {
      throw normalizeManagedReadFailure(
        cause,
        path,
        operation,
        options.signal,
        options.expectedSha256,
      );
    });

/** Keep cleanup ownership and the original typed read failure at this boundary. */
const normalizeManagedReadFailure = (
  cause: unknown,
  fallbackPath: string,
  operation: string,
  signal?: AbortSignal,
  expectedSha256?: string,
): unknown => {
  // An exact caller reason is opaque, even if it resembles a cleanup record.
  if (signal?.aborted === true && cause === signal.reason)
    return normalizeReadFailure(cause, fallbackPath, operation, signal);
  const cleanupError = managedCleanupError(
    cause,
    fallbackPath,
    operation,
    signal,
    expectedSha256,
  );
  if (cleanupError !== undefined) return cleanupError;
  return normalizeReadFailure(cause, fallbackPath, operation, signal);
};

/** Project cleanup failures owned by managed file reads or their shared scope. */
export const managedCleanupError = (
  cause: unknown,
  fallbackPath: string,
  operation: string,
  signal?: AbortSignal,
  expectedSha256?: string,
): AnalysisError | undefined => {
  if (cause instanceof RegularFileCleanupFailure) {
    const cancellation = regularFileCancellation(cause);
    const cleanup = new ProviderCleanupError(
      MANAGED_STATIC_PROVIDER.id,
      [cause.path],
      { reason: "A managed input file handle could not be closed" },
      { cause, operation },
    );
    bindRegularFileCleanup(cause, cleanup);
    const identity =
      cause.outcome.kind === "completed" && expectedSha256 !== undefined
        ? verifyManagedSourceIdentity(
            { path: cause.path, sha256: expectedSha256 },
            cause.outcome.value as ManagedSourceObservation,
            operation,
          )
        : undefined;
    const failure =
      cause.outcome.kind === "failed"
        ? normalizeReadFailure(
            cause.outcome.cause,
            cause.path,
            operation,
            signal,
          )
        : identity !== undefined && !identity.ok
          ? identity.error
          : cancellation === undefined
            ? undefined
            : cancelledBy(operation, carriedReason(cancellation.reason));
    // This boundary produces only these snapshot facts. The descriptor owner
    // confirms completion independently of a failed final close.
    if (cause.outcome.kind === "completed") {
      const observed = cause.outcome.value as ManagedSourceObservation;
      const observation = {
        kind: "file-snapshot-hash" as const,
        path: cause.path,
        bytes: observed.byteLength,
        sha256: observed.sha256,
      };
      cleanup.retainPartialObservation(observation);
      if (failure instanceof AnalysisError)
        failure.retainPartialObservation(observation);
    }
    return failure instanceof AnalysisError
      ? analysisErrorWithCleanupDependencies(failure, cleanup, operation)
      : cleanup;
  }
  if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined) {
    const error = new ProviderCleanupError(
      MANAGED_STATIC_PROVIDER.id,
      cause.cleanup.resources.length > 0
        ? cause.cleanup.resources
        : [fallbackPath],
      { reason: cause.cleanup.reason },
      { cause, operation, partialObservation: cause.partialObservation },
    );
    bindRegularFileCleanup(cause, error);
    if (cause.reason === "cancelled") {
      const cancelled = cancelledBy(
        operation,
        carriedReason(
          cause.cancellation === undefined
            ? cause.cause
            : cause.cancellation.reason,
        ),
        { partialObservation: cause.partialObservation },
      );
      return analysisErrorWithCleanupDependencies(cancelled, error, operation);
    }
    return error;
  }
  return undefined;
};

const normalizeReadFailure = (
  cause: unknown,
  path: string,
  operation: string,
  signal?: AbortSignal,
): unknown => {
  if (signal?.aborted === true && cause === signal.reason)
    return cancelledBy(operation, carriedReason(cause));
  if (cause instanceof RegularFileChangedError)
    return new AnalysisArtifactChangedError(operation, path, cause.message, {
      cause,
    });
  if (cause instanceof AnalysisError) return cause;
  return (
    classifyBinaryTargetFilesystemFailure(path, cause) ??
    (signal?.aborted === true
      ? cancelledBy(operation, carriedReason(cause))
      : cause)
  );
};
