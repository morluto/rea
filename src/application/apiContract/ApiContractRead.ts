import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
  ArtifactReaderFailure,
  type ArtifactResourceScope,
  readStableArtifact,
  projectStableArtifactFailure,
  stableArtifactInputRecovery,
  readerIntegrityFailure,
} from "../../resources/index.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  cancelledBy,
  carriedReason,
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  API_CONTRACT_OPERATION as operation,
  API_CONTRACT_PROVIDER,
} from "../../domain/apiContract/apiContract.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import { err, ok } from "../../domain/result.js";

interface ContractDocumentInput {
  readonly path: string;
  readonly max_file_bytes: number;
  readonly parameter?: "path" | "operations_path";
}
const inputFailure = (
  path: string,
  cause: unknown,
  message: string,
  parameter = "path",
) =>
  new AnalysisInputError(
    operation,
    {
      cause,
      ...(cause instanceof ArtifactReaderFailure
        ? stableArtifactInputRecovery(cause)
        : {}),
    },
    [
      {
        path: [parameter],
        reason: "invalid_format",
        message: `${message} (${path})`,
      },
    ],
  );

const readFailure = (
  failure: unknown,
  input: ContractDocumentInput,
): AnalysisError => {
  const { cause, origin } = artifactFilePrimaryFacts(failure);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "cancelled")
      return cancelledBy(
        operation,
        carriedReason(artifactFileCancellationCause(cause)),
      );
    if (cause.reason === "integrity")
      return readerIntegrityFailure(operation, input.path, cause);
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
            "Select a complete document within max_file_bytes; increasing reply limits or paging does not change this file admission.",
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return inputFailure(input.path, cause, cause.message, input.parameter);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(operation, input.path, cause.code, {
        cause,
      });
    if (isSelectedRegularFileError(cause))
      return inputFailure(
        input.path,
        cause,
        "Selected API document could not be read",
        input.parameter,
      );
  }
  return new ArtifactOperationError(
    operation,
    "io",
    undefined,
    "API document read failed.",
    { cause },
  );
};

/** The existing owner verifies exactly the bytes whose SHA-256 the inventory cites. */
export const readApiContract = async (
  input: ContractDocumentInput,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
) => {
  try {
    return ok(
      await resources.run(() =>
        readStableArtifact(
          input.path,
          input.max_file_bytes,
          signal,
          undefined,
          resources,
        ),
      ),
    );
  } catch (cause: unknown) {
    return err(
      projectStableArtifactFailure(
        cause,
        readFailure(cause, input),
        input.path,
        API_CONTRACT_PROVIDER.id,
        operation,
      ),
    );
  }
};
