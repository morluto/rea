import { isHostLimitFailure } from "../../domain/parseFailure.js";
import type { BigIntStats } from "node:fs";
import {
  ntfsJournalCacheFor,
  type NtfsJournalCache,
  type NtfsAcquisition,
} from "./NtfsJournalCache.js";
import {
  ArtifactReaderFailure,
  type ArtifactResourceScope,
  artifactFileCancellationError,
  artifactFilePrimaryFacts,
  readStableArtifact,
  assertStableArtifactState,
  projectStableArtifactFailure,
  stableArtifactInputRecovery,
  readerIntegrityFailure,
} from "../../resources/index.js";
import {
  primaryAnalysisError,
  type AnalysisError,
} from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisTargetFailureError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  NTFS_JOURNAL_FILE_BYTES,
  ntfsJournalFileBytesLimit,
  NTFS_JOURNAL_OPERATION as operation,
  NTFS_JOURNAL_PROVIDER,
  ntfsJournalInputSchema,
  ntfsJournalResultSchema,
} from "../../domain/windows/ntfsJournalQuery.js";
import { composeNtfsJournalTimeline } from "../../domain/windows/ntfsJournalTimeline.js";
import {
  parseMftIndex,
  selectMftMetadata,
  type MftIndex,
  type MftMetadata,
} from "../../domain/windows/ntfsMft.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

type PathParameter = "mft_path" | "journal_path";
const inputFailure = (
  parameter: PathParameter,
  message: string,
  cause?: Error,
) =>
  new AnalysisInputError(
    operation,
    {
      cause,
      ...(cause instanceof ArtifactReaderFailure
        ? stableArtifactInputRecovery(cause)
        : {}),
    },
    [{ path: [parameter], reason: "invalid_format", message }],
  );

/**
 * An acquisition the call could not hold: above the caller's
 * `max_file_bytes`, or (measured) beyond what the host could allocate.
 */
const acquisitionConstraint = (
  kind: "budget" | "host",
  message: string,
  maxFileBytes: number,
  cause?: Error,
): AnalysisError =>
  new AnalysisResourceConstraintError(
    operation,
    kind === "budget" ? "file-size" : "memory",
    message,
    { maximum_file_bytes: maxFileBytes },
    {
      ...(cause === undefined ? {} : { cause }),
      ...(kind === "host"
        ? {
            measuredExhaustion: true,
            remediationAction:
              "Run on a host with more available memory, or select a smaller acquisition. A larger max_file_bytes does not help.",
          }
        : {
            retryable: false,
            limit: ntfsJournalFileBytesLimit(maxFileBytes),
            remediationAction:
              maxFileBytes < NTFS_JOURNAL_FILE_BYTES.maximum
                ? `Raise max_file_bytes above ${String(maxFileBytes)} bytes on the next call for the same acquisitions; both are read into memory.`
                : "max_file_bytes is at its maximum; select a smaller acquisition.",
          }),
    },
  );

const readFailure = (
  failure: unknown,
  path: string,
  parameter: PathParameter,
  maxFileBytes: number,
): AnalysisError => {
  const { cause } = artifactFilePrimaryFacts(failure);
  // The host could not hold an admitted acquisition in memory; this is
  // measured capacity, not file I/O or the caller's byte budget.
  if (cause instanceof Error && isHostLimitFailure(cause))
    return acquisitionConstraint(
      "host",
      `The host could not hold the ${parameter} acquisition in memory.`,
      maxFileBytes,
      cause,
    );
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "cancelled")
      return artifactFileCancellationError(operation, cause);
    if (cause.reason === "integrity")
      return readerIntegrityFailure(operation, path, cause);
    if (cause.reason === "limit")
      return acquisitionConstraint(
        "budget",
        cause.message,
        maxFileBytes,
        cause,
      );
  }
  if (
    cause instanceof ArtifactReaderFailure &&
    cause.parseFailure !== undefined
  )
    return new AnalysisTargetFailureError(operation, path, cause.parseFailure, {
      cause,
    });
  if (cause instanceof ArtifactReaderFailure && cause.reason === "path")
    return inputFailure(parameter, cause.message, cause);
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(operation, path, cause.code, {
        cause,
      });
    if (isSelectedRegularFileError(cause))
      return inputFailure(
        parameter,
        `Could not read the selected acquisition at ${path}`,
        cause,
      );
  }
  return new ArtifactOperationError(
    operation,
    "io",
    undefined,
    "NTFS acquisition read failed.",
    { cause },
  );
};

const readAcquisition = async (
  path: string,
  parameter: PathParameter,
  maxFileBytes: number,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
  cached?: NtfsAcquisition,
): Promise<Result<NtfsAcquisition, AnalysisError>> => {
  try {
    if (cached !== undefined) {
      // A retained acquisition is admitted again under this call's budget.
      if (cached.snapshot.bytes.length > maxFileBytes)
        return err(
          acquisitionConstraint(
            "budget",
            `The retained ${parameter} acquisition has ${String(cached.snapshot.bytes.length)} bytes, above max_file_bytes (${String(maxFileBytes)}).`,
            maxFileBytes,
          ),
        );
      await assertStableArtifactState(path, cached.state, signal);
      return ok(cached);
    }
    let state: BigIntStats | undefined;
    const snapshot = await readStableArtifact(
      path,
      maxFileBytes,
      signal,
      undefined,
      resources,
      (observed) => {
        state = observed;
      },
    );
    if (state === undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        "NTFS acquisition source state was not retained",
      );
    return ok({ path, snapshot, state });
  } catch (cause) {
    return err(
      projectStableArtifactFailure(
        cause,
        readFailure(cause, path, parameter, maxFileBytes),
        path,
        NTFS_JOURNAL_PROVIDER.id,
        operation,
        cached?.snapshot,
      ),
    );
  }
};
type NtfsInput = ReturnType<typeof ntfsJournalInputSchema.parse>;

const retainCompletedMft = (
  input: NtfsInput,
  mft: NtfsAcquisition,
  image: MftIndex,
  failure: AnalysisError,
  metadata: MftMetadata,
) => {
  const prior =
    failure.partialObservation ??
    primaryAnalysisError(failure).partialObservation;
  const observation = createEvidence(
    { path: input.mft_path, format: "ntfs-mft", sha256: mft.snapshot.sha256 },
    NTFS_JOURNAL_PROVIDER,
    {
      operation,
      predicateType: "rea.ntfs-journal-partial",
      parameters: input,
      result: {
        kind: "ntfs-journal-partial",
        mft: {
          path: input.mft_path,
          sha256: mft.snapshot.sha256,
          bytes: mft.snapshot.bytes.length,
          metadata,
        },
        journal_observation: prior ?? null,
      },
      confidence: "derived",
      limitations: [
        ...image.limitations,
        "Journal acquisition did not complete.",
      ],
      locations: [{ kind: "artifact-path", path: input.mft_path }],
    },
  );
  let current: AnalysisError | undefined = failure;
  while (current !== undefined) {
    if (
      current.partialObservation === prior ||
      current.partialObservation === undefined
    )
      current.partialObservation = observation;
    current = current.cleanupPrimary;
  }
  return err(failure);
};

export const inspectNtfsJournalEvidence = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<Evidence, AnalysisError>> => {
  const admitted = parseAnalysisInput(
    operation,
    rawInput,
    ntfsJournalInputSchema,
    signal,
  );
  if (!admitted.ok) return admitted;
  const input = admitted.value;
  const cache = ntfsJournalCacheFor(resources);
  if (!cache.begin())
    return err(
      new AnalysisResourceConstraintError(
        operation,
        "capacity",
        "One NTFS inspection is already active in this scope; retry after it completes.",
        { maximum_concurrent_inspections: 1 },
        { retryable: true, measuredExhaustion: true },
      ),
    );
  try {
    return await resources.run(() =>
      inspectAdmittedJournal(input, resources, cache, signal),
    );
  } catch (cause) {
    return err(
      projectStableArtifactFailure(
        cause,
        readFailure(
          cause,
          input.mft_path,
          "mft_path",
          input.max_file_bytes ?? NTFS_JOURNAL_FILE_BYTES.default_value,
        ),
        input.mft_path,
        NTFS_JOURNAL_PROVIDER.id,
        operation,
      ),
    );
  } finally {
    cache.end();
  }
};

const inspectAdmittedJournal = async (
  input: NtfsInput,
  resources: ArtifactResourceScope,
  cache: NtfsJournalCache,
  signal?: AbortSignal,
): Promise<Result<Evidence, AnalysisError>> => {
  // Evidence records the caller's input; execution uses the resolved budget.
  const maxFileBytes =
    input.max_file_bytes ?? NTFS_JOURNAL_FILE_BYTES.default_value;
  const retained = cache.select(input.mft_path, input.journal_path);
  const mft = await readAcquisition(
    input.mft_path,
    "mft_path",
    maxFileBytes,
    resources,
    signal,
    retained?.mft,
  );
  if (!mft.ok) {
    if (!(mft.error instanceof AnalysisCancelledError)) cache.clear();
    return mft;
  }
  const parsed =
    retained === undefined
      ? parseMftIndex(mft.value.snapshot.bytes, 0, 0)
      : ok(retained.image);
  if (!parsed.ok)
    return err(
      inputFailure("mft_path", parsed.error.message).retainPartialObservation({
        kind: "file-snapshot-hash",
        path: input.mft_path,
        sha256: mft.value.snapshot.sha256,
        bytes: mft.value.snapshot.bytes.length,
      }),
    );

  const mftMetadata = selectMftMetadata(
    mft.value.snapshot.bytes,
    parsed.value,
    input.mft_record_start,
    input.mft_record_limit,
  );
  const journal = await readAcquisition(
    input.journal_path,
    "journal_path",
    maxFileBytes,
    resources,
    signal,
    retained?.journal,
  );
  if (!journal.ok) {
    if (!(journal.error instanceof AnalysisCancelledError)) cache.clear();
    return retainCompletedMft(
      input,
      mft.value,
      parsed.value,
      journal.error,
      mftMetadata,
    );
  }
  const prepared =
    retained ?? cache.retain(mft.value, journal.value, parsed.value);
  const result = ntfsJournalResultSchema.parse({
    mftMetadata,
    mft: {
      path: input.mft_path,
      bytes: mft.value.snapshot.bytes.length,
      sha256: mft.value.snapshot.sha256,
    },
    journal: {
      path: input.journal_path,
      bytes: journal.value.snapshot.bytes.length,
      sha256: journal.value.snapshot.sha256,
    },
    ...composeNtfsJournalTimeline(
      prepared.image,
      journal.value.snapshot.bytes,
      {
        startFileOffset: input.start_file_offset,
        maxRows: input.max_rows,
      },
      prepared.correlate,
    ),
  });
  return completeProviderEvidence(
    createEvidence(
      {
        path: input.journal_path,
        format: "file",
        sha256: journal.value.snapshot.sha256,
      },
      NTFS_JOURNAL_PROVIDER,
      {
        operation,
        predicateType: "rea.ntfs-journal",
        parameters: input,
        result,
        confidence: "derived",
        limitations: [
          ...result.mftLimitations,
          "Journal bytes alone do not establish the acquisition's historical completeness.",
        ],
        locations: [
          { kind: "artifact-path", path: input.mft_path },
          { kind: "artifact-path", path: input.journal_path },
        ],
      },
    ),
    signal,
  );
};
