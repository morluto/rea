import {
  semanticSlotAtPath,
  semanticContainer,
  semanticPropertyPointer,
} from "../../domain/javascript/javascriptSemanticSlots.js";
import type {
  JavaScriptSemanticSlotPresence,
  JavaScriptSemanticValue,
} from "../../domain/javascript/javascriptSemanticValueTypes.js";
import { createJavaScriptSemanticGraphUnknown } from "../../domain/javascript/javascriptSemanticGraph.js";
import type { JavaScriptSemanticGraphNode } from "../../domain/javascript/javascriptSemanticGraphSchemas.js";
import type { JavaScriptSemanticObjectOperation } from "../../domain/javascript/javascriptSemanticIr.js";
import {
  retainSemanticGraphNode,
  addSemanticGraphRelation,
  addSemanticGraphUnknown,
} from "./JavaScriptSemanticGraphConstruction.js";
import { unknownSemanticEvidence } from "./JavaScriptSemanticGraphEvidence.js";
import type { SemanticFlowProjectionContext } from "./JavaScriptSemanticGraphFlowProjection.js";
import { semanticPropertySlot } from "./JavaScriptSemanticGraphValueProjection.js";

/** Project static object reads, writes, spreads, and destructuring. */
export const projectSemanticObjects = (
  context: SemanticFlowProjectionContext,
): void => {
  const values = new Map(
    context.ir.bindings.map((binding) => [binding.bindingId, binding.value]),
  );
  for (const operation of context.ir.objectOperations) {
    const occurrence = addObjectOccurrence(context, operation);
    const target = objectTarget(context, values, operation);
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
};

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
}

const objectTarget = (
  context: SemanticFlowProjectionContext,
  values: ReadonlyMap<string, JavaScriptSemanticValue>,
  operation: JavaScriptSemanticObjectOperation,
): ObjectTarget => {
  const binding =
    operation.objectBindingId === null
      ? undefined
      : context.bindingNodes.get(operation.objectBindingId);
  const value =
    operation.objectBindingId === null
      ? undefined
      : values.get(operation.objectBindingId);
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
    };
  const fact = semanticSlotAtPath(value, operation.propertyPath);
  if (operation.propertyPath.length === 0)
    return {
      objectNode: binding,
      slot: null,
      presence: fact.presence,
      receiverResolved: semanticContainer(value) !== null,
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
    },
  });

const addObjectUnknown = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticObjectOperation,
  node: JavaScriptSemanticGraphNode | null,
  target: Pick<ObjectTarget, "presence" | "receiverResolved">,
): void => {
  const relation = OBJECT_RELATIONS[operation.kind];
  addSemanticGraphUnknown(
    context.state,
    createJavaScriptSemanticGraphUnknown(
      {
        node_id: node?.node_id ?? null,
        family: "object-flow",
        relation_kinds: [relation],
        reason: "ambiguous-target",
        detail: `Static ${operation.kind} property ${operation.propertyPath === null ? "path is unresolved" : semanticPropertyPointer(operation.propertyPath)} has ${target.presence} presence; its receiver is ${target.receiverResolved ? "a retained container" : "unresolved or not a retained container"}; object identity is ${operation.resolution}.`,
        candidate_node_ids: [],
        evidence: unknownSemanticEvidence(context.file, operation.location),
      },
      context.state.evidenceContexts,
    ),
  );
};
