import {
  ArtifactReaderFailure,
  malformedArtifact,
} from "../resources/index.js";
import { InternalInvariantError } from "../domain/internalInvariant.js";

/** Preserve cancellation at the ASAR boundary with its original abort reason. */
export const asarCancellationFailure = (
  reason: unknown,
): ArtifactReaderFailure =>
  new ArtifactReaderFailure("cancelled", "ASAR operation cancelled", {
    cause: reason,
  });

export const assertAsarReadActive = (signal?: AbortSignal): void => {
  if (signal?.aborted === true) throw asarCancellationFailure(signal.reason);
};

/** Classify ASAR boundary failures without replacing ownership-bearing errors. */
export const asarFailure = (
  path: string,
  operation: string,
  cause: unknown,
): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  // A broken REA assumption is a defect, never a fact about the archive.
  if (cause instanceof InternalInvariantError) throw cause;
  if (isFilesystemFailure(cause))
    return new ArtifactReaderFailure(
      "io",
      `Could not ${operation} ASAR at ${path}: ${cause.message}`,
      { cause },
    );
  return malformedArtifact(
    "asar",
    `Malformed ASAR during ${operation}: ${path}`,
    {
      cause,
    },
  );
};

const isFilesystemFailure = (
  cause: unknown,
): cause is NodeJS.ErrnoException & Error =>
  cause instanceof Error &&
  "errno" in cause &&
  typeof cause.errno === "number" &&
  "syscall" in cause &&
  typeof cause.syscall === "string";
