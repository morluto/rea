import { UNITY_ASSETS_PROVIDER_IDENTITY } from "./UnityAssetsProviderIdentity.js";
import {
  projectStableArtifactFailure,
  projectArtifactCloseFailure,
} from "../artifacts/StableArtifactFailure.js";
import { isSelectedRegularFileError } from "../filesystem/RegularFile.js";
import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  type ArtifactFilePrimaryFacts,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { UnityAssetsPort } from "../application/unity/UnityAssetsPort.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  MAX_INSPECT_UNITY_ASSETS_FILE_BYTES,
  type InspectUnityAssetsInput,
} from "../domain/unity/unityAssets.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok } from "../domain/result.js";
import { UnityAssetsFormatFailure } from "./UnityAssets.errors.js";
import { parseUnitySerializedFile } from "./UnitySerializedFileParser.js";

const OPERATION = "inspect_unity_assets";

const fileSizeRemediation = (input: InspectUnityAssetsInput): string =>
  input.max_file_bytes >= MAX_INSPECT_UNITY_ASSETS_FILE_BYTES
    ? `The file exceeds the ${String(MAX_INSPECT_UNITY_ASSETS_FILE_BYTES)}-byte input ceiling this operation accepts. Select a smaller SerializedFile.`
    : `Raise max_file_bytes (--max-file-bytes) above ${String(input.max_file_bytes)}, up to ${String(MAX_INSPECT_UNITY_ASSETS_FILE_BYTES)}, on the next call.`;

const failureForPrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectUnityAssetsInput,
) => {
  const { cause, origin } = facts;
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      cause.message,
      { cause },
    );
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (cause instanceof UnityAssetsFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(
          OPERATION,
          input.path,
          cause.message,
          { cause },
        )
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected SerializedFile ${input.path}: ${cause.message}`,
          },
        ]);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        {
          cause,
          retryable: false,
          remediationAction: fileSizeRemediation(input),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(OPERATION, { cause }, [
        { path: ["path"], reason: "invalid_format", message: cause.message },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, input.path, cause.code, {
        cause,
      });
    if (isSelectedRegularFileError(cause))
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected SerializedFile could not be read (${String(cause.code)}): ${input.path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(
    UNITY_ASSETS_PROVIDER_IDENTITY.id,
    OPERATION,
    {
      cause,
      diagnostics: {
        path: input.path,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    },
  );
};

/** Portable parser over one bounded, identity-checked regular file. */
export class UnityAssetsProvider implements UnityAssetsPort {
  readonly identity = UNITY_ASSETS_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        UNITY_ASSETS_PROVIDER_IDENTITY.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectUnityAssetsInput, options?: ExecutionOptions) {
    try {
      const snapshot = await this.#resources.run(() =>
        readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        ),
      );
      assertArtifactReadActive(options?.signal);
      return ok(
        parseUnitySerializedFile(snapshot.bytes, {
          path: input.path,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes.length,
        }),
      );
    } catch (cause) {
      return err(
        projectStableArtifactFailure(
          cause,
          failureForPrimary(artifactFilePrimaryFacts(cause), input),
          input.path,
          UNITY_ASSETS_PROVIDER_IDENTITY.id,
          OPERATION,
        ),
      );
    }
  }
}
