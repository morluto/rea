import {
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { EvidenceFileError } from "../domain/evidenceErrors.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import { parseUtf8Json } from "./Utf8JsonInput.js";
import { NonRegularFileReadError, readRegularFile } from "./RegularFileRead.js";

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
): Promise<
  Result<unknown, EvidenceFileError | AnalysisResourceConstraintError>
> => {
  const requestedPath = resolve(path);
  try {
    const encoded = await readRegularFile(requestedPath);
    const decoded = parseUtf8Json(encoded, "read_evidence_file", requestedPath);
    if (!decoded.ok) {
      return err(
        new EvidenceFileError("read", "invalid-json", {
          cause: decoded.cause,
          path: requestedPath,
        }),
      );
    }
    return ok(decoded.value);
  } catch (cause: unknown) {
    if (cause instanceof AnalysisResourceConstraintError) return err(cause);
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
): Promise<TextWriteResult<EvidenceFileError>> =>
  writeTextParts([encoded], path, overwrite);

/** Publish streamed text atomically unless cancellation wins before publication. */
export function writeTextParts(
  parts: Iterable<string>,
  path: string,
  overwrite: boolean,
): Promise<TextWriteResult<EvidenceFileError>>;
/** Pass request control to stop streamed generation before atomic publication. */
export function writeTextParts(
  parts: Iterable<string>,
  path: string,
  overwrite: boolean,
  cancellation: TextWriteCancellation | undefined,
): Promise<TextWriteResult>;
export async function writeTextParts(
  parts: Iterable<string>,
  path: string,
  overwrite: boolean,
  cancellation?: TextWriteCancellation,
): Promise<TextWriteResult> {
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
      cancellation,
    );
    return ok({ path: requestedPath, bytes });
  } catch (cause: unknown) {
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
}

/** A missing path or parent is a selection error, not a permission failure. */
const missingOrIo = (cause: unknown): "missing" | "io" => {
  const code = fileErrorCode(cause);
  return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "io";
};

const publishFile = async (
  destination: string,
  parts: Iterable<string>,
  overwrite: boolean,
  cancellation?: TextWriteCancellation,
): Promise<number> => {
  const stagingDirectory = await mkdtemp(
    resolve(dirname(destination), ".rea-write-"),
  );
  try {
    const staged = resolve(stagingDirectory, "content");
    const file = await open(staged, "wx", 0o600);
    let bytes = 0;
    try {
      bytes = await writeStagedParts(file, parts, cancellation);
      assertWriteActive(cancellation);
      await file.sync();
    } finally {
      await file.close();
    }
    // Once submitted, the atomic publication can win a later cancellation race.
    assertWriteActive(cancellation);
    if (overwrite) await rename(staged, destination);
    // A hard link publishes complete bytes atomically and cannot replace an existing name.
    else await link(staged, destination);
    return bytes;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
};

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
