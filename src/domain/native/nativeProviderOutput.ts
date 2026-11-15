import { z } from "zod";
import { err, type Result } from "../result.js";
import { AnalysisOutputError } from "../analysisErrorCore.js";
import type { JsonValue } from "../jsonValue.js";

/** Issues kept per refusal; the count still reports every issue. */
const MAX_CONTRACT_ISSUES = 16;

const jsonKind = (value: unknown): string =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : value === undefined
        ? "missing"
        : typeof value;

const valueAt = (value: unknown, path: readonly PropertyKey[]): unknown => {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    if (typeof key === "symbol") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
};

/**
 * Name the fields a provider reply failed its contract on. Each issue carries
 * only its field path, Zod issue code, the expected kind and the observed JSON
 * kind, never reported text, so the diagnostic is safe to return to callers.
 */
export const outputContractDiagnostics = (
  cause: z.ZodError,
  value?: unknown,
): Readonly<Record<string, JsonValue>> => ({
  contract_issue_count: cause.issues.length,
  contract_issues: cause.issues.slice(0, MAX_CONTRACT_ISSUES).map((issue) => ({
    path: issue.path.map((key) =>
      typeof key === "number" ? key : String(key),
    ),
    code: issue.code,
    ...(issue.code === "invalid_type"
      ? {
          expected: issue.expected,
          ...(value === undefined
            ? {}
            : { received: jsonKind(valueAt(value, issue.path)) }),
        }
      : {}),
  })),
});

export const invalidNativeOutput = <T>(
  operation: string,
  expected: string,
  cause: z.ZodError,
): Result<T, AnalysisOutputError> =>
  err(
    new AnalysisOutputError(
      operation,
      `Provider returned an invalid ${expected}`,
      { cause, diagnostics: outputContractDiagnostics(cause) },
    ),
  );
