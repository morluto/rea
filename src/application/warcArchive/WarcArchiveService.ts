import { isAbsolute } from "node:path";
import {
  artifactFilePrimaryFacts,
  type ArtifactResourceScope,
  ArtifactReaderFailure,
  projectStableArtifactFailure,
  readStableArtifact,
  stableArtifactInputRecovery,
} from "../../resources/index.js";
import type {
  AnalysisError,
  AnalysisErrorOptions,
} from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  fixedCeilingConstraint,
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../../providers/classifyProviderFailure.js";
import {
  WARC_ARCHIVE_MAX_FILE_BYTES,
  WARC_ARCHIVE_OPERATION as operation,
  WARC_ARCHIVE_PROVIDER,
  type WarcArchive,
  type WarcArchiveArtifact,
} from "../../domain/warcArchive/warcArchive.js";
import {
  inspectWarcArchiveInputSchema,
  type InspectWarcArchiveInput,
} from "../../domain/warcArchive/warcArchiveQuery.js";
import { parseWarcArchive } from "../../domain/warcArchive/parseWarcArchive.js";
import {
  callerAnalysisParameters,
  parseAnalysisInput,
} from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const inputFailure = (
  message: string,
  cause?: unknown,
  details: AnalysisErrorOptions = {},
) =>
  new AnalysisInputError(
    operation,
    {
      ...details,
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

/** Keep the reader's typed reasons instead of flattening every failure into "io". */
const warcFailureDialect = (
  input: InspectWarcArchiveInput,
): ProviderFailureDialect => ({
  providerId: WARC_ARCHIVE_PROVIDER.id,
  operation,
  file: {
    path: input.path,
    description: "WARC archive",
    field: "path",
    // `max_file_bytes` is the caller's budget, not a release ceiling: a value
    // below WARC_ARCHIVE_MAX_FILE_BYTES can be raised on the next call, so the
    // refusal advises that raise instead of claiming the release has no
    // override.
    fileSize: (cause, details) =>
      cause.boundary === "file-size"
        ? new AnalysisResourceConstraintError(
            operation,
            "file-size",
            cause.message,
            { max_file_bytes: input.max_file_bytes },
            {
              ...details,
              retryable: false,
              remediationAction: fileByteBudgetRemediation(
                input.max_file_bytes,
              ),
            },
          )
        : fixedCeilingConstraint(
            operation,
            cause.boundary ?? "capacity",
            cause.message,
            cause.fixedAllowance ?? {
              name: `The WARC ${cause.boundary ?? "capacity"} allowance`,
              kind: "parser",
            },
            details,
          ),
  },
  // A path that does not resolve to a readable regular file is the caller's
  // input, not an IO failure; the shared file projection would report it as an
  // invalid value without the retry that names the host running REA. A byte
  // fault is the target's and keeps the reader's own classification.
  recognise: (cause, details) => {
    const physical = artifactFilePrimaryFacts(cause).cause;
    if (physical instanceof ArtifactReaderFailure && physical.reason === "path")
      return inputFailure(physical.message, physical, details);
    if (isSelectedRegularFileError(physical))
      return inputFailure(
        `Selected archive could not be read (${String((physical as NodeJS.ErrnoException).code)}): ${input.path}.`,
        physical,
        details,
      );
    return undefined;
  },
  unclassified: (cause, details) =>
    new ArtifactOperationError(
      operation,
      "io",
      undefined,
      "Archive read failed.",
      { ...details, cause },
    ),
});

/** Evidence parameters carry only the fields the caller actually selected. */
const withoutOmitted = (
  selected: Partial<InspectWarcArchiveInput>,
): Readonly<Record<string, JsonValue>> => {
  const parameters: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(selected))
    if (value !== undefined) parameters[name] = value as JsonValue;
  return parameters;
};

/**
 * Remediation for the caller-selected `max_file_bytes` budget. At the schema
 * maximum there is no value left to raise, so the advice names that ceiling
 * rather than an impossible raise.
 */
const fileByteBudgetRemediation = (selected: number): string =>
  selected >= WARC_ARCHIVE_MAX_FILE_BYTES
    ? `max_file_bytes is at this operation's maximum of ${String(WARC_ARCHIVE_MAX_FILE_BYTES)} bytes; select an archive within that bound.`
    : `Raise max_file_bytes above ${String(selected)}, up to ${String(WARC_ARCHIVE_MAX_FILE_BYTES)}, or select a smaller archive. The budget applies on the next call; repeating the unchanged request does not raise it.`;

const readArchive = async (
  input: InspectWarcArchiveInput,
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
        classifyProviderFailure(failure, warcFailureDialect(input)),
        input.path,
        WARC_ARCHIVE_PROVIDER.id,
        operation,
      ),
    );
  }
};

export interface WarcArchiveInspection {
  readonly evidence: Evidence;
  /** The verified file snapshot, retained when cancellation follows the read. */
  readonly observation: WarcArchive["artifact"];
}

/** Shared CLI/MCP import: one verified file read, no network, no replay, no execution. */
export const inspectWarcArchiveEvidence = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Result<WarcArchiveInspection, AnalysisError>> => {
  const admitted = parseAnalysisInput(
    operation,
    rawInput,
    inspectWarcArchiveInputSchema,
    options.signal,
  );
  if (!admitted.ok) return admitted;
  const input = admitted.value;
  // Evidence keeps what the caller selected; a default resolved for execution
  // is not a caller choice and must not read as one in a saved record.
  const selected = callerAnalysisParameters(rawInput)(input);
  if (!isAbsolute(input.path))
    return err(
      inputFailure("Expected an absolute filesystem path on this host."),
    );
  const source = await readArchive(input, resources, options.signal);
  if (!source.ok) return source;
  const { bytes, sha256 } = source.value;
  const artifact: WarcArchiveArtifact = {
    path: input.path,
    sha256,
    bytes: bytes.length,
  };
  const result = parseWarcArchive(bytes, artifact, {
    maxRecords: input.max_records,
    maxDecodedBytes: input.max_decoded_bytes,
  });
  if (!result.ok) return result;
  const archive = result.value;
  const evidence = createEvidence(
    { path: input.path, format: "file", sha256 },
    WARC_ARCHIVE_PROVIDER,
    {
      operation,
      predicateType: "rea.warc-archive-inventory",
      parameters: withoutOmitted(selected),
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
