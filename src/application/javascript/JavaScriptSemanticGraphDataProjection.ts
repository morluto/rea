import { createJavaScriptSemanticGraphUnknown } from "../../domain/javascript/javascriptSemanticGraph.js";
import type { JavaScriptSemanticGraphNode } from "../../domain/javascript/javascriptSemanticGraph.js";
import type {
  JavaScriptSemanticBoundaryOperation,
  JavaScriptSemanticConfigurationOperation,
  JavaScriptSemanticRequestOperation,
} from "../../domain/javascript/javascriptSemanticIr.js";
import {
  addSemanticGraphNode,
  addSemanticGraphRelation,
  addSemanticGraphUnknown,
  constructSemanticGraphNode,
} from "./JavaScriptSemanticGraphConstruction.js";
import { unknownSemanticEvidence } from "./JavaScriptSemanticGraphEvidence.js";
import {
  semanticCallSiteAt,
  type SemanticFlowProjectionContext,
} from "./JavaScriptSemanticGraphFlowProjection.js";

/** Project environment, argv, file, default, and precedence candidates. */
export const projectSemanticConfiguration = (
  context: SemanticFlowProjectionContext,
): void => {
  const configNodes = new Map(
    context.ir.configurationOperations.flatMap((operation) => {
      const node = addConfigurationNode(context, operation);
      return node === null ? [] : [[operation.configId, node] as const];
    }),
  );
  for (const operation of context.ir.configurationOperations) {
    const config = configNodes.get(operation.configId);
    if (config === undefined) continue;
    const target = bindingOrOwner(
      context,
      operation.resultBindingId,
      operation.ownerCallableId,
    );
    addSemanticGraphRelation(context.state, {
      source: config,
      target,
      relation: configurationRelation(operation),
      resolution:
        operation.resolution === "complete" ? "resolved" : "candidate",
    });
    if (operation.kind === "default" && operation.sourceConfigId !== null)
      addSemanticGraphRelation(context.state, {
        source: configNodes.get(operation.sourceConfigId),
        target: config,
        relation: "overrides",
        resolution:
          operation.resolution === "complete" ? "resolved" : "candidate",
      });
    if (operation.resolution !== "complete")
      addDataUnknown({
        context,
        node: config,
        family: "configuration",
        relationKinds: [
          configurationRelation(operation),
          ...(operation.kind === "default" ? (["overrides"] as const) : []),
        ],
        location: operation.location,
        detail: `Static ${operation.kind} configuration identity is partial.`,
        candidateNodeIds: [],
      });
  }
};

const addConfigurationNode = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticConfigurationOperation,
): JavaScriptSemanticGraphNode | null =>
  addSemanticGraphNode(
    context.state,
    constructSemanticGraphNode(
      context.file,
      {
        kind: "config-source",
        roleKey: operation.configId,
        location: operation.location,
        label: operation.key ?? operation.kind,
        functionNodeId:
          operation.ownerCallableId === null
            ? null
            : (context.callableNodes.get(operation.ownerCallableId)?.node_id ??
              null),
        properties: {
          key: operation.key,
          source_kind: operation.kind,
          value: operation.value,
        },
      },
      context.state,
    ),
  );

const configurationRelation = (
  operation: JavaScriptSemanticConfigurationOperation,
): "reads-environment" | "reads-argv" | "reads-config" | "defaults" =>
  operation.kind === "environment"
    ? "reads-environment"
    : operation.kind === "argv"
      ? "reads-argv"
      : operation.kind === "file"
        ? "reads-config"
        : "defaults";

/** Project request construction, field provenance, and response consumers. */
export const projectSemanticRequests = (
  context: SemanticFlowProjectionContext,
): void => {
  const requestNodes = new Map(
    context.ir.requestOperations.flatMap((operation) => {
      const node = addRequestNode(context, operation);
      return node === null ? [] : [[operation.requestId, node] as const];
    }),
  );
  for (const operation of context.ir.requestOperations) {
    const request = requestNodes.get(operation.requestId);
    if (request === undefined) continue;
    if (operation.kind === "request")
      projectRequestConstruction(context, operation, request);
    else projectResponseConsumer(context, operation, request);
    if (operation.resolution !== "complete")
      addDataUnknown({
        context,
        node: request,
        family: "request",
        relationKinds:
          operation.kind === "request"
            ? ["constructs-request", "supplies-request-field"]
            : ["consumed-by"],
        location: operation.location,
        detail: `Static ${operation.method} request resolution was ${operation.resolution}.`,
        candidateNodeIds: operation.linkedRequestIds.flatMap((identifier) => {
          const candidate = requestNodes.get(identifier);
          return candidate === undefined ? [] : [candidate.node_id];
        }),
      });
  }
};

const addRequestNode = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticRequestOperation,
): JavaScriptSemanticGraphNode | null =>
  addSemanticGraphNode(
    context.state,
    constructSemanticGraphNode(
      context.file,
      {
        kind: operation.kind === "request" ? "request" : "response",
        roleKey: operation.requestId,
        location: operation.location,
        label: operation.endpoint ?? operation.method,
        functionNodeId:
          operation.ownerCallableId === null
            ? null
            : (context.callableNodes.get(operation.ownerCallableId)?.node_id ??
              null),
        properties: {
          endpoint: operation.endpoint,
          method: operation.method,
          operation_kind: operation.kind,
        },
      },
      context.state,
    ),
  );

const projectRequestConstruction = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticRequestOperation,
  request: JavaScriptSemanticGraphNode,
): void => {
  const callSite = semanticCallSiteAt(context, operation.location);
  addSemanticGraphRelation(context.state, {
    source: callSite,
    target: request,
    relation: "constructs-request",
    resolution: operation.resolution === "complete" ? "resolved" : "candidate",
  });
  for (const projected of operation.projectedResultBindings)
    addSemanticGraphRelation(context.state, {
      source: request,
      target: context.bindingNodes.get(projected.bindingId),
      relation: "destructures",
      resolution:
        projected.resolution === "complete" ? "resolved" : "candidate",
      properties: {
        projection_path: [...projected.projectionPath],
        projection_resolution: projected.resolution,
      },
    });
  for (const field of operation.fields)
    addSemanticGraphRelation(context.state, {
      source:
        field.sourceBindingId === null
          ? callSite
          : context.bindingNodes.get(field.sourceBindingId),
      target: request,
      relation: "supplies-request-field",
      resolution: field.sourceBindingId === null ? "candidate" : "resolved",
      properties: { field: field.name },
    });
};

const projectResponseConsumer = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticRequestOperation,
  response: JavaScriptSemanticGraphNode,
): void => {
  addSemanticGraphRelation(context.state, {
    source: response,
    target: semanticCallSiteAt(context, operation.location),
    relation: "consumed-by",
    resolution: operation.resolution === "complete" ? "resolved" : "candidate",
    properties: { method: operation.method },
  });
};

/** Project parse, coercion, and validation consumers as static boundaries. */
export const projectSemanticBoundaries = (
  context: SemanticFlowProjectionContext,
): void => {
  for (const operation of context.ir.boundaryOperations) {
    const boundary = addBoundaryNode(context, operation);
    if (boundary === null) continue;
    addSemanticGraphRelation(context.state, {
      source: bindingOrOwner(
        context,
        operation.sourceBindingId,
        operation.ownerCallableId,
      ),
      target: boundary,
      relation:
        operation.kind === "parse"
          ? "parses"
          : operation.kind === "coerce"
            ? "coerces"
            : "validates",
      resolution:
        operation.resolution === "complete" ? "resolved" : "candidate",
    });
    if (operation.resolution !== "complete")
      addDataUnknown({
        context,
        node: boundary,
        family: "boundary",
        relationKinds: [
          operation.kind === "parse"
            ? "parses"
            : operation.kind === "coerce"
              ? "coerces"
              : "validates",
        ],
        location: operation.location,
        detail: `Static ${operation.method} boundary kind is a candidate.`,
        candidateNodeIds: [],
      });
  }
};

const addBoundaryNode = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticBoundaryOperation,
): JavaScriptSemanticGraphNode | null =>
  addSemanticGraphNode(
    context.state,
    constructSemanticGraphNode(
      context.file,
      {
        kind: "boundary",
        roleKey: operation.boundaryId,
        location: operation.location,
        label: operation.method,
        functionNodeId:
          operation.ownerCallableId === null
            ? null
            : (context.callableNodes.get(operation.ownerCallableId)?.node_id ??
              null),
        properties: {
          boundary_kind: operation.kind,
          method: operation.method,
        },
      },
      context.state,
    ),
  );

const bindingOrOwner = (
  context: SemanticFlowProjectionContext,
  bindingId: string | null,
  callableId: string | null,
): JavaScriptSemanticGraphNode =>
  (bindingId === null ? undefined : context.bindingNodes.get(bindingId)) ??
  (callableId === null
    ? context.moduleNode
    : (context.callableNodes.get(callableId) ?? context.moduleNode));

interface DataUnknownInput {
  readonly context: SemanticFlowProjectionContext;
  readonly node: JavaScriptSemanticGraphNode;
  readonly family: "boundary" | "configuration" | "request";
  readonly relationKinds: readonly (
    | "coerces"
    | "constructs-request"
    | "consumed-by"
    | "defaults"
    | "overrides"
    | "parses"
    | "reads-argv"
    | "reads-config"
    | "reads-environment"
    | "supplies-request-field"
    | "validates"
  )[];
  readonly location: JavaScriptSemanticBoundaryOperation["location"];
  readonly detail: string;
  readonly candidateNodeIds: readonly string[];
}

const addDataUnknown = (input: DataUnknownInput): void => {
  const {
    context,
    node,
    family,
    relationKinds,
    location,
    detail,
    candidateNodeIds,
  } = input;
  addSemanticGraphUnknown(
    context.state,
    createJavaScriptSemanticGraphUnknown({
      node_id: node.node_id,
      family,
      relation_kinds: relationKinds,
      reason: "ambiguous-target",
      detail,
      candidate_node_ids: candidateNodeIds,
      evidence: unknownSemanticEvidence(context.file, location),
    }),
  );
};
