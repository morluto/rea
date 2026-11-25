import { isAbsolute } from "node:path";
import { constants } from "node:buffer";
import { parse as parseToml } from "smol-toml";
import {
  ArtifactReaderFailure,
  type ArtifactResourceScope,
  artifactReaderTargetFailure,
  projectStableArtifactFailure,
  readStableArtifact,
  stableArtifactInputRecovery,
} from "../../resources/index.js";
import type {
  AnalysisError,
  AnalysisErrorOptions,
} from "../../domain/analysisErrorBase.js";
import type { AnalysisParameterLimit } from "../../domain/analysisSettings.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  fixedCeilingConstraint,
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import { strictUtf8Decoder } from "../../domain/strictUtf8.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import {
  CARGO_MANIFEST_MAX_FILE_BYTES,
  CARGO_MANIFEST_OPERATION as operation,
  CARGO_MANIFEST_PROVIDER,
  type CargoManifest,
  type CargoManifestArtifact,
} from "../../domain/cargoManifest/cargoManifest.js";
import {
  inspectCargoManifestInputSchema,
  type InspectCargoManifestInput,
} from "../../domain/cargoManifest/cargoManifestQuery.js";
import { parseCargoManifest } from "../../domain/cargoManifest/parseCargoManifest.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  callerAnalysisParameters,
  parseAnalysisInput,
} from "../AnalysisInput.js";
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

const UTF8 = strictUtf8Decoder("preserve");

/** smol-toml is a dependency of the client-configuration owner, not of a Cargo workflow. */
const decodeManifest = (
  bytes: Buffer,
  path: string,
): Result<unknown, AnalysisError> => {
  if (bytes.includes(0))
    return err(
      inputFailure(
        "Manifest bytes contain a NUL byte, so the file is not TOML text.",
      ),
    );
  // Equal byte lengths do not prove valid UTF-8: a malformed sequence can decode to
  // one replacement character that re-encodes to the same length. Decode fatally.
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch (cause: unknown) {
    return err(
      inputFailure(`Manifest at ${path} is not valid UTF-8 TOML text.`, cause),
    );
  }
  if (text.length > constants.MAX_STRING_LENGTH)
    return err(
      inputFailure(
        `Manifest at ${path} exceeds the maximum in-memory string length.`,
      ),
    );
  try {
    return ok(parseToml(text));
  } catch (cause: unknown) {
    return err(inputFailure("Manifest is not valid TOML.", cause));
  }
};

/**
 * The caller's `max_file_bytes` control, reported beside the refusal so the
 * recovery names the value that admitted or refused this read.
 */
const inputAllowanceLimit = (maxFileBytes: number): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter: "max_file_bytes",
  effective_value: maxFileBytes,
  unit: "bytes",
  minimum: 1,
  maximum: CARGO_MANIFEST_MAX_FILE_BYTES,
  default_value: CARGO_MANIFEST_MAX_FILE_BYTES,
  applies_at: "next_call",
});

/**
 * A refusal names the value that admitted or refused this read. The 32 MiB
 * release maximum is not a ceiling the caller can raise, so it is only
 * reported when that is the value that refused the file; a smaller
 * `input.max_file_bytes` is the caller's own budget and says how to raise it.
 */
const manifestFileSizeRefusal = (
  maxFileBytes: number,
  cause: ArtifactReaderFailure,
  details: AnalysisErrorOptions,
): AnalysisResourceConstraintError =>
  maxFileBytes >= CARGO_MANIFEST_MAX_FILE_BYTES
    ? fixedCeilingConstraint(
        operation,
        cause.boundary ?? "file-size",
        cause.message,
        fixedAllowanceOptions("The Cargo manifest input allowance", "input", {
          limit: CARGO_MANIFEST_MAX_FILE_BYTES,
          unit: "bytes",
        }).fixedAllowance,
        { ...details, limit: inputAllowanceLimit(maxFileBytes) },
      )
    : parseLimitConstraint(
        operation,
        "file-size",
        decodeLimit(
          "cargo-toml",
          cause.message,
          { name: "max_file_bytes", maximum: maxFileBytes },
          { cause },
        ),
        {
          legacyMaximumKey: "max_file_bytes",
          reportedLimitContext: {
            maximum_file_bytes: CARGO_MANIFEST_MAX_FILE_BYTES,
          },
          retryable: false,
          limit: inputAllowanceLimit(maxFileBytes),
          remediationAction: `Raise max_file_bytes above ${String(maxFileBytes)} bytes, up to the ${String(CARGO_MANIFEST_MAX_FILE_BYTES)}-byte release maximum, or select a smaller manifest.`,
        },
      );

/** What a failure none of the shared classifications recognised reports. */
const manifestReadRefusal = (cause: unknown, path: string) =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "EACCES" || cause.code === "EPERM")
    ? new AnalysisAccessDeniedError(operation, path, cause.code, { cause })
    : new ArtifactOperationError(
        operation,
        "io",
        undefined,
        "Manifest read failed.",
        { cause },
      );

const readManifest = async (
  input: InspectCargoManifestInput,
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
    const primary = classifyProviderFailure(failure, {
      providerId: CARGO_MANIFEST_PROVIDER.id,
      operation,
      recognise: (cause) =>
        cause instanceof ArtifactReaderFailure && cause.reason === "path"
          ? inputFailure(cause.message, cause)
          : artifactReaderTargetFailure(operation, input.path, cause),
      file: {
        path: input.path,
        description: "Cargo manifest",
        fileSize: (cause, details) =>
          manifestFileSizeRefusal(input.max_file_bytes, cause, details),
      },
      unclassified: (cause) => manifestReadRefusal(cause, input.path),
    });
    return err(
      projectStableArtifactFailure(
        failure,
        primary,
        input.path,
        CARGO_MANIFEST_PROVIDER.id,
        operation,
      ),
    );
  }
};

/** Shared CLI/MCP import: one verified file read, no Cargo, network or build execution. */
export interface CargoManifestInspection {
  readonly evidence: Evidence;
  /** Observations completed before a cancellation, retained as partial evidence. */
  readonly observation: CargoManifest["artifact"];
}

export const inspectCargoManifestEvidence = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Result<CargoManifestInspection, AnalysisError>> => {
  const admitted = parseAnalysisInput(
    operation,
    rawInput,
    inspectCargoManifestInputSchema,
    options.signal,
  );
  if (!admitted.ok) return admitted;
  const input = admitted.value;
  const selectedParameters = callerAnalysisParameters(rawInput);
  if (!isAbsolute(input.path))
    return err(
      inputFailure("Expected an absolute filesystem path on this host."),
    );
  const source = await readManifest(input, resources, options.signal);
  if (!source.ok) return source;
  const { bytes, sha256 } = source.value;
  // The verified read is a completed observation; keep it even when the later
  // decode or inventory fails, so a malformed manifest still names its file.
  const retain = <T>(result: Result<T, AnalysisError>) => {
    if (!result.ok)
      result.error.retainPartialObservation({
        kind: "file-snapshot-hash",
        path: input.path,
        sha256,
        bytes: bytes.length,
      });
    return result;
  };
  const document = retain(decodeManifest(bytes, input.path));
  if (!document.ok) return document;
  const artifact: CargoManifestArtifact = {
    path: input.path,
    sha256,
    bytes: bytes.length,
  };
  const parsed = retain(parseCargoManifest(document.value, artifact));
  if (!parsed.ok) return parsed;
  const result = parsed.value;
  const evidence = await completeProviderEvidence(
    createEvidence(
      { path: input.path, format: "file", sha256 },
      CARGO_MANIFEST_PROVIDER,
      {
        operation,
        predicateType: "rea.cargo-manifest-inventory",
        parameters: selectedParameters({
          path: input.path,
          format: input.format,
          max_file_bytes: input.max_file_bytes,
        }),
        result,
        confidence: "observed",
        limitations: result.limitations,
        locations: [{ kind: "artifact-path", path: input.path }],
      },
    ),
    options.signal,
  );
  return evidence.ok
    ? ok({ evidence: evidence.value, observation: artifact })
    : evidence;
};
