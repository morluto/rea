import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import {
  ArtifactResourceScope,
  ArtifactReaderFailure,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  artifactSelectedPathErrno,
  type ArtifactFilePrimaryFacts,
  projectArtifactCloseFailure,
  projectOwnedArtifactIdentityFailure,
  projectStableArtifactFailure,
  stableArtifactInputFailure,
} from "../resources/index.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { V8CodeCachePort } from "../ports/v8CodeCache/V8CodeCachePort.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  MAX_INSPECT_V8_CODE_CACHE_FILE_BYTES,
  MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES,
  MAX_INSPECT_V8_CODE_CACHE_STRINGS,
  type InspectV8CodeCacheInput,
} from "../domain/v8/v8CodeCache.js";
import { err, ok } from "../domain/result.js";
import { V8_CODE_CACHE_FORMAT } from "./V8CodeCache.errors.js";
import { V8_CODE_CACHE_PROVIDER_IDENTITY } from "./V8CodeCacheProviderIdentity.js";
import { parseV8CodeCacheFromHandle } from "./V8CodeCacheParser.js";

const OPERATION = "inspect_v8_code_cache";
const HEADER_PREFIX_BYTES = 65_536;

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
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const result = await withStableArtifactHandle(
          input.path,
          input.max_file_bytes,
          {
            signal: options?.signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (identity) => {
              observed = identity;
            },
          },
          (handle) =>
            parseV8CodeCacheFromHandle(
              {
                size: handle.size,
                prefix: handle.prefix,
                readRange: (offset, length) => handle.readRange(offset, length),
              },
              {
                path: input.path,
                sha256: handle.sha256,
                bytes: handle.size,
              },
              input,
            ),
        );
        return ok(result);
      });
    } catch (cause) {
      return err(v8CodeCacheFailure(cause, input, observed));
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

/** Raising either admitted knob can make an exhausted string count fit. */
const observationBudgetRemediation = (
  limit: number,
  input: InspectV8CodeCacheInput,
): string => {
  const canRaiseMaxStrings =
    input.max_strings < MAX_INSPECT_V8_CODE_CACHE_STRINGS;
  const canRaiseMinStringBytes =
    input.min_string_bytes < MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES;
  if (!canRaiseMaxStrings && !canRaiseMinStringBytes)
    return `Both max_strings and min_string_bytes are already at their ceilings (${String(MAX_INSPECT_V8_CODE_CACHE_STRINGS)} observations, ${String(MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES)}-byte runs), so no option change clears this budget; select a smaller artifact.`;
  if (!canRaiseMaxStrings)
    return `Raise min_string_bytes above ${String(input.min_string_bytes)}; max_strings is already at its ${String(MAX_INSPECT_V8_CODE_CACHE_STRINGS)}-observation ceiling, so a shorter run length cannot help.`;
  if (!canRaiseMinStringBytes)
    return `Raise max_strings above ${String(limit)}; min_string_bytes is already at its ${String(MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES)}-byte ceiling, so a larger artifact must be reduced or split.`;
  return `Raise max_strings above ${String(limit)} or raise min_string_bytes above ${String(input.min_string_bytes)}; both are caller-selected observation budgets.`;
};

const v8CodeCacheFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectV8CodeCacheInput,
) => {
  const { cause, origin } = facts;
  if (
    isParseLimit(cause, V8_CODE_CACHE_FORMAT) &&
    cause.failure.limit.name === "max_strings"
  )
    return parseLimitConstraint(OPERATION, "capacity", cause, {
      retryable: false,
      remediationAction: observationBudgetRemediation(
        cause.failure.limit.maximum,
        input,
      ),
    });
  const formatFailure = parseFailureAnalysisError(OPERATION, input.path, cause);
  if (formatFailure !== undefined) return formatFailure;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
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
      return stableArtifactInputFailure(cause, OPERATION);
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

const v8CodeCacheFailure = (
  cause: unknown,
  input: InspectV8CodeCacheInput,
  observed?: { readonly sha256: string; readonly bytes: number },
) => {
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
    observed,
  );
};
