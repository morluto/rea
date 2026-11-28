import { isAbsolute } from "node:path";
import {
  type ArtifactResourceScope,
  artifactFilePrimaryFacts,
  projectStableArtifactFailure,
  readStableArtifact,
} from "../../resources/index.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  fixedCeilingConstraint,
} from "../../domain/analysisErrorCore.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  PERF_DATA_MAX_FILE_BYTES,
  PERF_DATA_OPERATION as operation,
  PERF_DATA_PROVIDER,
  type PerfData,
  type PerfDataArtifact,
} from "../../domain/perfData/perfData.js";
import {
  inspectPerfDataInputSchema,
  type InspectPerfDataInput,
} from "../../domain/perfData/perfDataQuery.js";
import { parsePerfData } from "../../domain/perfData/parsePerfData.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  callerAnalysisParameters,
  parseAnalysisInput,
} from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const inputFailure = (message: string) =>
  new AnalysisInputError(operation, {}, [
    { path: ["path"], reason: "invalid_format", message },
  ]);

const readFailure = (failure: unknown, input: InspectPerfDataInput) => {
  const facts = artifactFilePrimaryFacts(failure);
  return classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: PERF_DATA_PROVIDER.id,
      operation,
      path: input.path,
      description: "perf recording",
      fallbackMessage: "perf recording read failed.",
      fileSize: (cause) =>
        input.max_file_bytes === PERF_DATA_MAX_FILE_BYTES
          ? fixedCeilingConstraint(
              operation,
              "file-size",
              cause.message,
              {
                name: "max_file_bytes",
                limit: PERF_DATA_MAX_FILE_BYTES,
                unit: "bytes",
                kind: "input",
              },
              { cause },
            )
          : parseLimitConstraint(
              operation,
              "file-size",
              decodeLimit(
                "perf-data",
                cause.message,
                { name: "max_file_bytes", maximum: input.max_file_bytes },
                { cause },
              ),
              {
                retryable: false,
                limit: {
                  control_kind: "parameter",
                  parameter: "max_file_bytes",
                  effective_value: input.max_file_bytes,
                  unit: "bytes",
                  minimum: 1,
                  maximum: PERF_DATA_MAX_FILE_BYTES,
                  default_value: PERF_DATA_MAX_FILE_BYTES,
                  applies_at: "next_call",
                },
                remediationAction: `Increase max_file_bytes above ${input.max_file_bytes}, up to ${PERF_DATA_MAX_FILE_BYTES}, and retry with the same file if it fits.`,
              },
            ),
    }),
  );
};

const readRecording = async (
  input: InspectPerfDataInput,
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
        PERF_DATA_PROVIDER.id,
        operation,
      ),
    );
  }
};

export interface PerfDataInspection {
  readonly evidence: Evidence;
  /** The verified file snapshot, retained when cancellation follows the read. */
  readonly observation: PerfData["artifact"];
}

/** Shared CLI/MCP import: one verified file read, no network, no replay, no execution. */
export const inspectPerfDataEvidence = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Result<PerfDataInspection, AnalysisError>> => {
  const admitted = parseAnalysisInput(
    operation,
    rawInput,
    inspectPerfDataInputSchema,
    options.signal,
  );
  if (!admitted.ok) return admitted;
  const input = admitted.value;
  if (!isAbsolute(input.path))
    return err(
      inputFailure("Expected an absolute filesystem path on this host."),
    );
  const source = await readRecording(input, resources, options.signal);
  if (!source.ok) return source;
  const { bytes, sha256 } = source.value;
  const artifact: PerfDataArtifact = {
    path: input.path,
    sha256,
    bytes: bytes.length,
  };
  const result = parsePerfData(bytes, artifact, {
    maxEvents: input.max_events,
    maxIdentifiers: input.max_identifiers,
  });
  if (!result.ok) return result;
  const recording = result.value;
  const evidence = createEvidence(
    { path: input.path, format: "file", sha256 },
    PERF_DATA_PROVIDER,
    {
      operation,
      predicateType: "rea.perf-data-inventory",
      parameters: callerAnalysisParameters(rawInput)({
        path: input.path,
        max_file_bytes: input.max_file_bytes,
        max_events: input.max_events,
        max_identifiers: input.max_identifiers,
      }),
      result: recording,
      confidence: "observed",
      limitations: recording.limitations,
      locations: [{ kind: "artifact-path", path: input.path }],
    },
  );
  const completed = completeProviderEvidence(evidence, options.signal);
  return completed.ok
    ? ok({ evidence: completed.value, observation: artifact })
    : completed;
};
