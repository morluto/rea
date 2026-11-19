import type { FileHandle } from "node:fs/promises";
import {
  RegularFileOperationCancelled,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  withOwnedFileHandle,
  withOwnedRegularFile,
  RegularFileCancelled,
  RegularFileCleanupFailure,
} from "../filesystem/OwnedRegularFile.js";
import {
  ArtifactReaderFailure,
  artifactPrimaryCleanupLeases,
} from "./ArtifactReader.js";
import type {
  ArtifactResourceOwner,
  ArtifactResourceScope,
} from "./ArtifactResourceScope.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "./AnalysisCleanupLease.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { ArtifactLimitBoundary } from "../domain/artifactOperationError.js";
import { ParseFailureError, type LimitRef } from "../domain/parseFailure.js";
import { errorMessage } from "../kernel/errorMessage.js";

/** Artifact projection plus the exact descriptor owner and physical operation outcome. */
export class ArtifactFileCleanupFailure<
  Value = unknown,
> extends ArtifactReaderFailure {
  override readonly cleanupLeases: readonly AnalysisCleanupLease[] | undefined;
  readonly fileCleanupFailure: RegularFileCleanupFailure<Value>;
  constructor(
    fileCleanupFailure: RegularFileCleanupFailure<Value>,
    readonly cleanupLease: AnalysisCleanupLease,
  ) {
    const outcome = fileCleanupFailure.outcome;
    if (
      fileCleanupFailure.operationFailure === undefined &&
      outcome.kind === "failed" &&
      outcome.cause instanceof RegularFileOperationCancelled
    )
      fileCleanupFailure = new RegularFileCleanupFailure({
        ...fileCleanupFailure,
        outcome: {
          kind: "failed",
          cause: artifactOperationCause(outcome.cause),
        },
      });
    const completionCancellation = fileCleanupFailure.completionCancellation;
    const primary =
      fileCleanupFailure.outcome.kind === "failed"
        ? fileCleanupFailure.outcome.cause
        : completionCancellation === undefined
          ? fileCleanupFailure.cleanupCause
          : new ArtifactReaderFailure(
              "cancelled",
              "Artifact read cancelled during close",
              {
                cause: completionCancellation.reason,
              },
            );
    const projected = ArtifactReaderFailure.withCleanup(
      fileCleanupFailure.operationFailure !== undefined &&
        fileCleanupFailure.outcome.kind === "failed" &&
        Object.is(primary, fileCleanupFailure.operationFailure.operationCause)
        ? new ArtifactReaderFailure("io", errorMessage(primary), {
            cause: primary,
          })
        : primary,
      ArtifactReaderFailure.cleanupObservation(
        fileCleanupFailure.cleanupCause,
        fileCleanupFailure.path,
      ),
    );
    super(
      projected.reason,
      projected.message,
      {
        cause: fileCleanupFailure,
        cleanup: projected.cleanup,
        partialObservation: projected.partialObservation,
        cancellation: projected.cancellation,
        ...projected.primaryFacts(),
      },
      projected.details,
    );
    this.fileCleanupFailure = fileCleanupFailure;
    const inherited =
      fileCleanupFailure.operationFailure === undefined &&
      fileCleanupFailure.outcome.kind === "failed"
        ? artifactPrimaryCleanupLeases(fileCleanupFailure.outcome.cause)
        : [];
    this.cleanupLeases =
      inherited === undefined
        ? undefined
        : [...new Set([cleanupLease, ...inherited])];
  }
}

/** Errnos raised while the caller-selected artifact path is being resolved. */
export type ArtifactSelectedPathErrno =
  | "ENOENT"
  | "ENOTDIR"
  | "ELOOP"
  | "ENAMETOOLONG";

/** Return only known path-resolution errnos; permissions and I/O remain distinct. */
export const artifactSelectedPathErrno = (
  cause: unknown,
): ArtifactSelectedPathErrno | undefined => {
  if (!(cause instanceof Error) || !("code" in cause)) return undefined;
  switch (String(cause.code)) {
    case "ENOENT":
      return "ENOENT";
    case "ENOTDIR":
      return "ENOTDIR";
    case "ELOOP":
      return "ELOOP";
    case "ENAMETOOLONG":
      return "ENAMETOOLONG";
    default:
      return undefined;
  }
};

/** Normalize the physical primary failure without replacing its exact cleanup owner. */
export const mapArtifactFileFailure = (
  cause: unknown,
  classify: (cause: unknown) => unknown,
): unknown => {
  if (!(cause instanceof ArtifactFileCleanupFailure)) return classify(cause);
  const physical = cause.fileCleanupFailure;
  if (physical.outcome.kind !== "failed") return cause;
  const primary =
    physical.operationFailure === undefined &&
    physical.outcome.cause instanceof ArtifactFileCleanupFailure
      ? mapArtifactFileFailure(physical.outcome.cause, classify)
      : classify(physical.outcome.cause);
  if (Object.is(primary, physical.outcome.cause)) return cause;
  return new ArtifactFileCleanupFailure(
    new RegularFileCleanupFailure({
      ...physical,
      outcome: { kind: "failed", cause: primary },
    }),
    cause.cleanupLease,
  );
};

export interface ArtifactFilePrimaryFacts {
  readonly cause: unknown;
  readonly origin: "opaque-operation" | "owned-or-classified";
}

/** Preserve physical origin while inspecting only explicit nested operation owners. */
export const artifactFilePrimaryFacts = (
  cause: unknown,
): ArtifactFilePrimaryFacts => {
  while (cause instanceof ArtifactFileCleanupFailure) {
    const physical = cause.fileCleanupFailure;
    if (physical.outcome.kind !== "failed") break;
    cause = physical.outcome.cause;
    if (physical.operationFailure !== undefined)
      return {
        cause,
        origin: Object.is(cause, physical.operationFailure.operationCause)
          ? "opaque-operation"
          : "owned-or-classified",
      };
  }
  return { cause, origin: "owned-or-classified" };
};

/** Cancellation after confirmed close retains the completed physical operation. */
export class ArtifactFileCancelled<
  Value = unknown,
> extends ArtifactReaderFailure {
  constructor(
    readonly fileCancellation: Pick<
      RegularFileCancelled<Value>,
      "reason" | "outcome"
    >,
  ) {
    super("cancelled", "Artifact read cancelled", {
      cause: fileCancellation.reason,
    });
  }
}

/** Completion facts recorded by the file owner, independent of later caller state. */
export const artifactFileCompletion = (
  cause: unknown,
):
  | {
      readonly kind: "completed";
      readonly value: unknown;
      readonly cancellation: { readonly reason: unknown } | undefined;
    }
  | undefined => {
  if (cause instanceof ArtifactFileCancelled)
    return {
      ...cause.fileCancellation.outcome,
      cancellation: { reason: cause.fileCancellation.reason },
    };
  if (
    cause instanceof ArtifactFileCleanupFailure &&
    cause.fileCleanupFailure.outcome.kind === "completed"
  )
    return {
      ...cause.fileCleanupFailure.outcome,
      cancellation: cause.fileCleanupFailure.completionCancellation,
    };
  return undefined;
};

/** Bind a translated failure to its exact descriptor leases, including failed retries. */
export const bindArtifactFileCleanup = (
  cause: unknown,
  error: AnalysisError,
): void => {
  const leases =
    cause instanceof ArtifactReaderFailure ? cause.cleanupLeases : undefined;
  if (leases !== undefined) new AnalysisCleanupLeaseGroup(error, leases);
};

/** Interpret this owner's typed cancellation, preserving an undefined reason. */
export const artifactFileCancellationCause = (
  cause: ArtifactReaderFailure,
): unknown => {
  return cause.cancellation === undefined
    ? cause.cause
    : cause.cancellation.reason;
};

/** Report cancellation at the read stage that actually observed the caller signal. */
export const assertArtifactReadActive = (
  signal: AbortSignal | undefined,
): void => {
  if (signal?.aborted)
    throw new ArtifactReaderFailure("cancelled", "Artifact read cancelled", {
      cause: signal.reason,
    });
};

/**
 * Project a failure raised by a domain byte parser over artifact bytes onto the
 * reader's reasons: the caller's cancellation (`signal.reason`) becomes
 * `cancelled`, parser failure kinds stay distinct, and a decode budget is
 * bounded by `limitBoundary`. Every other cause passes through unchanged.
 */
export const artifactParseFailure = (
  cause: unknown,
  signal: AbortSignal | undefined,
  limitBoundary?: (limit: LimitRef) => ArtifactLimitBoundary | undefined,
): unknown => {
  if (signal?.aborted === true && Object.is(cause, signal.reason))
    return new ArtifactReaderFailure("cancelled", "Artifact read cancelled", {
      cause,
    });
  if (!(cause instanceof ParseFailureError)) return cause;
  const { failure } = cause;
  if (failure.kind === "limit") {
    const boundary = limitBoundary?.(failure.limit);
    return new ArtifactReaderFailure("limit", cause.message, {
      cause,
      ...(boundary === undefined ? {} : { boundary }),
    });
  }
  return new ArtifactReaderFailure(failure.kind, cause.message, { cause });
};

/** Recognize only the originating caller's cancellation without discarding cleanup ownership. */
export const artifactReadCancelledBy = (
  cause: unknown,
  signal: AbortSignal | undefined,
): boolean =>
  signal?.aborted === true &&
  cause instanceof ArtifactReaderFailure &&
  cause.reason === "cancelled" &&
  cause.cleanup === undefined &&
  Object.is(cause.cancellation?.reason, signal.reason);

/** Admit a regular file without blocking on pipes, retaining failed admission closes. */
export const withArtifactRegularFile = async <Value>(
  path: string,
  resources: {
    retain(
      owner: Extract<ArtifactResourceOwner, { readonly kind: "lease" }>,
    ): void;
  },
  signal: AbortSignal | undefined,
  operation: (source: StableRegularFileDescriptor) => Promise<Value>,
  symlinks: "follow" | "reject" = "reject",
): Promise<Value> => {
  let cleanupLease: AnalysisCleanupLease | undefined;
  assertArtifactReadActive(signal);
  try {
    const value = await withOwnedRegularFile(
      path,
      {
        symlinks,
        ...(signal === undefined ? {} : { signal }),
        retainFailedClose: (owner) => {
          cleanupLease = new AnalysisCleanupLease(() => owner.close(), [path]);
          resources.retain({
            kind: "lease",
            resource: path,
            lease: cleanupLease,
          });
        },
      },
      async (source) => {
        assertArtifactReadActive(signal);
        return await operation(source);
      },
    );
    return value;
  } catch (cause: unknown) {
    if (
      cause instanceof RegularFileCleanupFailure &&
      cleanupLease !== undefined
    )
      throw new ArtifactFileCleanupFailure(cause, cleanupLease);
    if (cause instanceof RegularFileCancelled)
      throw new ArtifactFileCancelled(cause);
    throw artifactOperationCause(cause);
  }
};

/** Keep admission, operation outcome, final close and failed-owner transfer together. */
export const withArtifactFileHandle = async <Value>(
  path: string,
  file: FileHandle,
  resources: ArtifactResourceScope | undefined,
  signal: AbortSignal | undefined,
  operation: (file: FileHandle) => Promise<Value>,
): Promise<Value> => {
  const owner = new OwnedFileHandle(file);
  const cleanupLease = new AnalysisCleanupLease(() => owner.close(), [path]);
  try {
    return await withOwnedFileHandle(
      path,
      owner,
      {
        ...(signal === undefined ? {} : { signal }),
        retainFailedClose: () =>
          resources?.retain({
            kind: "lease",
            resource: path,
            lease: cleanupLease,
          }),
      },
      operation,
    );
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure)
      throw new ArtifactFileCleanupFailure(cause, cleanupLease);
    if (cause instanceof RegularFileCancelled)
      throw new ArtifactFileCancelled(cause);
    throw artifactOperationCause(cause);
  }
};

/** Convert only cancellation produced by the regular-file owner. */
export const artifactOperationCause = (cause: unknown): unknown =>
  cause instanceof RegularFileOperationCancelled
    ? new ArtifactReaderFailure(
        "cancelled",
        "Artifact file operation cancelled",
        { cause: cause.reason },
      )
    : cause;
