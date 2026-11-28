import {
  artifactFileCancellationError,
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
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  API_CONTRACT_OPERATION as operation,
  API_CONTRACT_PROVIDER,
} from "../../domain/apiContract/apiContract.js";
import { apiContractFileBytesLimit } from "../../domain/apiContract/apiContractQuery.js";
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
      return artifactFileCancellationError(operation, cause);
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
          ...(cause.boundary === undefined || cause.boundary === "file-size"
            ? {
                limit: apiContractFileBytesLimit(
                  input.max_file_bytes,
                  cause.observedBytes !== undefined &&
                    cause.observedBytes <= BigInt(Number.MAX_SAFE_INTEGER)
                    ? Number(cause.observedBytes)
                    : undefined,
                ),
              }
            : {
                measuredExhaustion: true,
                remediationAction:
                  "Reduce the API contract document size or inspect a smaller file before retrying.",
              }),
        },
      );
    if (cause.reason === "path")
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
