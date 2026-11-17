import { decodeLimit, ParseFailureError } from "../domain/parseFailure.js";
import type { V8CodeCacheInputBudget } from "../domain/v8/v8CodeCacheBudget.js";

/** The ParseFailure format of V8 code cache containers. */
export const V8_CODE_CACHE_FORMAT = "v8-code-cache";

export type V8CodeCacheBudgetBoundary = keyof V8CodeCacheInputBudget;

export interface V8CodeCacheBudgetLimit {
  readonly boundary: V8CodeCacheBudgetBoundary;
  readonly limit: number;
  readonly message: string;
}

const V8_CODE_CACHE_BUDGET_BOUNDARIES = new Set<V8CodeCacheBudgetBoundary>([
  "max_strings",
  "min_string_bytes",
]);

/** A caller-selected budget was exceeded while scanning the payload. */
export const v8CodeCacheBudgetFailure = (
  boundary: V8CodeCacheBudgetBoundary,
  limit: number,
  message: string,
): ParseFailureError<"limit"> =>
  decodeLimit(V8_CODE_CACHE_FORMAT, message, {
    name: boundary,
    maximum: limit,
  });

export const v8CodeCacheBudgetLimitOf = (
  cause: unknown,
): V8CodeCacheBudgetLimit | undefined =>
  cause instanceof ParseFailureError &&
  cause.failure.kind === "limit" &&
  cause.failure.format === V8_CODE_CACHE_FORMAT &&
  V8_CODE_CACHE_BUDGET_BOUNDARIES.has(
    cause.failure.limit.name as V8CodeCacheBudgetBoundary,
  )
    ? {
        boundary: cause.failure.limit.name as V8CodeCacheBudgetBoundary,
        limit: cause.failure.limit.maximum,
        message: cause.failure.detail,
      }
    : undefined;
