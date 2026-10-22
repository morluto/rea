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
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { readJsonObjectMembersFile, writeTextFile } from "../JsonFiles.js";
import { RegularFileRetainedCleanupFailure } from "../RegularFileRead.js";
import { RegularFileCleanupFailure } from "../../filesystem/OwnedRegularFile.js";
import type { JsonObjectMemberReader } from "../JsonInputFile.js";
import { AnalysisCleanupLeaseGroup } from "../../artifacts/AnalysisCleanupLease.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";

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
      signal,
      resources,
    );
    if (!loaded.ok) return loaded;
    signal?.throwIfAborted();
    const snapshot = parsePreparedAnalysisSnapshot(
      header,
      entries.finish(),
      workflows.finish(),
    );
    // Deliver queued cancellation before handing a complete cache to the session.
    await setImmediate();
    signal?.throwIfAborted();
    return ok(snapshot);
  } catch (cause: unknown) {
    if (cause instanceof RegularFileRetainedCleanupFailure)
      return err(snapshotCleanupFailure(cause, signal));
    // Without a retaining scope this failure is the descriptor's only owner.
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    return err(snapshotReadFailure(cause, signal));
  }
};

const snapshotReadFailure = (
  cause: unknown,
  signal: AbortSignal | undefined,
): EvidenceIntegrityError | AnalysisCancelledError =>
  signal?.aborted === true
    ? new AnalysisCancelledError("read_evidence_file", { cause })
    : new EvidenceIntegrityError(snapshotValidationMessage(cause), { cause });

/**
 * Report a snapshot descriptor that the caller's scope still retains after its
 * close retry failed. The error stays bound to that exact lease, so its
 * resources clear only when the scope later releases the descriptor.
 */
const snapshotCleanupFailure = (
  failure: RegularFileRetainedCleanupFailure,
  signal: AbortSignal | undefined,
): AnalysisError => {
  const cleanup = new ProviderCleanupError(
    "rea",
    failure.cleanup.resources,
    { reason: failure.cleanup.reason },
    {
      cause: failure,
      operation: "read_evidence_file",
      remediationAction:
        "The snapshot file handle is still retained and its close is retried when the REA server releases its resources. Restart the REA server to release it before reusing the snapshot.",
    },
  );
  const error =
    failure.outcome.kind === "failed"
      ? analysisErrorWithCleanupFailure(
          snapshotReadFailure(failure.outcome.cause, signal),
          cleanup,
          "read_evidence_file",
        )
      : cleanup;
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
