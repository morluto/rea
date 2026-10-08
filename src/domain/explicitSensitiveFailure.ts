import type { AnalysisError } from "./analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisCapabilityUnavailableError,
  AnalysisResourceConstraintError,
} from "./analysisErrorCore.js";
import { redactExplicitText } from "./explicitSensitiveValues.js";
import type { JsonValue } from "./jsonValue.js";
import { ProviderAdapterError } from "./providerAdapterError.js";
import { ProviderCleanupError } from "./providerCleanupError.js";

/** Keep a real JSON-pointer ancestor when a property identity is explicitly excluded. */
export const redactExplicitPointer = (
  pointer: string,
  values: readonly string[],
): string => {
  let parent = "";
  for (const segment of pointer.split("/").slice(1)) {
    const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    const child = `${parent}/${segment}`;
    if (
      values.some(
        (literal) => decoded.includes(literal) || child.includes(literal),
      )
    )
      return parent;
    parent = child;
  }
  return parent;
};

/** Exclude explicit literals from common acquisition/decoder failures, preserving typed diagnostics. */
export const redactExplicitFailure = (
  error: AnalysisError,
  values: readonly string[],
): AnalysisError => {
  if (values.length === 0) return error;
  const text = (value: string): string => redactExplicitText(value, values);
  const path = (
    parts: readonly (string | number)[],
    ordinaryNames: boolean,
  ): (string | number)[] => {
    const retained: (string | number)[] = [];
    for (const part of parts) {
      if (typeof part !== "string") {
        retained.push(part);
      } else if (!ordinaryNames && part.startsWith("/")) {
        const pointer = redactExplicitPointer(part, values);
        retained.push(pointer);
        if (pointer !== part) break;
      } else {
        if (values.some((literal) => part.includes(literal))) break;
        retained.push(part);
      }
    }
    return retained;
  };
  const diagnostics = (
    value: Readonly<Record<string, JsonValue>>,
  ): Record<string, JsonValue> =>
    Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !values.some((literal) => key.includes(literal)))
        .map(([key, item]) => [key, visit(item)]),
    );
  const visit = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(visit);
    if (typeof value === "object" && value !== null) return diagnostics(value);
    return value;
  };
  if (error instanceof AnalysisAccessDeniedError)
    return new AnalysisAccessDeniedError(
      error.operation,
      text(error.path),
      error.systemCode,
      { cause: error },
    );
  if (error instanceof AnalysisArtifactChangedError)
    return new AnalysisArtifactChangedError(
      error.operation,
      text(error.path),
      text(error.reason),
      { cause: error },
    );
  if (error instanceof AnalysisInputError)
    return new AnalysisInputError(
      error.operation,
      { cause: error },
      error.issues.map((issue) => ({
        ...issue,
        // Unknown-argument paths contain literal field names, including names
        // beginning with '/'; they are not producer JSON-pointer coordinates.
        path: path(issue.path, issue.reason === "unknown_argument"),
        ...(issue.message === undefined
          ? {}
          : { message: text(issue.message) }),
        ...(issue.expected === undefined
          ? {}
          : { expected: visit(issue.expected) }),
      })),
    );
  if (error instanceof AnalysisOutputError)
    return new AnalysisOutputError(error.operation, text(error.reason), {
      cause: error,
    });
  if (error instanceof AnalysisCapabilityUnavailableError)
    return new AnalysisCapabilityUnavailableError(
      error.providerId,
      error.operation,
      text(error.reason),
      {
        cause: error,
        ...(error.userMessage === undefined
          ? {}
          : { userMessage: text(error.userMessage) }),
      },
    );
  if (error instanceof AnalysisResourceConstraintError)
    return new AnalysisResourceConstraintError(
      error.operation,
      error.resource,
      text(error.reason),
      error.reportedLimits === null ? null : diagnostics(error.reportedLimits),
      {
        cause: error,
        ...(error.remediationAction === undefined
          ? {}
          : { remediationAction: text(error.remediationAction) }),
        ...(error.capturedOutput === undefined
          ? {}
          : {
              capturedOutput: {
                stdout: text(error.capturedOutput.stdout),
                stderr: text(error.capturedOutput.stderr),
                truncated: error.capturedOutput.truncated,
              },
            }),
      },
    );
  if (error instanceof ProviderCleanupError)
    return new ProviderCleanupError(
      error.providerId,
      error.cleanupResources.map(text),
      diagnostics(error.diagnostics ?? {}),
      { operation: error.operation, cause: error },
    );
  if (error instanceof ProviderAdapterError)
    return new ProviderAdapterError(error.providerId, error.operation, {
      cause: error,
      ...(error.diagnostics === undefined
        ? {}
        : { diagnostics: diagnostics(error.diagnostics) }),
    });
  return error;
};
