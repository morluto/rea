import { EvidenceFileError } from "../domain/evidenceErrors.js";
import {
  AnalysisCancelledError,
  type AnalysisInputError,
  AnalysisResourceConstraintError,
  cancelledBy,
  carriedReason,
  type AbortedSignal,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { childFailureDiagnostics } from "../domain/analysisErrorProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  JsonInputPhysicalReadFailure,
  JsonInputCancellationFailure,
  readJsonInputFile,
  readJsonObjectFile,
  type JsonObjectMemberReader,
} from "./JsonInputFile.js";
import { NonRegularFileReadError } from "../filesystem/RegularFile.js";
import {
  RegularFileCleanupFailure,
  regularFileCancellation,
} from "../filesystem/OwnedRegularFile.js";
import {
  bindRegularFileCleanup,
  regularFileCleanupLeases,
} from "../process/RegularFileRead.js";
import {
  type ArtifactResourceScope,
  ArtifactReaderFailure,
  type AnalysisCleanupLease,
  fileAccessFailureReason,
} from "../resources/index.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";

// The JSON read owner records the exact leases it binds; consumers never
// infer cleanup ownership from matching resource labels.
const jsonReadLeases = new WeakMap<
  EvidenceFileError,
  readonly AnalysisCleanupLease[]
>();
export const jsonFileReadCleanupLeases = (
  error: EvidenceFileError,
): readonly AnalysisCleanupLease[] | undefined => jsonReadLeases.get(error);
const rememberJsonReadCleanup = (
  error: EvidenceFileError,
  cause: unknown,
): void => {
  const leases = regularFileCleanupLeases(cause);
  if (leases !== undefined) jsonReadLeases.set(error, leases);
};

/** Read JSON data without changing the caller's existing data-only contract. */
export const readJsonFile = async (
  path: string,
  signal?: AbortSignal,
  resources?: ArtifactResourceScope,
  operation = "read_evidence_file",
): Promise<
  Result<
    unknown,
    EvidenceFileError | AnalysisResourceConstraintError | AnalysisCancelledError
  >
> => {
  const read = await readJsonFileWithSource(path, signal, resources, operation);
  return read.ok ? ok(read.value.data) : read;
};

/** Read data and the absolute selected path at the same owning regular-file boundary. */
export const readJsonFileWithSource = (
  path: string,
  signal?: AbortSignal,
  resources?: ArtifactResourceScope,
  operation = "read_evidence_file",
): Promise<
  Result<
    { readonly data: unknown; readonly path: string },
    EvidenceFileError | AnalysisResourceConstraintError | AnalysisCancelledError
  >
> =>
  readJsonFileInput(
    path,
    async (selected) => {
      const read = await readJsonInputFile(
        selected,
        operation,
        signal,
        resources,
      );
      return read.ok ? ok({ data: read.value, path: selected }) : read;
    },
    signal,
    operation,
  );

/** Read selected JSON members through the same regular-file error boundary. */
export const readJsonObjectMembersFile = (
  path: string,
  scans: readonly ReadonlyMap<string, JsonObjectMemberReader>[],
  signal?: AbortSignal,
  resources?: ArtifactResourceScope,
  operation = "read_evidence_file",
): Promise<
  Result<
    void,
    EvidenceFileError | AnalysisResourceConstraintError | AnalysisCancelledError
  >
> =>
  readJsonFileInput(
    path,
    (selected) =>
      readJsonObjectFile(selected, operation, scans, signal, resources),
    signal,
    operation,
  );

type JsonFileReadFailure =
  | EvidenceFileError
  | AnalysisResourceConstraintError
  | AnalysisCancelledError;
type DecodedJsonInput<Value> = Result<
  Value,
  AnalysisInputError | AnalysisResourceConstraintError
>;

const readJsonFileInput = async <Value>(
  path: string,
  read: (selected: string) => Promise<DecodedJsonInput<Value>>,
  signal?: AbortSignal,
  operation = "read_evidence_file",
): Promise<Result<Value, JsonFileReadFailure>> => {
  const requestedPath = absoluteCallerPath(path);
  try {
    return decodedJsonFileResult(await read(requestedPath), requestedPath);
  } catch (cause: unknown) {
    // Caller reasons are opaque, including instances of lifecycle failure types.
    if (signal?.aborted === true && cause === signal.reason)
      return err(cancelledBy(operation, carriedReason(cause)));
    if (cause instanceof RegularFileCleanupFailure)
      return err(
        jsonFileCleanupError(
          cause as RegularFileCleanupFailure<DecodedJsonInput<Value>>,
          requestedPath,
          operation,
          signal,
        ),
      );
    if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined) {
      const primary =
        cause.reason === "cancelled"
          ? cancelledBy(
              operation,
              carriedReason(
                cause.cancellation === undefined
                  ? cause.cause
                  : cause.cancellation.reason,
              ),
              { partialObservation: cause.partialObservation },
            )
          : undefined;
      const error = new EvidenceFileError("read", "io", {
        cause,
        path: requestedPath,
        cleanup: cause.cleanup,
        partialObservation: cause.partialObservation,
        cleanupPrimary: primary,
        ...(primary === undefined
          ? {}
          : childFailureDiagnostics({ primary_error: { error: primary } })),
      });
      bindRegularFileCleanup(cause, error);
      rememberJsonReadCleanup(error, cause);
      return err(error);
    }
    return err(jsonFileReadFailure(cause, requestedPath, operation, signal));
  }
};

/** Parsing owns its typed refusal even when final descriptor cleanup fails. */
const decodedJsonFileResult = <Value>(
  decoded: DecodedJsonInput<Value>,
  path: string,
): Result<Value, JsonFileReadFailure> => {
  if (decoded.ok) return decoded;
  if (decoded.error instanceof AnalysisResourceConstraintError)
    return err(decoded.error);
  return err(
    new EvidenceFileError("read", "invalid-json", {
      cause:
        decoded.error.cause ??
        new SyntaxError(
          decoded.error.issues[0]?.message ?? decoded.error.message,
        ),
      path,
      ...(decoded.error.userMessage === undefined
        ? {}
        : { userMessage: decoded.error.userMessage }),
      contentIssues: decoded.error.issues,
    }),
  );
};

const jsonFileReadFailure = (
  cause: unknown,
  path: string,
  operation: string,
  signal?: AbortSignal,
): JsonFileReadFailure => {
  if (cause instanceof AnalysisResourceConstraintError) return cause;
  if (cause instanceof JsonInputCancellationFailure)
    return cancelledBy(operation, carriedReason(cause.reason));
  if (cause instanceof JsonInputPhysicalReadFailure)
    return new EvidenceFileError("read", "io", {
      cause: cause.physicalCause,
      path,
    });
  if (isJsonReadCancellation(cause, signal))
    return cancelledBy(operation, signal);
  return new EvidenceFileError(
    "read",
    cause instanceof NonRegularFileReadError
      ? "not-file"
      : fileAccessFailureReason(cause),
    { cause, path },
  );
};

/** Translate the physical outcome once, binding the resulting Result to its owner. */
const jsonFileCleanupError = <Value>(
  failure: RegularFileCleanupFailure<DecodedJsonInput<Value>>,
  path: string,
  operation: string,
  signal?: AbortSignal,
): EvidenceFileError => {
  const cleanup = new EvidenceFileError("read", "io", {
    cause: failure,
    path,
    cleanup: {
      reason:
        failure.cleanupCause instanceof Error
          ? failure.cleanupCause.message
          : String(failure.cleanupCause),
      resources: [failure.path],
    },
  });
  bindRegularFileCleanup(failure, cleanup);
  rememberJsonReadCleanup(cleanup, failure);
  const cancellation = regularFileCancellation(failure);
  let primary: AnalysisError | undefined;
  if (failure.outcome.kind === "failed") {
    primary =
      cancellation === undefined
        ? jsonFileReadFailure(failure.outcome.cause, path, operation, signal)
        : cancelledBy(operation, carriedReason(cancellation.reason));
  } else {
    const decoded = decodedJsonFileResult(failure.outcome.value, path);
    if (!decoded.ok) primary = decoded.error;
    else if (cancellation !== undefined)
      primary = cancelledBy(operation, carriedReason(cancellation.reason));
  }
  if (primary === undefined) return cleanup;
  const combined = new EvidenceFileError("read", "io", {
    path,
    cause: new AggregateError(
      [primary, cleanup],
      "JSON read and cleanup failures",
      { cause: primary },
    ),
    cleanupPrimary: primary,
    cleanup: cleanup.cleanup,
    ...childFailureDiagnostics({ primary_error: { error: primary } }),
  }).bindCleanupDependencies([primary, cleanup]);
  if (!primary.cleanupIncomplete) rememberJsonReadCleanup(combined, failure);
  return combined;
};

const isJsonReadCancellation = (
  cause: unknown,
  signal?: AbortSignal,
): signal is AbortedSignal => {
  if (signal?.aborted !== true) return false;
  if (cause === signal.reason) return true;
  return (
    cause instanceof Error &&
    cause.name === "AbortError" &&
    "code" in cause &&
    cause.code === "ABORT_ERR" &&
    cause.cause === signal.reason
  );
};
