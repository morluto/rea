import { permitsCapabilityFallback } from "./CapabilityFallback.js";
import { listNamesFact } from "../domain/native/nativeOperationFacts.js";
import {
  selectNativeSymbol,
  type NativeSymbolCandidate,
  type NativeSymbolMatch,
} from "../domain/native/nativeSymbolSelector.js";
import { executeFact } from "./AnalysisOperationFacts.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import { classifyAnalysisError } from "../domain/analysisErrorClassification.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  AnalysisExecution,
  AnalysisOperation,
  AnalysisOperationPort,
} from "../ports/AnalysisProvider.js";
import { resolveProcedureAddress } from "./ProcedureAddressResolution.js";

/** Native operations whose name selector this module resolves. */
export type NativeSymbolOperation =
  | "xrefs"
  | "find_xrefs_to_name"
  | "procedure_callers"
  | "procedure_references";

/** One name selector resolved by the shared owner, or the reason it was not. */
export type NativeSymbolResolution =
  | {
      readonly status: "resolved";
      readonly address: string;
      readonly name: string;
      /** `procedure_lookup`: the provider's own procedure-name lookup matched. */
      readonly match: NativeSymbolMatch | "procedure_lookup";
    }
  | {
      readonly status: "unresolved";
      readonly candidates: readonly NativeSymbolCandidate[];
    };

const selectorField = (operation: NativeSymbolOperation) =>
  operation === "find_xrefs_to_name"
    ? "name"
    : operation === "xrefs"
      ? "address"
      : "procedure";

/** A lookup the provider refused as a valid request it could not satisfy. */
const isLookupMiss = (error: AnalysisError): boolean =>
  !error.cleanupIncomplete &&
  classifyAnalysisError(error).category === "invalid_input";

/**
 * Resolve a name selector once for every name-taking native operation: an
 * exact observed name, then a provider-reported import by its imported or
 * library-qualified name, then (when `procedureLookup` is set) the provider's
 * own procedure lookup, which also accepts its namespace and thunk spellings.
 * An inventory miss stays unresolved; it does not show the name is absent.
 */
export const resolveNativeSymbol = async (
  analysis: AnalysisOperationPort,
  selector: string,
  operation: NativeSymbolOperation,
  signal: AbortSignal | undefined,
  { procedureLookup }: { readonly procedureLookup: boolean },
): Promise<Result<NativeSymbolResolution, AnalysisError>> => {
  if (signal?.aborted) return err(cancelledBy(operation, signal));
  const options = signal === undefined ? {} : { signal };
  const inventory = await executeFact(analysis, listNamesFact, {}, options);
  if (!inventory.ok) {
    if (
      !procedureLookup ||
      !permitsCapabilityFallback(inventory.error) ||
      inventory.error.operation !== "list_names"
    )
      return inventory;
    return procedureLookupResolution(analysis, selector, signal, []);
  }
  if (signal?.aborted) return err(cancelledBy(operation, signal));
  const rows = inventory.value.fact;
  for (let index = 0; index < rows.length; index += 1)
    // An empty address cannot be passed back to a provider operation.
    if (rows[index]!.address.length === 0)
      return err(
        new AnalysisOutputError(
          "list_names",
          `Invalid symbol inventory entry at index ${index}`,
        ),
      );
  const selection = selectNativeSymbol(rows, selector);
  if (selection.status === "resolved") return ok(selection);
  if (selection.status === "ambiguous")
    return err(
      new AnalysisInputError(
        operation,
        {
          conformsToInputContract: true,
          remediationAction:
            "Select an exact address from the candidates and retry with that address.",
        },
        [
          {
            path: [selectorField(operation)],
            reason: "invalid_value",
            message: `Analyzed symbol name ${JSON.stringify(selector)} is ambiguous at ${selection.candidates.map(({ address, name }) => (name === selector ? address : `${address} (${name})`)).join(", ")}. Select an exact address.`,
          },
        ],
      ),
    );
  return procedureLookup
    ? procedureLookupResolution(
        analysis,
        selector,
        signal,
        selection.candidates,
      )
    : ok(selection);
};

const procedureLookupResolution = async (
  analysis: AnalysisOperationPort,
  selector: string,
  signal: AbortSignal | undefined,
  candidates: readonly NativeSymbolCandidate[],
): Promise<Result<NativeSymbolResolution, AnalysisError>> => {
  const resolved = await resolveProcedureAddress(
    async (operation, parameters, signal) => {
      const result = await analysis.execute(
        operation,
        parameters,
        signal === undefined ? {} : { signal },
      );
      return result.ok ? ok(result.value.result) : result;
    },
    selector,
    signal,
  );
  if (resolved.ok)
    return ok({
      status: "resolved",
      address: resolved.value,
      name: selector,
      match: "procedure_lookup",
    });
  return isLookupMiss(resolved.error)
    ? ok({ status: "unresolved", candidates })
    : resolved;
};

/** Hexadecimal or space-qualified address spellings; providers own their meaning. */
const ADDRESS_SELECTOR = /^(?:[A-Za-z_][\w.-]*:)?0x[0-9a-f]+$/iu;

const unresolvedNameError = (
  operation: NativeSymbolOperation,
  selector: string,
  candidates: readonly NativeSymbolCandidate[],
): AnalysisInputError =>
  new AnalysisInputError(
    operation,
    {
      conformsToInputContract: true,
      ...(candidates.length > 0
        ? {}
        : { related: { operations: ["search_procedures", "list_names"] } }),
      remediationAction:
        candidates.length > 0
          ? `Retry with one of the observed names or addresses: ${candidates.map(({ address, name }) => `${name} at ${address}`).join(", ")}. The provider does not report which library each name is imported from.`
          : "Find an observed name or address with search_procedures or list_names, then retry. An inventory miss leaves the symbol's presence in the artifact unknown.",
    },
    [
      {
        path: [selectorField(operation)],
        reason: "invalid_value",
        message:
          candidates.length > 0
            ? `No observed name equals ${JSON.stringify(selector)}; the provider reports the imported name without its library.`
            : `Unknown analyzed symbol name ${JSON.stringify(selector)}. Use an exact analyzed name or a hexadecimal address.`,
      },
    ],
  );

const refusesAddressFormatOnly = (error: AnalysisError): boolean =>
  error instanceof AnalysisInputError &&
  error.issues.length > 0 &&
  error.issues.every(
    ({ path, reason }) =>
      path.length === 1 && path[0] === "address" && reason === "invalid_format",
  );

/** Whether a failed call may be answered by resolving its name selector. */
const symbolRetry = (
  operation: AnalysisOperation,
  parameters: Readonly<Record<string, JsonValue>>,
  error: AnalysisError,
): { operation: NativeSymbolOperation; selector: string } | undefined => {
  if (!isLookupMiss(error)) return undefined;
  if (operation === "xrefs") {
    const selector = parameters.address;
    return typeof selector === "string" && !ADDRESS_SELECTOR.test(selector)
      ? { operation, selector }
      : undefined;
  }
  // Outgoing references have no meaning for a symbol outside a procedure.
  if (
    operation !== "procedure_callers" &&
    !(
      operation === "procedure_references" &&
      parameters.direction === "incoming"
    )
  )
    return undefined;
  const selector = parameters.procedure;
  return typeof selector === "string" && !ADDRESS_SELECTOR.test(selector)
    ? { operation, selector }
    : undefined;
};

/**
 * Run one native operation for CLI and MCP alike. When the provider refuses a
 * name selector for `xrefs`, `procedure_callers` or incoming
 * `procedure_references`, resolve it with {@link resolveNativeSymbol} and
 * ask the provider again by address. The provider's own refusal is kept when
 * resolution adds nothing, so its facts and recovery still reach the caller.
 */
export const executeWithNativeSymbolSelection = async (
  analysis: AnalysisOperationPort,
  operation: AnalysisOperation,
  parameters: Readonly<Record<string, JsonValue>>,
  execute: (
    parameters: Readonly<Record<string, JsonValue>>,
  ) => Promise<Result<AnalysisExecution, AnalysisError>>,
  signal?: AbortSignal,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  const first = await execute(parameters);
  if (first.ok) return first;
  const retry = symbolRetry(operation, parameters, first.error);
  if (retry === undefined) return first;
  const resolved = await resolveNativeSymbol(
    analysis,
    retry.selector,
    retry.operation,
    signal,
    // The provider's procedure lookup already refused the procedure selector.
    { procedureLookup: retry.operation === "xrefs" },
  );
  // Without a name inventory, the provider's own refusal remains the answer.
  if (!resolved.ok)
    return permitsCapabilityFallback(resolved.error) ? first : resolved;
  const resolution = resolved.value;
  // A provider that refused only the address format never looked the name up,
  // so its refusal says nothing about the name; any other refusal stands.
  if (resolution.status === "unresolved")
    return resolution.candidates.length > 0 ||
      refusesAddressFormatOnly(first.error)
      ? err(
          unresolvedNameError(
            retry.operation,
            retry.selector,
            resolution.candidates,
          ),
        )
      : first;
  if (resolution.address === retry.selector) return first;
  const field = retry.operation === "xrefs" ? "address" : "procedure";
  const answered = await execute({
    ...parameters,
    [field]: resolution.address,
  });
  if (!answered.ok) return retry.operation === "xrefs" ? answered : first;
  return ok({
    ...answered.value,
    limitations: [
      `REA resolved ${JSON.stringify(retry.selector)} to ${resolution.name === retry.selector ? "" : `${resolution.name} at `}${resolution.address} (${resolution.match}) and the provider answered by that address.`,
      ...answered.value.limitations,
    ],
  });
};
