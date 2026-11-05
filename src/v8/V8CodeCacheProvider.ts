import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
  artifactSelectedPathErrno,
  type ArtifactFilePrimaryFacts,
} from "../artifacts/ArtifactFileOperation.js";
import {
  projectArtifactCloseFailure,
  projectStableArtifactFailure,
  stableArtifactInputRecovery,
} from "../artifacts/StableArtifactFailure.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { V8CodeCachePort } from "../application/v8CodeCache/V8CodeCachePort.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  MAX_INSPECT_V8_CODE_CACHE_FILE_BYTES,
  type InspectV8CodeCacheInput,
} from "../domain/v8/v8CodeCache.js";
import { err, ok } from "../domain/result.js";
import {
  V8CodeCacheBudgetFailure,
  V8CodeCacheFormatFailure,
} from "./V8CodeCache.errors.js";
import { V8_CODE_CACHE_PROVIDER_IDENTITY } from "./V8CodeCacheProviderIdentity.js";
import { parseV8CodeCache } from "./V8CodeCacheParser.js";

const OPERATION = "inspect_v8_code_cache";

/** Portable parser over one bounded, identity-checked regular file. */
export class V8CodeCacheProvider implements V8CodeCachePort {
  readonly identity = V8_CODE_CACHE_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        V8_CODE_CACHE_PROVIDER_IDENTITY.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectV8CodeCacheInput, options?: ExecutionOptions) {
    try {
      return await this.#resources.run(async () => {
        const snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        return ok(
          parseV8CodeCache(
            snapshot.bytes,
            {
              path: input.path,
              sha256: snapshot.sha256,
              bytes: snapshot.bytes.length,
            },
            input,
          ),
        );
      });
    } catch (cause) {
      return err(v8CodeCacheFailure(cause, input));
    }
  }
}

const inputBudgetRemediation = (
  cause: ArtifactReaderFailure,
  input: InspectV8CodeCacheInput,
): string | undefined => {
  if (cause.boundary === "file-size")
    return input.max_file_bytes >= MAX_INSPECT_V8_CODE_CACHE_FILE_BYTES
      ? `The file exceeds the ${String(MAX_INSPECT_V8_CODE_CACHE_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;
  return undefined;
};

const observationBudgetRemediation = (
  cause: V8CodeCacheBudgetFailure,
): string =>
  cause.boundary === "max_strings"
    ? `Raise max_strings above ${String(cause.limit)} or raise min_string_bytes; the limit is the caller-selected observation budget.`
    : `Lower min_string_bytes below ${String(cause.limit)} or select a smaller artifact.`;

const v8CodeCacheFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectV8CodeCacheInput,
) => {
  const { cause, origin } = facts;
  if (cause instanceof V8CodeCacheBudgetFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "capacity",
      cause.message,
      {
        max_strings: input.max_strings,
        min_string_bytes: input.min_string_bytes,
      },
      {
        cause,
        retryable: false,
        remediationAction: observationBudgetRemediation(cause),
      },
    );
  if (cause instanceof V8CodeCacheFormatFailure)
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
            message: cause.message,
          },
        ]);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      cause.message,
      {
        cause,
      },
    );
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit") {
      const remediationAction = inputBudgetRemediation(cause, input);
      return new AnalysisResourceConstraintError(
        OPERATION,
        cause.boundary ?? "memory",
        cause.message,
        {
          max_file_bytes: input.max_file_bytes,
          max_strings: input.max_strings,
        },
        {
          cause,
          ...(remediationAction === undefined
            ? {}
            : { retryable: false, remediationAction }),
        },
      );
    }
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(
        OPERATION,
        { cause, ...stableArtifactInputRecovery(cause) },
        [
          {
            path: ["path"],
            reason: "invalid_format",
            message: cause.message,
          },
        ],
      );
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, input.path, cause.code, {
        cause,
      });
    const pathErrno = artifactSelectedPathErrno(cause);
    if (pathErrno !== undefined)
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected V8 code cache could not be read (${pathErrno}): ${input.path}.`,
        },
      ]);
  }
  return new ArtifactOperationError(
    OPERATION,
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure
      ? cause.reason
      : "io",
    undefined,
    cause instanceof Error ? cause.message : "V8 code cache inspection failed.",
    { cause },
  );
};

const v8CodeCacheFailure = (cause: unknown, input: InspectV8CodeCacheInput) => {
  const primary = v8CodeCacheFailurePrimary(
    artifactFilePrimaryFacts(cause),
    input,
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    V8_CODE_CACHE_PROVIDER_IDENTITY.id,
    OPERATION,
  );
};
