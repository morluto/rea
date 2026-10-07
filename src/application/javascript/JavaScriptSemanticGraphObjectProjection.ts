import { createJavaScriptSemanticGraphUnknown } from "../../domain/javascriptSemanticGraph.js";
import type { JavaScriptSemanticGraphNode } from "../../domain/javascriptSemanticGraph.js";
import type { JavaScriptSemanticObjectOperation } from "../../domain/javascriptSemanticIr.js";
import {
  addSemanticGraphNode,
  addSemanticGraphRelation,
  addSemanticGraphUnknown,
  constructSemanticGraphNode,
} from "./JavaScriptSemanticGraphConstruction.js";
import { unknownSemanticEvidence } from "./JavaScriptSemanticGraphEvidence.js";
import type { SemanticFlowProjectionContext } from "./JavaScriptSemanticGraphFlowProjection.js";
import { semanticPropertySlot } from "./JavaScriptSemanticGraphValueProjection.js";

/** Project static object reads, writes, spreads, and destructuring. */
export const projectSemanticObjects = (
  context: SemanticFlowProjectionContext,
): void => {
  for (const operation of context.ir.objectOperations) {
    const occurrence = addObjectOccurrence(context, operation);
    const slot =
      operation.objectBindingId === null || operation.propertyName === null
        ? null
        : semanticPropertySlot(
            context,
            operation.objectBindingId,
            operation.propertyName,
          );
    if (operation.kind === "read")
      addSemanticGraphRelation(context.state, {
        source: slot,
        target: occurrence,
        relation: "reads-property",
        resolution:
          operation.resolution === "complete" ? "resolved" : "candidate",
      });
    else if (operation.kind === "write")
      addSemanticGraphRelation(context.state, {
        source: occurrence,
        target: slot,
        relation: "writes-property",
        resolution:
          operation.resolution === "complete" ? "resolved" : "candidate",
      });
    else if (operation.kind === "destructure")
      addSemanticGraphRelation(context.state, {
        source: slot,
        target:
          operation.targetBindingId === null
            ? undefined
            : context.bindingNodes.get(operation.targetBindingId),
        relation: "destructures",
        resolution:
          operation.resolution === "complete" ? "resolved" : "candidate",
      });
    else
      addSemanticGraphRelation(context.state, {
        source:
          operation.objectBindingId === null
            ? undefined
            : context.bindingNodes.get(operation.objectBindingId),
        target: occurrence,
        relation: "spreads",
        resolution:
          operation.resolution === "complete" ? "resolved" : "candidate",
      });
    if (operation.resolution !== "complete")
      addObjectUnknown(context, operation, slot ?? occurrence);
  }
};

const addObjectOccurrence = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticObjectOperation,
): JavaScriptSemanticGraphNode | null =>
  addSemanticGraphNode(
    context.state,
    constructSemanticGraphNode(
      context.file,
      {
        kind: "expression",
        roleKey: operation.objectOperationId,
        location: operation.location,
        label:
          operation.propertyName === null
            ? operation.kind
            : `${operation.kind}:${operation.propertyName}`,
        functionNodeId:
          operation.ownerCallableId === null
            ? null
            : (context.callableNodes.get(operation.ownerCallableId)?.node_id ??
              null),
        properties: {
          operation_kind: operation.kind,
          property_name: operation.propertyName,
        },
      },
      context.state,
    ),
  );

const addObjectUnknown = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticObjectOperation,
  node: JavaScriptSemanticGraphNode | null,
): void => {
  const relation =
    operation.kind === "read"
      ? "reads-property"
      : operation.kind === "write"
        ? "writes-property"
        : operation.kind === "spread"
          ? "spreads"
          : "destructures";
  addSemanticGraphUnknown(
    context.state,
    createJavaScriptSemanticGraphUnknown({
      node_id: node?.node_id ?? null,
      family: "object-flow",
      relation_kinds: [relation],
      reason: "ambiguous-target",
      detail: `Static ${operation.kind} object identity is partial.`,
      candidate_node_ids: [],
      evidence: unknownSemanticEvidence(context.file, operation.location),
    }),
  );
};
