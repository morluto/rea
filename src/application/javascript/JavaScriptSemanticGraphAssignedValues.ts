import type { SemanticFlowProjectionContext } from "./JavaScriptSemanticGraphFlowProjection.js";
import type { JavaScriptSemanticIr } from "../../domain/javascript/javascriptSemanticIr.js";
import type { JavaScriptSourceRange } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";

type AssignedValue = NonNullable<
  JavaScriptSemanticIr["assignmentFlows"][number]["assignedValue"]
>;

/** Whether `left` starts earlier in the source than `right`. */
const rangeStartsBefore = (
  left: JavaScriptSourceRange,
  right: JavaScriptSourceRange,
): boolean =>
  left.start.line < right.start.line ||
  (left.start.line === right.start.line &&
    left.start.column < right.start.column);

/** A folded top-level literal container assignment, ready for projection. */
export interface FoldedAssignedValue {
  readonly receiverBindingId: string;
  readonly propertyPath: readonly string[];
  readonly value: AssignedValue["value"];
  readonly target: JavaScriptSourceRange;
  readonly source: JavaScriptSourceRange;
}

/**
 * The unconditional top-level `X.p = { container }` assignments the graph may
 * model like initializers, after four filters:
 *
 * - the write's receiver resolves to a lexical binding (never a display-name
 *   guess), and that binding can hold an object;
 * - repeated or nested writers to one path keep only the assignment that
 *   commits last in JavaScript evaluation order;
 * - any other write intersecting the path — conditional, in a function or
 *   loop, a non-literal right-hand side, or a dynamic member key — keeps the
 *   value unknown;
 * - a later read of the container itself lets the reference escape, so the
 *   folded value no longer speaks for the final state.
 */
export const foldedAssignedContainerValues = (
  context: SemanticFlowProjectionContext,
): readonly FoldedAssignedValue[] => {
  const candidates = new Map<string, FoldedAssignedValue>();
  for (const flow of context.ir.assignmentFlows) {
    const assigned = flow.assignedValue;
    if (assigned === undefined) continue;
    const receiverBindingId = resolveReceiverBinding(context, flow);
    if (receiverBindingId === undefined) continue;
    if (!receiverObjectCapable(context, receiverBindingId)) continue;
    const key = `${receiverBindingId} ${JSON.stringify(assigned.propertyPath)}`;
    // The assignment that commits last wins. Later textual start covers plain
    // sequences; an enclosing nested writer starts no later than its inner
    // one and commits after it, so it replaces the entry as well.
    const existing = candidates.get(key);
    if (
      existing === undefined ||
      // An assignment whose full expression encloses the other's target sits
      // in its right-hand side and commits after it.
      rangeEncloses(flow.source, existing.target) ||
      (!rangeEncloses(existing.source, flow.target) &&
        !rangeStartsBefore(flow.target, existing.target))
    )
      candidates.set(key, {
        receiverBindingId,
        propertyPath: assigned.propertyPath,
        value: assigned.value,
        target: flow.target,
        source: flow.source,
      });
  }
  const folded: FoldedAssignedValue[] = [];
  for (const candidate of candidates.values()) {
    if (writeConflicts(context, candidate)) continue;
    if (containerEscapesAfterFold(context, candidate)) continue;
    folded.push(candidate);
  }
  return folded;
};

/** Resolve the write's receiver through the object operation it produced. */
const resolveReceiverBinding = (
  context: SemanticFlowProjectionContext,
  flow: JavaScriptSemanticIr["assignmentFlows"][number],
): string | undefined => {
  const operation = context.ir.objectOperations.find(
    (candidate) =>
      candidate.kind === "write" &&
      rangesEqual(candidate.location, flow.target),
  );
  return operation?.objectBindingId ?? undefined;
};

/** Whether `outer`'s source range fully encloses `inner`'s. */
const rangeEncloses = (
  outer: JavaScriptSourceRange,
  inner: JavaScriptSourceRange,
): boolean =>
  !rangeStartsBefore(inner, outer) &&
  (inner.end.line < outer.end.line ||
    (inner.end.line === outer.end.line &&
      inner.end.column <= outer.end.column));

const rangesEqual = (
  left: JavaScriptSourceRange,
  right: JavaScriptSourceRange,
): boolean =>
  left.start.line === right.start.line &&
  left.start.column === right.start.column &&
  left.end.line === right.end.line &&
  left.end.column === right.end.column;

/** Only object-capable receivers can retain the assigned container. */
const receiverObjectCapable = (
  context: SemanticFlowProjectionContext,
  bindingId: string,
): boolean => {
  const binding = context.ir.bindings.find(
    (candidate) => candidate.bindingId === bindingId,
  );
  const status = binding?.value.status;
  // Unknown covers functions and classes, which accept expando properties;
  // a concrete primitive or null receiver cannot store them.
  return status === "object" || status === "array" || status === "unknown";
};

/** Whether two static property paths share any prefix overlap. */
const propertyPathsIntersect = (
  left: readonly unknown[],
  right: readonly unknown[],
): boolean => {
  const shorter = Math.min(left.length, right.length);
  for (let index = 0; index < shorter; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === null || typeof a === "object") return true;
    if (b === null || typeof b === "object") return true;
    if (String(a) !== String(b)) return false;
  }
  return true;
};

/**
 * Another write touching the folded path — an explicit different-location
 * assignment, or a dynamic-key member write whose target cannot be ruled out —
 * means the folded literal is not provably the final value.
 */
const writeConflicts = (
  context: SemanticFlowProjectionContext,
  candidate: FoldedAssignedValue,
): boolean =>
  context.ir.objectOperations.some(
    (operation) =>
      operation.kind === "write" &&
      operation.objectBindingId === candidate.receiverBindingId &&
      !rangesEqual(operation.location, candidate.target) &&
      !isFoldedTarget(context, operation.location) &&
      (operation.propertyPath === null ||
        propertyPathsIntersect(operation.propertyPath, candidate.propertyPath)),
  );

/** Locations of value-carrying assignments, exempt from the dynamic veto. */
const isFoldedTarget = (
  context: SemanticFlowProjectionContext,
  location: JavaScriptSourceRange,
): boolean =>
  context.ir.assignmentFlows.some(
    (flow) =>
      flow.assignedValue !== undefined && rangesEqual(flow.target, location),
  );

/**
 * Reading the container itself after the fold hands the reference to a caller
 * that may mutate it; the folded value then no longer describes the binding
 * at later reads.
 */
const containerEscapesAfterFold = (
  context: SemanticFlowProjectionContext,
  candidate: FoldedAssignedValue,
): boolean =>
  context.ir.objectOperations.some(
    (operation) =>
      operation.kind === "read" &&
      operation.objectBindingId === candidate.receiverBindingId &&
      operation.propertyPath !== null &&
      isProperPrefixOf(operation.propertyPath, candidate.propertyPath) &&
      rangeStartsBefore(candidate.target, operation.location),
  );

/** Whether `prefix` equals `full` or is a strictly shorter path prefix. */
const isProperPrefixOf = (
  prefix: readonly unknown[],
  full: readonly unknown[],
): boolean =>
  prefix.length <= full.length &&
  prefix.every((segment, index) => String(segment) === String(full[index]));
