import { isAbsolute } from "node:path";
import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import {
  projectStableArtifactFailure,
  stableArtifactInputRecovery,
} from "../../artifacts/StableArtifactFailure.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  EVTX_ARCHIVE_OPERATION as operation,
  EVTX_ARCHIVE_PROVIDER,
  type EvtxArchive,
  type EvtxArchiveArtifact,
} from "../../domain/evtxArchive/evtxArchive.js";
import {
  inspectEvtxArchiveInputSchema,
  type InspectEvtxArchiveInput,
} from "../../domain/evtxArchive/evtxArchiveQuery.js";
import { parseEvtxArchive } from "../../domain/evtxArchive/parseEvtxArchive.js";
import { err, ok, type Result } from "../../domain/result.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const inputFailure = (message: string, cause?: unknown) =>
  new AnalysisInputError(
    operation,
    {
      cause,
      ...(cause instanceof ArtifactReaderFailure
        ? stableArtifactInputRecovery(cause)
        : {}),
    },
    [{ path: ["path"], reason: "invalid_format", message }],
  );

/** Keep the reader's typed reasons instead of flattening every failure into "io". */
const readFailure = (
  failure: unknown,
  input: InspectEvtxArchiveInput,
): AnalysisError => {
  const { cause, origin } = artifactFilePrimaryFacts(failure);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(operation, {
        cause: artifactFileCancellationCause(cause),
      });
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(
        operation,
        input.path,
        cause.message,
        { cause },
      );
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        operation,
        cause.boundary ?? "file-size",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        {
          cause,
          retryable: false,
          remediationAction:
            "Select a log within max_file_bytes; reply paging does not change this file admission.",
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return inputFailure(cause.message, cause);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(operation, input.path, cause.code, {
        cause,
      });
  }
  return new ArtifactOperationError(
    operation,
    "io",
    undefined,
    "Event log read failed.",
    { cause: failure },
  );
};

const readArchive = async (
  input: InspectEvtxArchiveInput,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<{ bytes: Buffer; sha256: string }, AnalysisError>> => {
  try {
    const source = await resources.run(() =>
      readStableArtifact(
        input.path,
        input.max_file_bytes,
        signal,
        undefined,
        resources,
      ),
    );
    return ok(source);
  } catch (failure: unknown) {
    return err(
      projectStableArtifactFailure(
        failure,
        readFailure(failure, input),
        input.path,
        EVTX_ARCHIVE_PROVIDER.id,
        operation,
      ),
    );
  }
};

export interface EvtxArchiveInspection {
  readonly evidence: Evidence;
  /** The verified file snapshot, retained when cancellation follows the read. */
  readonly observation: EvtxArchive["artifact"];
}

/** Shared CLI/MCP import: one verified file read, no network, no replay, no execution. */
export const inspectEvtxArchiveEvidence = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Result<EvtxArchiveInspection, AnalysisError>> => {
  const admitted = parseAnalysisInput(
    operation,
    rawInput,
    inspectEvtxArchiveInputSchema,
    options.signal,
  );
  if (!admitted.ok) return admitted;
  const input = admitted.value;
  if (!isAbsolute(input.path))
    return err(
      inputFailure("Expected an absolute filesystem path on this host."),
    );
  const source = await readArchive(input, resources, options.signal);
  if (!source.ok) return source;
  const { bytes, sha256 } = source.value;
  const artifact: EvtxArchiveArtifact = {
    path: input.path,
    sha256,
    bytes: bytes.length,
  };
  const result = parseEvtxArchive(bytes, artifact, {
    maxRecords: input.max_records,
  });
  if (!result.ok) return result;
  const archive = result.value;
  const evidence = createEvidence(
    { path: input.path, format: "file", sha256 },
    EVTX_ARCHIVE_PROVIDER,
    {
      operation,
      predicateType: "rea.evtx-archive-inventory",
      parameters: {
        path: input.path,
        format: input.format,
        max_file_bytes: input.max_file_bytes,
        max_records: input.max_records,
      },
      result: archive,
      confidence: "observed",
      limitations: archive.limitations,
      locations: [{ kind: "artifact-path", path: input.path }],
    },
  );
  const completed = completeProviderEvidence(evidence, options.signal);
  return completed.ok
    ? ok({ evidence: completed.value, observation: artifact })
    : completed;
};
