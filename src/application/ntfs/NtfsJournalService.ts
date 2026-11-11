import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
} from "../../artifacts/ArtifactFileOperation.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import {
  projectStableArtifactFailure,
  stableArtifactInputRecovery,
} from "../../artifacts/StableArtifactFailure.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
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
import { parseMftImage } from "../../domain/windows/ntfsMft.js";
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
  return inputFailure(
    parameter,
    `Could not read the selected acquisition at ${path}`,
    cause,
  );
};

const readAcquisition = async (
  path: string,
  parameter: PathParameter,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
) => {
  try {
    return ok(
      await resources.run(() =>
        readStableArtifact(
          path,
          NTFS_JOURNAL_FILE_BYTES,
          signal,
          undefined,
          resources,
        ),
      ),
    );
  } catch (cause) {
    return err(
      projectStableArtifactFailure(
        cause,
        readFailure(cause, path, parameter),
        path,
        NTFS_JOURNAL_PROVIDER.id,
        operation,
      ),
    );
  }
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
  const mft = await readAcquisition(
    input.mft_path,
    "mft_path",
    resources,
    signal,
  );
  if (!mft.ok) return mft;
  const parsed = parseMftImage(mft.value.bytes);
  if (!parsed.ok) return err(inputFailure("mft_path", parsed.error.message));

  const journal = await readAcquisition(
    input.journal_path,
    "journal_path",
    resources,
    signal,
  );
  if (!journal.ok) return journal;
  const result = ntfsJournalResultSchema.parse({
    mft: {
      path: input.mft_path,
      bytes: mft.value.bytes.length,
      sha256: mft.value.sha256,
    },
    journal: {
      path: input.journal_path,
      bytes: journal.value.bytes.length,
      sha256: journal.value.sha256,
    },
    ...composeNtfsJournalTimeline(parsed.value, journal.value.bytes, {
      startFileOffset: input.start_file_offset,
      maxRows: input.max_rows,
    }),
  });
  return completeProviderEvidence(
    createEvidence(
      {
        path: input.journal_path,
        format: "file",
        sha256: journal.value.sha256,
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
