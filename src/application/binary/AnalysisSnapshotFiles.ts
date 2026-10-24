import { setImmediate } from "node:timers/promises";

import {
  prepareSnapshotEntry,
  parsePreparedAnalysisSnapshot,
  type PreparedSnapshotEntry,
  serializeAnalysisSnapshot,
  type AnalysisSnapshot,
} from "../../domain/analysisSnapshot.js";
import {
  EvidenceFileError,
  EvidenceIntegrityError,
} from "../../domain/evidenceErrors.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  type AnalysisInputError,
  type AnalysisResourceConstraintError,
  AnalysisCancelledError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import {
  jsonFileCleanupPrimary,
  readJsonObjectMembersFile,
  writeTextFile,
} from "../JsonFiles.js";
import { RegularFileRetainedCleanupFailure } from "../RegularFileRead.js";
import { RegularFileCleanupFailure } from "../../filesystem/OwnedRegularFile.js";
import type { JsonObjectMemberReader } from "../JsonInputFile.js";
import { AnalysisCleanupLeaseGroup } from "../../artifacts/AnalysisCleanupLease.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";

const READ_OPERATION = "open_binary";

type SnapshotFailure = EvidenceFileError | EvidenceIntegrityError;

/** Read and validate an analysis snapshot from the caller's path. */
export const readAnalysisSnapshot = async (
  path: string,
  signal?: AbortSignal,
  resources?: ArtifactResourceScope,
): Promise<Result<AnalysisSnapshot, AnalysisError>> => {
  const entries = snapshotEntryReader("provider");
  const workflows = snapshotEntryReader("workflow");
  const header: Record<string, unknown> = {};
  const metadata = new Map<string, JsonObjectMemberReader>(
    ["target", "binding", "evidence_bundle"].map((name) => [
      name,
      {
        mode: "value",
        begin: () => {
          delete header[name];
        },
        accept: (value) => {
          header[name] = value;
        },
        reject: (cause) => {
          throw cause;
        },
      },
    ]),
  );
  try {
    const loaded = await readJsonObjectMembersFile(
      path,
      [
        new Map([
          ["entries", entries.reader],
          ["workflow_entries", workflows.reader],
        ]),
        metadata,
      ],
      () => {
        try {
          return ok(
            parsePreparedAnalysisSnapshot(
              header,
              entries.finish(),
              workflows.finish(),
            ),
          );
        } catch (cause: unknown) {
          return err(
            new EvidenceIntegrityError(snapshotValidationMessage(cause), {
              cause,
            }),
          );
        }
      },
      signal,
      resources,
      READ_OPERATION,
    );
    if (!loaded.ok) return loaded;
    // Deliver queued cancellation before handing a complete cache to the session.
    await setImmediate();
    if (signal?.aborted === true) return err(snapshotCancelled(signal));
    return loaded;
  } catch (cause: unknown) {
    // Caller reasons are opaque, including objects shaped like file failures.
    if (signal?.aborted === true && cause === signal.reason)
      return err(snapshotCancelled(signal));
    if (cause instanceof RegularFileRetainedCleanupFailure)
      return err(snapshotCleanupFailure(cause, signal));
    // Without a retaining scope this failure is the descriptor's only owner.
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    return err(snapshotReadFailure(cause, signal));
  }
};

const snapshotCancelled = (signal: AbortSignal): AnalysisCancelledError =>
  new AnalysisCancelledError(READ_OPERATION, { cause: signal.reason });

const snapshotReadFailure = (
  cause: unknown,
  signal: AbortSignal | undefined,
): EvidenceIntegrityError | AnalysisCancelledError =>
  signal?.aborted === true
    ? snapshotCancelled(signal)
    : new EvidenceIntegrityError(snapshotValidationMessage(cause), { cause });

/**
 * Report a snapshot descriptor that the caller's scope still retains after its
 * close retry failed. The error stays bound to that exact lease, so its
 * resources clear only when the scope later releases the descriptor.
 */
const snapshotCleanupFailure = (
  failure: RegularFileRetainedCleanupFailure<
    Result<
      AnalysisSnapshot,
      | AnalysisInputError
      | AnalysisResourceConstraintError
      | EvidenceIntegrityError
    >
  >,
  signal: AbortSignal | undefined,
): AnalysisError => {
  const cleanup = new ProviderCleanupError(
    "rea",
    failure.cleanup.resources,
    { reason: failure.cleanup.reason },
    {
      cause: failure,
      operation: READ_OPERATION,
      remediationAction:
        "The snapshot file handle is still retained. Call close_binary to retry cleanup before opening another target.",
    },
  );
  const primary = jsonFileCleanupPrimary(failure, READ_OPERATION, signal);
  const error =
    primary === undefined
      ? cleanup
      : analysisErrorWithCleanupFailure(primary, cleanup, READ_OPERATION);
  new AnalysisCleanupLeaseGroup(error, [failure.cleanupLease]);
  return error;
};

const snapshotEntryReader = (kind: "provider" | "workflow") => {
  let seen = false;
  let entries: PreparedSnapshotEntry[] = [];
  let failure: { readonly cause: unknown } | undefined;
  const reader: JsonObjectMemberReader = {
    mode: "array",
    begin: () => {
      seen = true;
      entries = [];
      failure = undefined;
    },
    accept: (value) => {
      if (failure === undefined)
        entries.push(prepareSnapshotEntry(value, kind));
    },
    reject: (cause) => {
      failure ??= { cause };
    },
  };
  return {
    reader,
    finish: (): PreparedSnapshotEntry[] => {
      if (!seen)
        throw new TypeError(
          `Analysis snapshot ${kind === "provider" ? "entries" : "workflow_entries"} is missing`,
        );
      if (failure !== undefined) throw failure.cause;
      return entries;
    },
  };
};

/** Atomically write a deterministic analysis snapshot to the caller's path. */
export const writeAnalysisSnapshot = async (
  snapshot: AnalysisSnapshot,
  path: string,
  overwrite: boolean,
  resources: ArtifactResourceScope,
): Promise<
  Result<{ readonly path: string; readonly bytes: number }, SnapshotFailure>
> => {
  let encoded: string;
  try {
    encoded = serializeAnalysisSnapshot(snapshot);
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError(snapshotValidationMessage(cause), { cause }),
    );
  }
  return writeTextFile(encoded, path, overwrite, resources);
};

const snapshotValidationMessage = (cause: unknown): string =>
  cause instanceof TypeError
    ? cause.message
    : "Analysis snapshot validation failed";
