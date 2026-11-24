import { permitsCapabilityFallback } from "./CapabilityFallback.js";
import {
  listNamesFact,
  resolveContainingProcedureFact,
} from "../domain/native/nativeOperationFacts.js";
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
  // A selector that matched several candidates was found, not missed.
  !(
    error instanceof AnalysisInputError && error.ambiguousSelector !== undefined
  ) &&
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
          ambiguousSelector: {
            field: [selectorField(operation)],
            candidates: selection.candidates.map(({ address }) => address),
          },
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

/**
 * Whether the provider's answer at a resolved address keeps the caller's
 * symbol: an address outside every procedure, or a procedure's exact entry
 * (such as an external import function). An address inside a procedure, such
 * as an interior label, would silently select its containing procedure.
 * A provider without containment lookup keeps its own refusal; any other
 * lookup failure is returned with its facts.
 */
const answersSymbolByAddress = async (
  analysis: AnalysisOperationPort,
  address: string,
  signal: AbortSignal | undefined,
): Promise<Result<boolean, AnalysisError>> => {
  const containing = await executeFact(
    analysis,
    resolveContainingProcedureFact,
    { address },
    signal === undefined ? {} : { signal },
  );
  if (!containing.ok)
    return permitsCapabilityFallback(containing.error) ? ok(false) : containing;
  const fact = containing.value.fact;
  return ok(
    fact.found
      ? fact.procedure.address === address
      : fact.reason === "not_in_procedure",
  );
};

/** A non-address name selector of an operation the shared owner resolves. */
const nameSelector = (
  operation: AnalysisOperation,
  parameters: Readonly<Record<string, JsonValue>>,
): { operation: NativeSymbolOperation; selector: string } | undefined => {
  const field =
    operation === "xrefs"
      ? "address"
      : operation === "procedure_callers" ||
          // Outgoing references have no meaning for a symbol outside a procedure.
          (operation === "procedure_references" &&
            parameters.direction === "incoming")
        ? "procedure"
        : undefined;
  if (field === undefined) return undefined;
  const selector = parameters[field];
  return typeof selector === "string" && !ADDRESS_SELECTOR.test(selector)
    ? { operation: operation as NativeSymbolOperation, selector }
    : undefined;
};

const answeredByAddress = (
  answered: Result<AnalysisExecution, AnalysisError>,
  selector: string,
  resolution: Extract<NativeSymbolResolution, { status: "resolved" }>,
): Result<AnalysisExecution, AnalysisError> =>
  !answered.ok || resolution.address === selector
    ? answered
    : ok({
        ...answered.value,
        limitations: [
          `REA resolved ${JSON.stringify(selector)} to ${resolution.name === selector ? "" : `${resolution.name} at `}${resolution.address} (${resolution.match}) and the provider answered by that address.`,
          ...answered.value.limitations,
        ],
      });

/**
 * Run one native operation for CLI and MCP alike, resolving a name selector
 * with {@link resolveNativeSymbol} so it means the same symbol in every tool.
 *
 * - `procedure_callers` and incoming `procedure_references` resolve the name
 *   first and ask the provider by its address when that address is outside
 *   every procedure or a procedure's exact entry. A name the shared owner
 *   cannot resolve, or one inside a procedure, goes to the provider's own
 *   procedure lookup, which also accepts its alias and thunk spellings.
 * - `xrefs` asks the provider first; a refused name is resolved and asked
 *   again by address.
 *
 * The provider's own refusal is kept when resolution adds nothing, so its
 * facts and recovery still reach the caller.
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
  const named = nameSelector(operation, parameters);
  if (named === undefined) return execute(parameters);
  return named.operation === "xrefs"
    ? executeXrefs(analysis, parameters, execute, named.selector, signal)
    : executeIncoming(analysis, parameters, execute, named, signal);
};

const executeIncoming = async (
  analysis: AnalysisOperationPort,
  parameters: Readonly<Record<string, JsonValue>>,
  execute: (
    parameters: Readonly<Record<string, JsonValue>>,
  ) => Promise<Result<AnalysisExecution, AnalysisError>>,
  {
    operation,
    selector,
  }: { operation: NativeSymbolOperation; selector: string },
  signal: AbortSignal | undefined,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  const resolved = await resolveNativeSymbol(
    analysis,
    selector,
    operation,
    signal,
    // The provider's own procedure lookup runs below when the owner misses.
    { procedureLookup: false },
  );
  // Without a name inventory the provider's procedure lookup is the owner.
  if (!resolved.ok)
    return permitsCapabilityFallback(resolved.error)
      ? execute(parameters)
      : resolved;
  const resolution = resolved.value;
  if (resolution.status === "resolved") {
    // An address inside a procedure, such as an interior label, would select
    // its containing procedure; the provider decides that name itself.
    const answers = await answersSymbolByAddress(
      analysis,
      resolution.address,
      signal,
    );
    if (!answers.ok) return answers;
    if (answers.value)
      return answeredByAddress(
        await execute({ ...parameters, procedure: resolution.address }),
        selector,
        resolution,
      );
    return execute(parameters);
  }
  const provided = await execute(parameters);
  return !provided.ok &&
    resolution.candidates.length > 0 &&
    isLookupMiss(provided.error)
    ? err(unresolvedNameError(operation, selector, resolution.candidates))
    : provided;
};

const executeXrefs = async (
  analysis: AnalysisOperationPort,
  parameters: Readonly<Record<string, JsonValue>>,
  execute: (
    parameters: Readonly<Record<string, JsonValue>>,
  ) => Promise<Result<AnalysisExecution, AnalysisError>>,
  selector: string,
  signal: AbortSignal | undefined,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  const first = await execute(parameters);
  if (first.ok || !isLookupMiss(first.error)) return first;
  const resolved = await resolveNativeSymbol(
    analysis,
    selector,
    "xrefs",
    signal,
    { procedureLookup: true },
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
      ? err(unresolvedNameError("xrefs", selector, resolution.candidates))
      : first;
  if (resolution.address === selector) return first;
  return answeredByAddress(
    await execute({ ...parameters, address: resolution.address }),
    selector,
    resolution,
  );
};
