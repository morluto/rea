import {
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  rename,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  EvidenceFileError,
  type PublishedEvidenceFile,
} from "../domain/evidenceErrors.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
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
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";
import {
  type AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../artifacts/AnalysisCleanupLease.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { OwnedStagedOutput } from "../filesystem/OwnedStagedOutput.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";

/** Request control and its owning operation for an interruptible atomic write. */
export interface TextWriteCancellation {
  readonly signal: AbortSignal;
  readonly operation: string;
}

type TextWriteResult<Failure = EvidenceFileError | AnalysisCancelledError> =
  Result<{ readonly path: string; readonly bytes: number }, Failure>;

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
  readJsonFileInput<{ readonly data: unknown; readonly path: string }>(
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
export const readJsonObjectMembersFile = <Value, Failure extends AnalysisError>(
  path: string,
  scans: readonly ReadonlyMap<string, JsonObjectMemberReader>[],
  complete: () => Result<Value, Failure>,
  signal?: AbortSignal,
  resources?: ArtifactResourceScope,
  operation = "read_evidence_file",
): Promise<Result<Value, JsonFileReadFailure | Failure>> =>
  readJsonFileInput<Value, Failure>(
    path,
    (selected) =>
      readJsonObjectFile(
        selected,
        operation,
        scans,
        complete,
        signal,
        resources,
      ),
    signal,
    operation,
  );

const readJsonFileInput = async <Value, Failure extends AnalysisError = never>(
  path: string,
  read: (
    selected: string,
  ) => Promise<
    Result<
      Value,
      AnalysisInputError | AnalysisResourceConstraintError | Failure
    >
  >,
  signal?: AbortSignal,
  operation = "read_evidence_file",
): Promise<Result<Value, JsonFileReadFailure | Failure>> => {
  const requestedPath = absoluteCallerPath(path);
  try {
    return decodedJsonFileResult(await read(requestedPath), requestedPath);
  } catch (cause: unknown) {
    // Caller reasons are opaque, including objects shaped like file failures.
    if (
      !isJsonReadCancellation(cause, signal) &&
      cause instanceof RegularFileCleanupFailure
    )
      throw cause;
    return err(jsonFileReadFailure(cause, requestedPath, operation, signal));
  }
};

type DecodedJsonInput<Value, Failure extends AnalysisError = never> = Result<
  Value,
  AnalysisInputError | AnalysisResourceConstraintError | Failure
>;
type JsonFileReadFailure =
  | EvidenceFileError
  | AnalysisResourceConstraintError
  | AnalysisCancelledError;

const decodedJsonFileResult = <Value, Failure extends AnalysisError>(
  decoded: DecodedJsonInput<Value, Failure>,
  path: string,
): Result<Value, JsonFileReadFailure | Failure> => {
  if (!decoded.ok) {
    if (!(decoded.error instanceof AnalysisInputError))
      return err(decoded.error);
    return err(
      new EvidenceFileError("read", "invalid-json", {
        cause:
          decoded.error.cause ??
          new SyntaxError(
            decoded.error.issues[0]?.message ?? decoded.error.message,
          ),
        path,
      }),
    );
  }
  return ok(decoded.value);
};

const jsonFileReadFailure = (
  cause: unknown,
  requestedPath: string,
  operation: string,
  signal?: AbortSignal,
): JsonFileReadFailure => {
  // Check the caller's own reason first so its shape grants no other meaning.
  if (isJsonReadCancellation(cause, signal))
    return new AnalysisCancelledError(operation, { cause: signal?.reason });
  if (cause instanceof AnalysisResourceConstraintError) return cause;
  if (cause instanceof JsonInputCancellationFailure)
    return new AnalysisCancelledError(operation, { cause: cause.reason });
  if (cause instanceof JsonInputPhysicalReadFailure)
    return new EvidenceFileError("read", "io", {
      cause: cause.physicalCause,
      path: requestedPath,
    });
  return new EvidenceFileError(
    "read",
    cause instanceof NonRegularFileReadError ? "not-file" : missingOrIo(cause),
    { cause, path: requestedPath },
  );
};

/** Preserve the JSON owner's physical or decoded primary before composing cleanup. */
export const jsonFileCleanupPrimary = <Failure extends AnalysisError = never>(
  failure: RegularFileCleanupFailure<DecodedJsonInput<unknown, Failure>>,
  operation: string,
  signal?: AbortSignal,
): JsonFileReadFailure | Failure | undefined => {
  const cancellation = regularFileCancellation(failure);
  if (failure.outcome.kind === "failed")
    return cancellation === undefined
      ? jsonFileReadFailure(
          failure.outcome.cause,
          failure.path,
          operation,
          signal,
        )
      : new AnalysisCancelledError(operation, { cause: cancellation.reason });
  const decoded = decodedJsonFileResult(failure.outcome.value, failure.path);
  if (!decoded.ok) return decoded.error;
  if (cancellation !== undefined || signal?.aborted === true)
    return new AnalysisCancelledError(operation, {
      cause: cancellation === undefined ? signal?.reason : cancellation.reason,
    });
  return undefined;
};

const isJsonReadCancellation = (
  cause: unknown,
  signal?: AbortSignal,
): boolean => {
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

/** Atomically write text to the caller-supplied path. */
export const writeTextFile = async (
  encoded: string,
  path: string,
  overwrite: boolean,
  resources: ArtifactResourceScope,
): Promise<TextWriteResult<EvidenceFileError>> =>
  writeTextParts([encoded], path, overwrite, resources);

/** Publish streamed text atomically unless cancellation wins before publication. */
export function writeTextParts(
  parts: Iterable<string>,
  path: string,
  overwrite: boolean,
  resources: ArtifactResourceScope,
): Promise<TextWriteResult<EvidenceFileError>>;
export function writeTextParts(
  parts: Iterable<string>,
  path: string,
  overwrite: boolean,
  resources: ArtifactResourceScope,
  cancellation: TextWriteCancellation | undefined,
): Promise<TextWriteResult>;
export function writeTextParts(
  parts: Iterable<string>,
  path: string,
  overwrite: boolean,
  resources: ArtifactResourceScope,
  cancellation?: TextWriteCancellation,
): Promise<TextWriteResult> {
  return resources
    .run(() =>
      writeTextPartsOwned(parts, path, overwrite, resources, cancellation),
    )
    .catch((cause: unknown) => {
      const cleanup =
        cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
          ? cause.cleanup
          : undefined;
      const error = new EvidenceFileError("write", "io", {
        cause,
        path: absoluteCallerPath(path),
        ...(cleanup === undefined ? {} : { cleanup }),
      });
      // A failed admission retry names its exact retained leases.
      bindArtifactFileCleanup(cause, error);
      return err(error);
    });
}

const writeTextPartsOwned = async (
  parts: Iterable<string>,
  path: string,
  overwrite: boolean,
  resources: ArtifactResourceScope,
  cancellation?: TextWriteCancellation,
): Promise<TextWriteResult> => {
  const requestedPath = absoluteCallerPath(path);
  try {
    assertWriteActive(cancellation);
    if (process.platform !== "win32" && requestedPath.endsWith("/"))
      return err(
        new EvidenceFileError("write", "not-file", { path: requestedPath }),
      );
    const canonicalParent = await realpath(dirname(requestedPath));
    const destination = resolve(canonicalParent, basename(requestedPath));
    const existing = await lstat(destination).catch((cause: unknown) => {
      if (fileErrorCode(cause) === "ENOENT") return undefined;
      throw cause;
    });
    if (existing !== undefined) {
      if (!overwrite)
        return err(
          new EvidenceFileError("write", "exists", { path: requestedPath }),
        );
      if (!existing.isFile() || existing.isSymbolicLink())
        return err(
          new EvidenceFileError("write", "not-file", { path: requestedPath }),
        );
    }
    assertWriteActive(cancellation);
    const bytes = await publishFile(
      destination,
      parts,
      overwrite,
      resources,
      cancellation,
    );
    return ok({ path: requestedPath, bytes });
  } catch (cause: unknown) {
    if (cause instanceof StagedOutputCleanupFailure) {
      const cleanup = {
        reason: failureMessage(cause.cleanupCause),
        resources: [cause.owner.directory],
      };
      if (cause.outcome.ok)
        return stagedCleanupFailure(
          new EvidenceFileError("write", "io", {
            cause,
            path: requestedPath,
            cleanup,
            published: { ...cause.outcome.value, path: requestedPath },
          }),
          cause.lease,
        );
      if (cause.outcome.error instanceof AnalysisCancelledError)
        return stagedCleanupFailure(
          new AnalysisCancelledError(cause.outcome.error.operation, {
            cause: cause.outcome.error.cause,
            cleanupPrimary: cause.outcome.error,
            cleanup,
          }),
          cause.lease,
        );
      return stagedCleanupFailure(
        new EvidenceFileError("write", missingOrIo(cause.outcome.error), {
          cause,
          path: requestedPath,
          cleanup,
        }),
        cause.lease,
      );
    }
    if (
      cancellation?.signal.aborted === true &&
      cause instanceof AnalysisCancelledError &&
      cause.operation === cancellation.operation
    )
      return err(cause);
    if (!overwrite && fileErrorCode(cause) === "EEXIST")
      return err(
        new EvidenceFileError("write", "exists", {
          cause,
          path: requestedPath,
        }),
      );
    return err(
      new EvidenceFileError("write", missingOrIo(cause), {
        cause,
        path: requestedPath,
      }),
    );
  }
};

/** The retained staging lease clears this error only when a retry confirms release. */
const stagedCleanupFailure = <
  Failure extends EvidenceFileError | AnalysisCancelledError,
>(
  error: Failure,
  lease: AnalysisCleanupLease,
): Result<never, Failure> => {
  new AnalysisCleanupLeaseGroup(error, [lease]);
  return err(error);
};

/** A missing path or parent is a selection error, not a permission failure. */
const missingOrIo = (cause: unknown): "missing" | "io" => {
  const code = fileErrorCode(cause);
  return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "io";
};

const publishFile = async (
  destination: string,
  parts: Iterable<string>,
  overwrite: boolean,
  resources: ArtifactResourceScope,
  cancellation?: TextWriteCancellation,
): Promise<number> => {
  const stagingDirectory = await mkdtemp(
    resolve(dirname(destination), ".rea-write-"),
  );
  const owner = await OwnedStagedOutput.create(stagingDirectory);
  let outcome: Result<PublishedEvidenceFile, unknown>;
  const staged = resolve(stagingDirectory, "content");
  try {
    const file = await open(staged, "wx", 0o600);
    owner.setFile(new OwnedFileHandle(file));
    let written: Result<number, unknown>;
    try {
      const bytes = await writeStagedParts(file, parts, cancellation);
      assertWriteActive(cancellation);
      await file.sync();
      written = ok(bytes);
    } catch (cause: unknown) {
      written = err(cause);
    }
    try {
      await owner.closeFile();
    } catch (cause: unknown) {
      if (written.ok) written = err(cause);
    }
    if (!written.ok) throw written.error;
    // Once submitted, atomic publication can win a later cancellation race.
    assertWriteActive(cancellation);
    await owner.assertReadyForPublication(staged);
    assertWriteActive(cancellation);
    if (overwrite) {
      await rename(staged, destination);
      owner.recordPublishedRename();
    }
    // A hard link publishes complete bytes atomically and cannot replace an existing name.
    else await link(staged, destination);
    outcome = ok({ path: destination, bytes: written.value });
  } catch (cause: unknown) {
    outcome = err(cause);
  }

  // One cleanup phase owns both the open descriptor (if any) and its staging directory.
  const released = await resources.release({
    kind: "staged-output",
    resource: owner.directory,
    output: owner,
  });
  if (released.kind === "failed")
    throw new StagedOutputCleanupFailure(
      outcome,
      released.cause,
      owner,
      released.lease,
    );
  if (!outcome.ok) throw outcome.error;
  return outcome.value.bytes;
};

class StagedOutputCleanupFailure extends Error {
  constructor(
    readonly outcome: Result<PublishedEvidenceFile, unknown>,
    readonly cleanupCause: unknown,
    readonly owner: OwnedStagedOutput,
    readonly lease: AnalysisCleanupLease,
  ) {
    super("Staged output cleanup failed", {
      cause: outcome.ok ? cleanupCause : outcome.error,
    });
  }
}

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message || cause.name : String(cause);

const writeStagedParts = async (
  file: FileHandle,
  parts: Iterable<string>,
  cancellation?: TextWriteCancellation,
): Promise<number> => {
  assertWriteActive(cancellation);
  const iterator = parts[Symbol.iterator]();
  let exhausted = false;
  let bytes = 0;
  try {
    for (;;) {
      assertWriteActive(cancellation);
      const part = iterator.next();
      if (part.done) exhausted = true;
      assertWriteActive(cancellation);
      if (part.done) return bytes;
      await file.writeFile(part.value, { encoding: "utf8" });
      bytes += Buffer.byteLength(part.value, "utf8");
    }
  } finally {
    if (!exhausted) iterator.return?.();
  }
};

const assertWriteActive = (cancellation?: TextWriteCancellation): void => {
  if (cancellation?.signal.aborted === true)
    throw new AnalysisCancelledError(cancellation.operation, {
      cause: cancellation.signal.reason,
    });
};

const fileErrorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? cause.code
    : undefined;
