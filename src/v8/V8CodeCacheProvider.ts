import {
  isParseLimit,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import {
  ArtifactResourceScope,
  ArtifactReaderFailure,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  closeArtifactResources,
  projectStableArtifactFailure,
} from "../resources/index.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { V8CodeCachePort } from "../ports/v8CodeCache/V8CodeCachePort.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  MAX_INSPECT_V8_CODE_CACHE_FILE_BYTES,
  MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES,
  MAX_INSPECT_V8_CODE_CACHE_STRINGS,
  type InspectV8CodeCacheInput,
  type V8CodeCache,
} from "../domain/v8/v8CodeCache.js";
import { err, ok } from "../domain/result.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../providers/offlineArtifactFailure.js";
import { V8_CODE_CACHE_FORMAT } from "./V8CodeCache.errors.js";
import { V8_CODE_CACHE_PROVIDER_IDENTITY } from "./V8CodeCacheProviderIdentity.js";
import { parseV8CodeCacheFromHandle } from "./V8CodeCacheParser.js";

const OPERATION = "inspect_v8_code_cache";
const HEADER_PREFIX_BYTES = 65_536;

/** Portable parser over one bounded, identity-checked regular file. */
export class V8CodeCacheProvider implements V8CodeCachePort {
  readonly identity = V8_CODE_CACHE_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      V8_CODE_CACHE_PROVIDER_IDENTITY,
      OPERATION,
    );
  }

  async inspect(input: InspectV8CodeCacheInput, options?: ExecutionOptions) {
    let completed: V8CodeCache | undefined;
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const result = await withStableArtifactHandle<V8CodeCache>(
          input.path,
          input.max_file_bytes,
          {
            signal: options?.signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (identity) => {
              observed = identity;
            },
            onVerifiedResult: (report) => {
              completed = report;
            },
          },
          (handle) =>
            parseV8CodeCacheFromHandle(
              handle,
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
      return err(v8CodeCacheFailure(cause, input, observed, completed));
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

const v8CodeCacheFailure = (
  cause: unknown,
  input: InspectV8CodeCacheInput,
  observed: { readonly sha256: string; readonly bytes: number } | undefined,
  completed: V8CodeCache | undefined,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const reportedLimits = {
    max_file_bytes: input.max_file_bytes,
    max_strings: input.max_strings,
  };
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: V8_CODE_CACHE_PROVIDER_IDENTITY.id,
      operation: OPERATION,
      path: input.path,
      description: "V8 code cache",
      fallbackMessage: "V8 code cache inspection failed.",
      recognise: (failure, origin) => {
        if (
          isParseLimit(failure, V8_CODE_CACHE_FORMAT) &&
          failure.failure.limit.name === "max_strings"
        )
          return parseLimitConstraint(OPERATION, "capacity", failure, {
            retryable: false,
            remediationAction: observationBudgetRemediation(
              failure.failure.limit.maximum,
              input,
            ),
          });
        if (
          origin === "owned-or-classified" &&
          failure instanceof ArtifactReaderFailure &&
          failure.reason === "limit"
        ) {
          const remediationAction = inputBudgetRemediation(failure, input);
          return new AnalysisResourceConstraintError(
            OPERATION,
            failure.boundary ?? "memory",
            failure.message,
            reportedLimits,
            {
              cause: failure,
              ...(remediationAction === undefined
                ? {}
                : { retryable: false, remediationAction }),
            },
          );
        }
        return undefined;
      },
    }),
  );
  if (completed !== undefined) primary.retainPartialObservation(completed);
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    V8_CODE_CACHE_PROVIDER_IDENTITY.id,
    OPERATION,
    observed,
  );
};
