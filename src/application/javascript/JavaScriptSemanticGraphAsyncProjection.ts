import { createJavaScriptSemanticGraphUnknown } from "../../domain/javascript/javascriptSemanticGraph.js";
import type { JavaScriptSemanticGraphNode } from "../../domain/javascript/javascriptSemanticGraph.js";
import type {
  JavaScriptSemanticEventOperation,
  JavaScriptSemanticTimerOperation,
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

/** Project literal EventEmitter registrations, removals, and dispatches. */
export const projectSemanticEvents = (
  context: SemanticFlowProjectionContext,
): void => {
  const eventNodes = new Map<string, JavaScriptSemanticGraphNode>();
  for (const operation of context.ir.eventOperations) {
    const eventKey =
      operation.eventName === null
        ? operation.eventId
        : `${operation.emitterKey}\u0000${operation.eventName}`;
    const event =
      eventNodes.get(eventKey) ?? addEventNode(context, operation, eventKey);
    if (event === null) continue;
    eventNodes.set(eventKey, event);
    const relation = eventRelation(operation);
    if (operation.kind === "dispatch")
      addSemanticGraphRelation(context.state, {
        source: eventEmitterNode(context, operation),
        target: event,
        relation,
        resolution:
          operation.resolution === "complete" ? "resolved" : "candidate",
      });
    else {
      const listener = addListenerNode(context, operation);
      addSemanticGraphRelation(context.state, {
        source: event,
        target: listener,
        relation,
        resolution:
          operation.resolution === "complete" ? "resolved" : "candidate",
      });
    }
    if (operation.resolution !== "complete")
      addEventUnknown(context, operation, event, relation);
  }
};

const addEventNode = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticEventOperation,
  eventKey: string,
): JavaScriptSemanticGraphNode | null =>
  addSemanticGraphNode(
    context.state,
    constructSemanticGraphNode(
      context.file,
      {
        kind: "event",
        roleKey: `event:${eventKey}`,
        location: operation.eventName === null ? operation.location : null,
        label: operation.eventName,
        functionNodeId: null,
        properties: {
          emitter_key: operation.emitterKey,
          event_name: operation.eventName,
        },
      },
      context.state,
    ),
  );

const addListenerNode = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticEventOperation,
): JavaScriptSemanticGraphNode | null =>
  addSemanticGraphNode(
    context.state,
    constructSemanticGraphNode(
      context.file,
      {
        kind: "listener",
        roleKey: `listener:${operation.eventId}`,
        location: operation.listenerLocation ?? operation.location,
        label:
          operation.eventName === null
            ? operation.method
            : `${operation.method}:${operation.eventName}`,
        functionNodeId:
          operation.ownerCallableId === null
            ? null
            : (context.callableNodes.get(operation.ownerCallableId)?.node_id ??
              null),
        properties: {
          emitter_key: operation.emitterKey,
          event_name: operation.eventName,
          method: operation.method,
        },
      },
      context.state,
    ),
  );

const eventEmitterNode = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticEventOperation,
): JavaScriptSemanticGraphNode =>
  (operation.emitterBindingId === null
    ? undefined
    : context.bindingNodes.get(operation.emitterBindingId)) ??
  (operation.ownerCallableId === null
    ? context.moduleNode
    : (context.callableNodes.get(operation.ownerCallableId) ??
      context.moduleNode));

const eventRelation = (
  operation: JavaScriptSemanticEventOperation,
): "registers-listener" | "removes-listener" | "dispatches-candidate" =>
  operation.kind === "register"
    ? "registers-listener"
    : operation.kind === "remove"
      ? "removes-listener"
      : "dispatches-candidate";

const addEventUnknown = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticEventOperation,
  event: JavaScriptSemanticGraphNode,
  relation: ReturnType<typeof eventRelation>,
): void => {
  addSemanticGraphUnknown(
    context.state,
    createJavaScriptSemanticGraphUnknown({
      node_id: event.node_id,
      family: "event",
      relation_kinds: [relation],
      reason: "ambiguous-target",
      detail:
        operation.eventName === null
          ? `Dynamic ${operation.method} event name remains unresolved.`
          : `Static ${operation.method} emitter identity is partial.`,
      candidate_node_ids: [],
      evidence: unknownSemanticEvidence(context.file, operation.location),
    }),
  );
};

/** Project Node timer scheduling and exact local handle cancellation. */
export const projectSemanticTimers = (
  context: SemanticFlowProjectionContext,
): void => {
  const timerNodes = new Map(
    context.ir.timerOperations.flatMap((operation) => {
      if (operation.kind !== "schedule") return [];
      const owner =
        operation.ownerCallableId === null
          ? undefined
          : context.callableNodes.get(operation.ownerCallableId);
      const timer = addSemanticGraphNode(
        context.state,
        constructSemanticGraphNode(
          context.file,
          {
            kind: "timer",
            roleKey: operation.timerId,
            location: operation.location,
            label: operation.method,
            functionNodeId: owner?.node_id ?? null,
            properties: {
              delay_milliseconds: operation.delayMilliseconds,
              method: operation.method,
            },
          },
          context.state,
        ),
      );
      return timer === null ? [] : [[operation.timerId, timer] as const];
    }),
  );
  for (const operation of context.ir.timerOperations)
    if (operation.kind === "schedule")
      projectTimerSchedule(context, operation, timerNodes);
    else projectTimerCancellation(context, operation, timerNodes);
};

const projectTimerSchedule = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticTimerOperation,
  timerNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
): void => {
  addSemanticGraphRelation(context.state, {
    source: semanticCallSiteAt(context, operation.location),
    target: timerNodes.get(operation.timerId),
    relation: "schedules-timer",
    resolution: "resolved",
  });
  for (const projected of operation.projectedResultBindings)
    addSemanticGraphRelation(context.state, {
      source: timerNodes.get(operation.timerId),
      target: context.bindingNodes.get(projected.bindingId),
      relation: "destructures",
      resolution:
        projected.resolution === "complete" ? "resolved" : "candidate",
      properties: {
        projection_path: [...projected.projectionPath],
        projection_resolution: projected.resolution,
      },
    });
};

const projectTimerCancellation = (
  context: SemanticFlowProjectionContext,
  operation: JavaScriptSemanticTimerOperation,
  timerNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
): void => {
  const callSite = semanticCallSiteAt(context, operation.location);
  const target =
    operation.linkedTimerId === null
      ? undefined
      : timerNodes.get(operation.linkedTimerId);
  addSemanticGraphRelation(context.state, {
    source: callSite,
    target,
    relation: "cancels-timer",
    resolution: operation.resolution === "complete" ? "resolved" : "candidate",
  });
  if (operation.resolution === "complete") return;
  addSemanticGraphUnknown(
    context.state,
    createJavaScriptSemanticGraphUnknown({
      node_id: callSite?.node_id ?? null,
      family: "timer",
      relation_kinds: ["cancels-timer"],
      reason: "ambiguous-target",
      detail: `Static ${operation.method} handle resolution was ${operation.resolution}.`,
      candidate_node_ids: [],
      evidence: unknownSemanticEvidence(context.file, operation.location),
    }),
  );
};
