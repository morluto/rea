import {
  projectStableArtifactFailure,
  readStableArtifact,
  type ArtifactResourceScope,
} from "../../resources/index.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  EVTX_ARCHIVE_MAX_FILE_BYTES,
  EVTX_ARCHIVE_OPERATION as operation,
  EVTX_ARCHIVE_PROVIDER,
  type EvtxArchive,
  type EvtxArchiveArtifact,
} from "../../domain/evtxArchive/evtxArchive.js";
import {
  evtxArchiveBudgetLimit,
  inspectEvtxArchiveInputSchema,
  type InspectEvtxArchiveInput,
} from "../../domain/evtxArchive/evtxArchiveQuery.js";
import { parseEvtxArchive } from "../../domain/evtxArchive/parseEvtxArchive.js";
import type { AnalysisParameterLimit } from "../../domain/analysisSettings.js";
import { err, ok, type Result } from "../../domain/result.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import {
  callerAnalysisParameters,
  parseAnalysisInput,
} from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

/**
 * The `max_file_bytes` control that refused the read, carrying the size the
 * caller would have needed so recovery can name a sufficient value.
 */
const fileSizeBudgetLimit = (
  input: InspectEvtxArchiveInput,
  observedBytes: bigint | undefined,
): AnalysisParameterLimit => ({
  ...evtxArchiveBudgetLimit("max_file_bytes", input.max_file_bytes),
  ...(observedBytes === undefined ||
  observedBytes > BigInt(Number.MAX_SAFE_INTEGER)
    ? {}
    : { required_value: Number(observedBytes) }),
});

const fileSizeRecovery = (
  input: InspectEvtxArchiveInput,
  observedBytes: bigint | undefined,
): string => {
  const ceiling = EVTX_ARCHIVE_MAX_FILE_BYTES;
  if (input.max_file_bytes >= ceiling)
    return `max_file_bytes is already at its ${String(ceiling)}-byte ceiling; select a log no larger than that. Reply paging does not change this file admission.`;
  const needed =
    observedBytes === undefined ||
    observedBytes > BigInt(Number.MAX_SAFE_INTEGER)
      ? undefined
      : Number(observedBytes);
  const raise =
    needed !== undefined && needed <= ceiling
      ? `Raise max_file_bytes to at least ${String(needed)} (up to ${String(ceiling)})`
      : `Raise max_file_bytes above ${String(input.max_file_bytes)} (up to ${String(ceiling)})`;
  return `${raise}, or select a smaller log. The change applies on the next call; repeating the unchanged request does not raise it.`;
};

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
      fileSize: (refusal, details) =>
        new AnalysisResourceConstraintError(
          operation,
          "file-size",
          refusal.message,
          {
            max_file_bytes: input.max_file_bytes,
            ...(refusal.observedBytes === undefined ||
            refusal.observedBytes > BigInt(Number.MAX_SAFE_INTEGER)
              ? {}
              : { observed_file_bytes: Number(refusal.observedBytes) }),
          },
          {
            ...details,
            retryable: false,
            limit: fileSizeBudgetLimit(input, refusal.observedBytes),
            remediationAction: fileSizeRecovery(input, refusal.observedBytes),
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
  const callerParameters = callerAnalysisParameters(rawInput);
  const input = admitted.value;
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
      parameters: callerParameters({
        path: input.path,
        format: input.format,
        max_file_bytes: input.max_file_bytes,
        max_records: input.max_records,
      }),
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
