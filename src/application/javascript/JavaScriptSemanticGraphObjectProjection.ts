import type { JavaScriptSourceRange } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import {
  semanticSlotAtPath,
  semanticContainer,
  semanticPropertyPointer,
} from "../../domain/javascript/javascriptSemanticSlots.js";
import type {
  JavaScriptSemanticSlotPresence,
  JavaScriptSemanticValue,
} from "../../domain/javascript/javascriptSemanticValueTypes.js";
import type { JavaScriptSemanticGraphNode } from "../../domain/javascript/javascriptSemanticGraphSchemas.js";
import type {
  JavaScriptSemanticIr,
  JavaScriptSemanticObjectOperation,
} from "../../domain/javascript/javascriptSemanticIr.js";
import {
  retainSemanticGraphNode,
  addSemanticGraphRelation,
  addSemanticGraphUnknown,
} from "./JavaScriptSemanticGraphConstruction.js";
import { unknownSemanticEvidence } from "./JavaScriptSemanticGraphEvidence.js";
import type { SemanticFlowProjectionContext } from "./JavaScriptSemanticGraphFlowProjection.js";
import {
  foldedAssignedContainerValues,
  type FoldedAssignedValue,
} from "./JavaScriptSemanticGraphAssignedValues.js";
import { semanticPropertySlot } from "./JavaScriptSemanticGraphValueProjection.js";

/** Apply folded assignment values to one operation by source position. */
const withPositionalFolds = (
  base: JavaScriptSemanticValue | undefined,
  operation: JavaScriptSemanticObjectOperation,
  folds: readonly FoldedAssignedValue[] | undefined,
): JavaScriptSemanticValue | undefined => {
  if (base === undefined || folds === undefined) return base;
  let value = base;
  for (const folded of folds) {
    const after =
      operation.location.start.line > folded.target.start.line ||
      (operation.location.start.line === folded.target.start.line &&
        operation.location.start.column >= folded.target.end.column);
    if (after)
      value = valueWithAssignedContainer(
        value,
        folded.propertyPath,
        folded.value,
      );
  }
  return value;
};

/** Overwrites one property path with an assigned container value. */
const valueWithAssignedContainer = (
  value: JavaScriptSemanticValue,
  path: readonly string[],
  assigned: JavaScriptSemanticValue,
): JavaScriptSemanticValue => {
  if (path.length === 0) return assigned;
  const [name, ...rest] = path as [string, ...string[]];
  if (value.status !== "object" && value.status !== "array")
    return {
      status: "object",
      properties: [
        {
          name,
          value: assignedAtRest(rest, assigned),
          presence: "present",
        },
      ],
      unknownProperties: false,
      omittedProperties: 0,
    };
  const properties = value.status === "object" ? value.properties : value.items;
  const updated = properties.map((property) =>
    property.name === name
      ? {
          ...property,
          value: valueWithAssignedContainer(property.value, rest, assigned),
          presence: "present" as const,
        }
      : property,
  );
  if (
    value.status === "object" &&
    !updated.some((property) => property.name === name)
  )
    updated.push({
      name,
      value: assignedAtRest(rest, assigned),
      presence: "present",
    });
  return value.status === "object"
    ? { ...value, properties: updated }
    : { ...value, items: updated };
};

const assignedAtRest = (
  rest: readonly string[],
  assigned: JavaScriptSemanticValue,
): JavaScriptSemanticValue =>
  rest.length === 0
    ? assigned
    : valueWithAssignedContainer(
        { status: "unknown", reason: "assigned-container-parent" },
        rest,
        assigned,
      );

/** Project static object reads, writes, spreads, and destructuring. */
export function* projectSemanticObjects(
  context: SemanticFlowProjectionContext,
): Generator<void, void> {
  const values = new Map(
    context.ir.bindings.map((binding) => [binding.bindingId, binding.value]),
  );
  // Folded assignment values apply positionally: only reads at or after the
  // assignment observe them, so an earlier read keeps the pre-assignment fact.
  const foldsByBinding = new Map<string, FoldedAssignedValue[]>();
  for (const folded of foldedAssignedContainerValues(context)) {
    const list = foldsByBinding.get(folded.receiverBindingId) ?? [];
    list.push(folded);
    foldsByBinding.set(folded.receiverBindingId, list);
  }
  // folds are consumed positionally in objectTarget
  for (const [index, operation] of context.ir.objectOperations.entries()) {
    if (index % 64 === 0) yield;
    const target = objectTarget(context, values, operation, foldsByBinding);
    const occurrence = addObjectOccurrence(
      context,
      operation,
      target.slotApplicability,
    );
    if (occurrence !== null) {
      if (operation.kind === "read") context.readNodes.push(occurrence);
      if (operation.kind === "write") context.writeNodes.push(occurrence);
    }
    const ends = objectRelationEnds(context, operation, occurrence, target);
    const resolved =
      operation.resolution === "complete" &&
      (operation.kind === "write"
        ? target.receiverResolved
        : target.presence === "present");
    addSemanticGraphRelation(context.state, {
      ...ends,
      relation: OBJECT_RELATIONS[operation.kind],
      resolution: resolved ? "resolved" : "candidate",
    });
    if (!resolved)
      addObjectUnknown(context, operation, target.slot ?? occurrence, target);
  }
}

const OBJECT_RELATIONS = {
  read: "reads-property",
  write: "writes-property",
  destructure: "destructures",
  spread: "spreads",
} as const;

interface ObjectTarget {
  readonly objectNode: JavaScriptSemanticGraphNode | null | undefined;
  readonly slot: JavaScriptSemanticGraphNode | null;
  readonly presence: JavaScriptSemanticSlotPresence;
  readonly receiverResolved: boolean;
  readonly slotApplicability: "resolved" | "unresolved";
}

const objectTarget = (
  context: SemanticFlowProjectionContext,
  values: ReadonlyMap<string, JavaScriptSemanticValue>,
  operation: JavaScriptSemanticObjectOperation,
  foldsByBinding: ReadonlyMap<string, readonly FoldedAssignedValue[]>,
): ObjectTarget => {
  const binding =
    operation.objectBindingId === null
      ? undefined
      : context.bindingNodes.get(operation.objectBindingId);
  const base =
    operation.objectBindingId === null
      ? undefined
      : values.get(operation.objectBindingId);
  const value = withPositionalFolds(
    base,
    operation,
    operation.objectBindingId === null
      ? undefined
      : foldsByBinding.get(operation.objectBindingId),
  );
  if (
    operation.objectBindingId === null ||
    operation.propertyPath === null ||
    value === undefined
  )
    return {
      objectNode: binding,
      slot: null,
      presence: "unknown-coverage",
      receiverResolved: false,
      slotApplicability: "unresolved",
    };
  const fact = semanticSlotAtPath(value, operation.propertyPath);
  if (operation.propertyPath.length === 0)
    return {
      objectNode: binding,
      slot: null,
      presence: fact.presence,
      receiverResolved: semanticContainer(value) !== null,
      slotApplicability: "unresolved",
    };
  const slot = semanticPropertySlot(
    context,
    operation.objectBindingId,
    operation.propertyPath,
    fact,
  );
  const receiver = semanticSlotAtPath(
    value,
    operation.propertyPath.slice(0, -1),
  );
  return {
    objectNode: slot,
    slot,
    slotApplicability: "resolved",
    presence: fact.presence,
    receiverResolved:
      receiver.presence === "present" &&
      semanticContainer(receiver.value) !== null,
  };
};

const objectRelationEnds = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticObjectOperation,
  occurrence: JavaScriptSemanticGraphNode | null,
  target: ObjectTarget,
) => {
  switch (operation.kind) {
    case "read":
      return { source: target.slot, target: occurrence };
    case "write":
      return { source: occurrence, target: target.slot };
    case "destructure":
      return {
        source: target.slot,
        target:
          operation.targetBindingId === null
            ? undefined
            : context.bindingNodes.get(operation.targetBindingId),
      };
    case "spread":
      return { source: target.objectNode, target: occurrence };
  }
};

const addObjectOccurrence = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticObjectOperation,
  slotApplicability: ObjectTarget["slotApplicability"],
): JavaScriptSemanticGraphNode | null =>
  retainSemanticGraphNode(context.state, context.file, {
    kind: "expression",
    roleKey: operation.objectOperationId,
    location: operation.location,
    label:
      operation.propertyPath === null
        ? operation.kind
        : `${operation.kind}:${semanticPropertyPointer(operation.propertyPath)}`,
    functionNodeId:
      operation.ownerCallableId === null
        ? null
        : (context.callableNodes.get(operation.ownerCallableId)?.node_id ??
          null),
    properties: {
      operation_kind: operation.kind,
      property_path:
        operation.propertyPath === null ? null : [...operation.propertyPath],
      property_slot_resolution: slotApplicability,
    },
  });

const addObjectUnknown = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticObjectOperation,
  node: JavaScriptSemanticGraphNode | null,
  target: Pick<ObjectTarget, "presence" | "receiverResolved">,
): void => {
  const relation = OBJECT_RELATIONS[operation.kind];
  addSemanticGraphUnknown(context.state, {
    node_id: node?.node_id ?? null,
    family: "object-flow",
    relation_kinds: [relation],
    reason: "ambiguous-target",
    detail: `Static ${operation.kind} property ${operation.propertyPath === null ? "path is unresolved" : semanticPropertyPointer(operation.propertyPath)} has ${target.presence} presence; its receiver is ${target.receiverResolved ? "a retained container" : "unresolved or not a retained container"}; object identity is ${operation.resolution}.`,
    candidate_node_ids: [],
    evidence: unknownSemanticEvidence(context.file, operation.location),
  });
};
