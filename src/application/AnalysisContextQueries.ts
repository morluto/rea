import type {
  AnalysisExecution,
  AnalysisOperation,
  AnalysisOperationPort,
} from "./AnalysisProvider.js";
import { AnalysisOutputError, type AnalysisError } from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";

type Facet =
  | { readonly state: "available"; readonly value: JsonValue }
  | {
      readonly state: "unavailable";
      readonly reason: string;
      readonly remediation: string;
    };

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
  const documentArgs =
    typeof documentName === "string" ? parameters(documentName) : {};
  const address = await analysis.execute(
    "current_address",
    documentArgs,
    executionOptions(signal),
  );
  if (!address.ok) return address;
  if (typeof address.value.result !== "string")
    return ok({
      document: documentName,
      address: address.value.result,
      procedure: null,
    });
  const procedure = await analysis.execute(
    "resolve_containing_procedure",
    parameters(
      typeof documentName === "string" ? documentName : undefined,
      address.value.result,
    ),
    executionOptions(signal),
  );
  if (!procedure.ok) {
    if (!isMissingCurrentProcedure(procedure.error)) return procedure;
    return ok({
      document: documentName,
      address: address.value.result,
      procedure: null,
    });
  }
  return ok({
    document: documentName,
    address: address.value.result,
    procedure: containingProcedureName(procedure.value.result),
  });
};

/** Inspect bounded provider-neutral facets at one explicit reproducible address. */
export const inspectAddressContext = async (
  analysis: AnalysisOperationPort,
  input: { readonly address: string; readonly document?: string | undefined },
  signal?: AbortSignal,
): Promise<Result<JsonValue, AnalysisError>> => {
  const document = await resolveDocument(analysis, input.document, signal);
  if (!document.ok) return document;
  const args = parameters(document.value, input.address);
  const operations = [
    "address_name",
    "resolve_containing_procedure",
    "comment",
    "inline_comment",
    "list_bookmarks",
  ] as const satisfies readonly AnalysisOperation[];
  const results = await Promise.all(
    operations.map((operation) =>
      analysis.execute(
        operation,
        operation === "list_bookmarks" ? parameters(document.value) : args,
        executionOptions(signal),
      ),
    ),
  );
  for (const result of results) {
    if (!result.ok && isRequestLevelFailure(result.error)) return result;
  }
  const name = facet(results[0], operations[0]);
  const procedure = facet(results[1], operations[1]);
  const comment = facet(results[2], operations[2]);
  const inlineComment = facet(results[3], operations[3]);
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
            resolvedAddress(results[1], input.address),
          )
        : bookmarks,
  });
};

const resolveDocument = async (
  analysis: AnalysisOperationPort,
  document: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Result<string, AnalysisError>> => {
  if (document !== undefined) return ok(document);
  const current = await analysis.execute(
    "current_document",
    {},
    executionOptions(signal),
  );
  if (!current.ok) return current;
  return typeof current.value.result === "string"
    ? ok(current.value.result)
    : err(
        new AnalysisOutputError(
          "current_document",
          "expected a document identity string",
        ),
      );
};

const facet = (
  result: Result<AnalysisExecution, AnalysisError> | undefined,
  operation: AnalysisOperation,
): Facet =>
  result?.ok === true
    ? { state: "available", value: result.value.result }
    : {
        state: "unavailable",
        reason: result?.error.message ?? `${operation} returned no result`,
        remediation: `Call ${operation} directly to inspect provider availability and diagnostics.`,
      };

const isMissingCurrentProcedure = (error: AnalysisError): boolean =>
  /(?:no procedure exists|not in a procedure)/iu.test(error.message);

const isRequestLevelFailure = (error: AnalysisError): boolean =>
  error._tag === "AnalysisCancelledError" ||
  error._tag === "AnalysisTimeoutError" ||
  error._tag === "NoBinaryOpenError" ||
  error._tag === "PermissionRequiredError";

const containingProcedureName = (value: JsonValue): string | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  if (value.found !== true) return null;
  const procedure = value.procedure;
  if (
    typeof procedure !== "object" ||
    procedure === null ||
    Array.isArray(procedure)
  )
    return null;
  return typeof procedure.name === "string" ? procedure.name : null;
};

const resolvedAddress = (
  result: Result<AnalysisExecution, AnalysisError> | undefined,
  fallback: string,
): string => {
  if (result?.ok !== true) return fallback;
  const value = result.value.result;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return fallback;
  return typeof value.query_address === "string"
    ? value.query_address
    : fallback;
};

const matchingBookmarks = (value: JsonValue, address: string): Facet => {
  if (!Array.isArray(value))
    return {
      state: "unavailable",
      reason: "list_bookmarks returned malformed output; expected an array.",
      remediation:
        "Retry list_bookmarks directly and report the provider output shape if it remains malformed.",
    };
  if (!value.every(isBookmark))
    return {
      state: "unavailable",
      reason:
        "list_bookmarks returned malformed entries; expected address and name strings.",
      remediation:
        "Retry list_bookmarks directly and report the provider output shape if it remains malformed.",
    };
  return {
    state: "available",
    value: value.filter((bookmark) => bookmark.address === address),
  };
};

const isBookmark = (
  value: JsonValue,
): value is { readonly address: string; readonly name: string } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof value.address === "string" &&
  typeof value.name === "string";
