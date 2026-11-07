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
  MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES,
  MAX_INSPECT_V8_CODE_CACHE_STRINGS,
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

/**
 * Recovery advice for an exhausted observation budget, depending on remaining headroom.
 *
 * `max_strings` tops out at `MAX_INSPECT_V8_CODE_CACHE_STRINGS` and `min_string_bytes`
 * at 256, so when both are already at their ceiling neither suggested retry is valid —
 * an admitted file can exceed 65536 runs of 256 bytes. That case has to recommend a
 * smaller artifact instead of repeating an input change Node would reject.
 */
export const observationBudgetRemediation = (
  cause: V8CodeCacheBudgetFailure,
  input: InspectV8CodeCacheInput,
): string => {
  if (cause.boundary !== "max_strings")
    return `Lower min_string_bytes below ${String(cause.limit)} or select a smaller artifact.`;
  const canRaiseCount = input.max_strings < MAX_INSPECT_V8_CODE_CACHE_STRINGS;
  const canRaiseRunLength =
    input.min_string_bytes < MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES;
  if (canRaiseCount && canRaiseRunLength)
    return `Raise max_strings above ${String(cause.limit)} or raise min_string_bytes above ${String(input.min_string_bytes)}; both are caller-selected observation budgets.`;
  if (canRaiseCount)
    return `Raise max_strings above ${String(cause.limit)}; min_string_bytes is already at its ${String(MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES)}-byte ceiling, so a larger artifact must be reduced or split.`;
  if (canRaiseRunLength)
    return `Raise min_string_bytes above ${String(input.min_string_bytes)}; max_strings is already at its ${String(MAX_INSPECT_V8_CODE_CACHE_STRINGS)}-observation ceiling, so a shorter run length cannot help.`;
  return `Both max_strings and min_string_bytes are already at their ceilings (${String(MAX_INSPECT_V8_CODE_CACHE_STRINGS)} observations, ${String(MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES)}-byte runs), so no option change clears this budget; select a smaller artifact.`;
};

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
        remediationAction: observationBudgetRemediation(cause, input),
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
