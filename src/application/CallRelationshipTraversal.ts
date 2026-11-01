import type { CallRelationshipDirection } from "../contracts/enhancedInputs.js";
import type {
  AnalysisExecution,
  AnalysisOperation,
  ExecutionOptions,
} from "./AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { parseRelatedAddresses } from "../domain/native/nativeObservation.js";
import type { Result } from "../domain/result.js";

/** The provider read and response relation for each supported traversal direction. */
export const CALL_RELATIONSHIP_TRAVERSALS = {
  forward: { operation: "procedure_callees", relation: "callees" },
  backward: { operation: "procedure_callers", relation: "callers" },
} as const satisfies Readonly<
  Record<
    CallRelationshipDirection,
    {
      readonly operation: AnalysisOperation;
      readonly relation: "callees" | "callers";
    }
  >
>;

/** One observed provider operation, as composed workflows dispatch it. */
export type CallRelationshipObserver = (
  name: AnalysisOperation,
  arguments_: Readonly<Record<string, JsonValue>>,
  signal?: AbortSignal,
  selectorOrigin?: ExecutionOptions["selectorOrigin"],
) => Promise<Result<AnalysisExecution, AnalysisError>>;

/**
 * One procedure's relationship read. An unavailable or unreadable read leaves
 * the rest of the traversal usable; a stopped read must end it.
 */
export type CallRelationshipRead =
  | {
      readonly status: "observed";
      readonly execution: AnalysisExecution;
      readonly related: readonly string[];
    }
  | { readonly status: "unavailable"; readonly error: AnalysisError }
  | { readonly status: "unreadable"; readonly error: AnalysisOutputError }
  | { readonly status: "stopped"; readonly error: AnalysisError };

/** Read and parse one procedure's direct relationships for a traversal. */
export const readCallRelationships = async (
  observe: CallRelationshipObserver,
  direction: CallRelationshipDirection,
  procedure: string,
  signal?: AbortSignal,
): Promise<CallRelationshipRead> => {
  const { operation, relation } = CALL_RELATIONSHIP_TRAVERSALS[direction];
  const execution = await observe(operation, { procedure }, signal, "provider");
  if (!execution.ok)
    return {
      // A provider that cannot confirm release of resources it owns has not
      // finished this read; dispatching more reads would build on that state.
      status:
        execution.error._tag === "AnalysisCancelledError" ||
        execution.error.cleanupIncomplete
          ? "stopped"
          : "unavailable",
      error: execution.error,
    };
  const related = parseRelatedAddresses(
    execution.value.result,
    relation,
    operation,
  );
  return related.ok
    ? { status: "observed", execution: execution.value, related: related.value }
    : { status: "unreadable", error: related.error };
};

/** The admitted traversal's caveat when unconfirmed cleanup stopped it. */
export const cleanupStoppedTraversal = (
  procedure: string,
  unexpanded: number,
): string =>
  `Traversal stopped at ${procedure} because the provider did not confirm cleanup of resources it owns; ${unexpanded === 1 ? "1 discovered procedure was" : `${unexpanded} discovered procedures were`} not expanded.`;
