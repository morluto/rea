import { isAbsolute } from "node:path";
import {
  ArtifactReaderFailure,
  projectStableArtifactFailure,
  readStableArtifact,
  stableArtifactInputRecovery,
  type ArtifactResourceScope,
} from "../../resources/index.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
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
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const inputFailure = (message: string, cause?: unknown) =>
  new AnalysisInputError(
    operation,
    {
      cause,
      ...(isSelectedRegularFileError(cause)
        ? {
            conformsToInputContract: true,
            remediationAction:
              "Check that the selected path exists and is a readable regular file on the host running REA.",
          }
        : {}),
      ...(cause instanceof ArtifactReaderFailure
        ? stableArtifactInputRecovery(cause)
        : {}),
    },
    [{ path: ["path"], reason: "invalid_format", message }],
  );

/**
 * The shared owner classifies the file read's typed reasons; this dialect only
 * names the selected event log and what a cause nothing recognised reports.
 */
const readFailure = (failure: unknown, input: InspectEvtxArchiveInput) =>
  classifyProviderFailure(failure, {
    providerId: EVTX_ARCHIVE_PROVIDER.id,
    operation,
    file: {
      path: input.path,
      description: "event log",
      fileSize: (limit, details) =>
        new AnalysisResourceConstraintError(
          operation,
          "file-size",
          limit.message,
          { max_file_bytes: input.max_file_bytes },
          {
            ...details,
            retryable: false,
            remediationAction:
              "Select a log within max_file_bytes; reply paging does not change this file admission.",
          },
        ),
    },
    unclassified: (unrecognised, details) =>
      new ArtifactOperationError(
        operation,
        "io",
        undefined,
        "Event log read failed.",
        { ...details, cause: unrecognised },
      ),
  });

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
