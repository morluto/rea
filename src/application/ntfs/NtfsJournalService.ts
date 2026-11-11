import type { BigIntStats } from "node:fs";
import {
  ntfsJournalCacheFor,
  type NtfsJournalCache,
  type NtfsAcquisition,
} from "./NtfsJournalCache.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
} from "../../artifacts/ArtifactFileOperation.js";
import {
  readStableArtifact,
  assertStableArtifactState,
} from "../../artifacts/readStableArtifact.js";
import {
  projectStableArtifactFailure,
  stableArtifactInputRecovery,
} from "../../artifacts/StableArtifactFailure.js";
import {
  primaryAnalysisError,
  type AnalysisError,
} from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  NTFS_JOURNAL_FILE_BYTES,
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
  cause?: unknown,
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

const readFailure = (
  failure: unknown,
  path: string,
  parameter: PathParameter,
): AnalysisError => {
  const { cause } = artifactFilePrimaryFacts(failure);
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(operation, {
        cause: artifactFileCancellationCause(cause),
      });
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(operation, path, cause.message, {
        cause,
      });
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        operation,
        "file-size",
        cause.message,
        {
          maximum_file_bytes: NTFS_JOURNAL_FILE_BYTES,
        },
        { cause, retryable: false },
      );
  }
  if (
    cause instanceof ArtifactReaderFailure &&
    (cause.reason === "path" || cause.reason === "format")
  )
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
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
  cached?: NtfsAcquisition,
): Promise<Result<NtfsAcquisition, AnalysisError>> => {
  try {
    if (cached !== undefined) {
      await assertStableArtifactState(path, cached.state, signal);
      return ok(cached);
    }
    let state: BigIntStats | undefined;
    const snapshot = await readStableArtifact(
      path,
      NTFS_JOURNAL_FILE_BYTES,
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
        readFailure(cause, path, parameter),
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
        { retryable: true },
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
        readFailure(cause, input.mft_path, "mft_path"),
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
  const retained = cache.select(input.mft_path, input.journal_path);
  const mft = await readAcquisition(
    input.mft_path,
    "mft_path",
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
