import type {
  AnalysisExecution,
  AnalysisOperation,
  AnalysisOperationPort,
} from "./AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import {
  projectAnalysisError,
  type AnalysisErrorProjection,
} from "../domain/analysisErrorProjection.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { analysisBookmarkSchema } from "../domain/native/nativeInventory.js";
import { parseContainingProcedureResolution } from "../domain/native/nativeObservation.js";
import { nativeAddressCoordinateInputSchema } from "../domain/native/nativeAddress.js";
import { resolveAnalysisDocument } from "./AnalysisDocument.js";
import { err, ok, type Result } from "../domain/result.js";

type Facet =
  | { readonly state: "available"; readonly value: JsonValue }
  | {
      readonly state: "unavailable";
      readonly reason: string;
      readonly remediation: string;
      readonly error?: AnalysisErrorProjection;
    };

/** Recovery for a comment inside an observed containing function. */
export const ADDRESS_CONTEXT_FUNCTION_COMMENT_RECOVERY =
  'If analyze_function and inspect_analysis_view are available and analyze_function uses the same document, analyze result.procedure.value.procedure.address (summary), then page view {kind:"native", facet:"comments"} using normalized_result.parent_evidence_id. Match result.procedure.value.query_address and kind; respect coverage and limitations.';

/** Fallback when an unavailable capability has no narrower recovery. */
export const ADDRESS_CONTEXT_UNAVAILABLE_RECOVERY =
  "Check binary_session for other available operations. This facet remains unknown.";

const parameters = (
  document: string | undefined,
  address?: string,
): Readonly<Record<string, JsonValue>> => ({
  ...(document === undefined ? {} : { document }),
  ...(address === undefined ? {} : { address }),
});

const executionOptions = (
  signal: AbortSignal | undefined,
): { readonly signal?: AbortSignal } =>
  signal === undefined ? {} : { signal };

/** Compose the provider's volatile selection state into one coherent query. */
export const getNavigationContext = async (
  analysis: AnalysisOperationPort,
  input: { readonly document?: string | undefined },
  signal?: AbortSignal,
): Promise<Result<JsonValue, AnalysisError>> => {
  const document =
    input.document ??
    (await analysis.execute("current_document", {}, executionOptions(signal)));
  if (typeof document !== "string" && !document.ok) return document;
  const documentName =
    typeof document === "string" ? document : document.value.result;
  if (typeof documentName !== "string")
    return err(
      new AnalysisOutputError(
        "current_document",
        "expected a document identity string",
      ),
    );
  const documentArgs = parameters(documentName);
  const address = await analysis.execute(
    "current_address",
    documentArgs,
    executionOptions(signal),
  );
  if (!address.ok) return address;
  if (typeof address.value.result !== "string")
    return err(
      new AnalysisOutputError("current_address", "expected an address string"),
    );
  const procedure = await analysis.execute(
    "resolve_containing_procedure",
    parameters(documentName, address.value.result),
    executionOptions(signal),
  );
  if (!procedure.ok) return procedure;
  const resolution = parseContainingProcedureResolution(procedure.value.result);
  if (!resolution.ok) return resolution;
  return ok({
    document: documentName,
    address: address.value.result,
    procedure: resolution.value.found ? resolution.value.procedure.name : null,
  });
};

/** Inspect bounded provider-neutral facets at one explicit reproducible address. */
export const inspectAddressContext = async (
  analysis: AnalysisOperationPort,
  input: { readonly address: string; readonly document?: string | undefined },
  signal?: AbortSignal,
): Promise<Result<JsonValue, AnalysisError>> => {
  const document = await resolveAnalysisDocument(
    analysis,
    input.document,
    signal,
  );
  if (!document.ok) return document;
  const args = parameters(document.value, input.address);
  const operations = [
    "address_name",
    "resolve_containing_procedure",
    "comment",
    "inline_comment",
    "list_bookmarks",
  ] as const satisfies readonly AnalysisOperation[];
  const completed: Result<AnalysisExecution, AnalysisError>[] = [];
  if (signal?.aborted === true)
    return err(
      new AnalysisCancelledError("inspect_address_context", {
        cause: signal.reason,
      }),
    );
  let signalCancellation: AnalysisCancelledError | undefined;
  const cancelled = () => {
    signalCancellation = new AnalysisCancelledError("inspect_address_context", {
      cause: signal?.reason,
    });
    completed.push(err(signalCancellation));
  };
  signal?.addEventListener("abort", cancelled, { once: true });
  let results: Result<AnalysisExecution, AnalysisError>[];
  try {
    results = await Promise.all(
      operations.map(async (operation) => {
        const result = await analysis.execute(
          operation,
          operation === "list_bookmarks" ? parameters(document.value) : args,
          executionOptions(signal),
        );
        completed.push(result);
        return result;
      }),
    );
  } finally {
    signal?.removeEventListener("abort", cancelled);
  }
  const fatal = contextFailure(completed, signalCancellation);
  if (fatal !== undefined) return err(fatal);
  const name = facet(results[0], operations[0]);
  const procedureResult = results[1];
  const resolution = procedureResult?.ok
    ? parseContainingProcedureResolution(procedureResult.value.result)
    : procedureResult;
  const procedure: Facet = resolution?.ok
    ? { state: "available", value: resolution.value }
    : unavailableFacet(resolution?.error, operations[1]);
  const commentRecovery =
    resolution?.ok && resolution.value.found
      ? ADDRESS_CONTEXT_FUNCTION_COMMENT_RECOVERY
      : undefined;
  const comment = facet(results[2], operations[2], commentRecovery);
  const inlineComment = facet(results[3], operations[3], commentRecovery);
  const bookmarks = facet(results[4], operations[4]);
  return ok({
    address: input.address,
    document: document.value,
    name,
    procedure,
    comment,
    inline_comment: inlineComment,
    bookmarks:
      bookmarks.state === "available"
        ? matchingBookmarks(
            bookmarks.value,
            resolution?.ok ? resolution.value.query_address : input.address,
          )
        : bookmarks,
  });
};

const facet = (
  result: Result<AnalysisExecution, AnalysisError> | undefined,
  operation: AnalysisOperation,
  capabilityRecovery?: string,
): Facet =>
  result?.ok === true
    ? { state: "available", value: result.value.result }
    : unavailableFacet(result?.error, operation, capabilityRecovery);

const unavailableFacet = (
  error: AnalysisError | undefined,
  operation: AnalysisOperation,
  capabilityRecovery?: string,
): Facet => {
  if (error instanceof AnalysisInputError) {
    const projected = projectAnalysisError(error);
    if (projected.code === "invalid_request")
      return {
        state: "unavailable",
        reason: projected.message,
        remediation: projected.remediation.action,
        error: projected,
      };
  }
  return {
    state: "unavailable",
    reason: error?.message ?? `${operation} returned no result`,
    remediation:
      error instanceof AnalysisCapabilityUnavailableError && !error.retryable
        ? (error.remediationAction ??
          capabilityRecovery ??
          ADDRESS_CONTEXT_UNAVAILABLE_RECOVERY)
        : `Call ${operation} directly to inspect provider availability and diagnostics.`,
  };
};

const isRequestLevelFailure = (error: AnalysisError): boolean =>
  error._tag === "AnalysisCancelledError" ||
  error._tag === "AnalysisTimeoutError" ||
  error._tag === "NoBinaryOpenError";

/** Wait for all facets and retain every unresolved cleanup owner. */
const contextFailure = (
  results: readonly Result<AnalysisExecution, AnalysisError>[],
  signalCancellation?: AnalysisCancelledError,
): AnalysisError | undefined => {
  const failures = [
    ...new Set(results.flatMap((result) => (result.ok ? [] : [result.error]))),
  ];
  // A provider's cancellation for this exact signal carries its own diagnostic
  // and cleanup facts. Attribute that returned error to the abort event rather
  // than replacing it with our generic observation of the same signal.
  const marker =
    signalCancellation === undefined
      ? -1
      : failures.indexOf(signalCancellation);
  if (marker >= 0) {
    const reported = failures.findIndex(
      (failure, index) =>
        index > marker &&
        failure instanceof AnalysisCancelledError &&
        failure.cause === signalCancellation?.cause,
    );
    if (reported >= 0) {
      failures[marker] = failures[reported]!;
      failures.splice(reported, 1);
    }
  }
  const first = failures.find(
    (failure) => isRequestLevelFailure(failure) || failure.cleanupIncomplete,
  );
  if (first === undefined) return undefined;
  let combined = first;
  for (const failure of failures) {
    if (failure === first) continue;
    if (failure instanceof AnalysisCancelledError)
      combined = analysisErrorWithCancellation(combined, failure);
    if (failure.cleanupIncomplete) {
      const previous = combined;
      combined = analysisErrorWithCleanupFailure(
        previous,
        failure,
        "inspect_address_context",
      ).bindCleanupDependencies([previous, failure]);
    } else if (
      !(failure instanceof AnalysisCancelledError) &&
      isRequestLevelFailure(failure)
    ) {
      combined.retainSecondaryFailure(failure);
    }
  }
  return combined;
};

const matchingBookmarks = (value: JsonValue, address: string): Facet => {
  if (!Array.isArray(value))
    return {
      state: "unavailable",
      reason: "list_bookmarks returned malformed output; expected an array.",
      remediation:
        "Retry list_bookmarks directly and report the provider output shape if it remains malformed.",
    };
  const parsed = analysisBookmarkSchema.array().safeParse(value);
  if (!parsed.success)
    return {
      state: "unavailable",
      reason:
        "list_bookmarks returned malformed entries; expected an address string and a string or null name.",
      remediation:
        "Retry list_bookmarks directly and report the provider output shape if it remains malformed.",
    };
  const target = nativeAddressCoordinateInputSchema.safeParse(address);
  const matching = [];
  for (const bookmark of parsed.data) {
    if (bookmark.address === address) {
      matching.push(bookmark);
      continue;
    }
    const candidate = nativeAddressCoordinateInputSchema.safeParse(
      bookmark.address,
    );
    if (
      !target.success ||
      !candidate.success ||
      (target.data.offset === candidate.data.offset &&
        target.data.space !== candidate.data.space)
    )
      return {
        state: "unavailable",
        reason:
          "Bookmark address identity could not be compared with the selected address.",
        remediation:
          "Call list_bookmarks directly to inspect the provider addresses.",
      };
    if (
      target.data.offset === candidate.data.offset &&
      target.data.space === candidate.data.space
    )
      matching.push(bookmark);
  }
  return { state: "available", value: matching };
};
