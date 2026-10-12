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
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  readJsonInputFile,
  readJsonObjectFile,
  type JsonObjectMemberReader,
} from "./JsonInputFile.js";
import { NonRegularFileReadError } from "../filesystem/RegularFile.js";
import { RegularFileCleanupFailure } from "./RegularFileRead.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { OwnedStagedOutput } from "../filesystem/OwnedStagedOutput.js";

/** Request control and its owning operation for an interruptible atomic write. */
export interface TextWriteCancellation {
  readonly signal: AbortSignal;
  readonly operation: string;
}

type TextWriteResult<Failure = EvidenceFileError | AnalysisCancelledError> =
  Result<{ readonly path: string; readonly bytes: number }, Failure>;

/** Read JSON data from a regular file at the caller-supplied path. */
export const readJsonFile = async (
  path: string,
  signal?: AbortSignal,
  resources?: ArtifactResourceScope,
): Promise<
  Result<unknown, EvidenceFileError | AnalysisResourceConstraintError>
> =>
  readJsonFileInput(
    path,
    (selected) =>
      readJsonInputFile(selected, "read_evidence_file", signal, resources),
    signal,
  );

/** Read selected JSON members through the same regular-file error boundary. */
export const readJsonObjectMembersFile = (
  path: string,
  scans: readonly ReadonlyMap<string, JsonObjectMemberReader>[],
  signal?: AbortSignal,
  resources?: ArtifactResourceScope,
): Promise<
  Result<
    void,
    EvidenceFileError | AnalysisResourceConstraintError | AnalysisCancelledError
  >
> =>
  readJsonFileInput(
    path,
    (selected) =>
      readJsonObjectFile(
        selected,
        "read_evidence_file",
        scans,
        signal,
        resources,
      ),
    signal,
  );

const readJsonFileInput = async <Value>(
  path: string,
  read: (
    selected: string,
  ) => Promise<
    Result<
      Value,
      | import("../domain/analysisErrorCore.js").AnalysisInputError
      | AnalysisResourceConstraintError
    >
  >,
  signal?: AbortSignal,
): Promise<
  Result<Value, EvidenceFileError | AnalysisResourceConstraintError>
> => {
  const requestedPath = resolve(path);
  try {
    const decoded = await read(requestedPath);
    if (!decoded.ok) {
      if (decoded.error instanceof AnalysisResourceConstraintError)
        return err(decoded.error);
      return err(
        new EvidenceFileError("read", "invalid-json", {
          cause:
            decoded.error.cause ??
            new SyntaxError(
              decoded.error.issues[0]?.message ?? decoded.error.message,
            ),
          path: requestedPath,
        }),
      );
    }
    return ok(decoded.value);
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    if (cause instanceof AnalysisResourceConstraintError) return err(cause);
    if (signal?.aborted === true) throw cause;
    return err(
      new EvidenceFileError(
        "read",
        cause instanceof NonRegularFileReadError
          ? "not-file"
          : missingOrIo(cause),
        {
          cause,
          path: requestedPath,
        },
      ),
    );
  }
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
      return err(
        new EvidenceFileError("write", "io", {
          cause,
          path: resolve(path),
          ...(cleanup === undefined ? {} : { cleanup }),
        }),
      );
    });
}

const writeTextPartsOwned = async (
  parts: Iterable<string>,
  path: string,
  overwrite: boolean,
  resources: ArtifactResourceScope,
  cancellation?: TextWriteCancellation,
): Promise<TextWriteResult> => {
  const requestedPath = resolve(path);
  try {
    assertWriteActive(cancellation);
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
        return err(
          new EvidenceFileError("write", "io", {
            cause,
            path: requestedPath,
            cleanup,
            published: { ...cause.outcome.value, path: requestedPath },
          }),
        );
      if (cause.outcome.error instanceof AnalysisCancelledError)
        return err(
          new AnalysisCancelledError(cause.outcome.error.operation, {
            cause,
            cleanup,
          }),
        );
      return err(
        new EvidenceFileError("write", missingOrIo(cause.outcome.error), {
          cause,
          path: requestedPath,
          cleanup,
        }),
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
    await owner.setFile(new OwnedFileHandle(file));
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
    throw new StagedOutputCleanupFailure(outcome, released.cause, owner);
  if (!outcome.ok) throw outcome.error;
  return outcome.value.bytes;
};

class StagedOutputCleanupFailure extends Error {
  constructor(
    readonly outcome: Result<PublishedEvidenceFile, unknown>,
    readonly cleanupCause: unknown,
    readonly owner: OwnedStagedOutput,
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
    throw new AnalysisCancelledError(cancellation.operation);
};

const fileErrorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? cause.code
    : undefined;
