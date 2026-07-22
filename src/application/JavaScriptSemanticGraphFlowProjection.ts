import { createJavaScriptSemanticGraphUnknown } from "../domain/javascriptSemanticGraph.js";
import type { JavaScriptSemanticGraphNode } from "../domain/javascriptSemanticGraph.js";
import type { JavaScriptSemanticIr } from "../domain/javascriptSemanticIr.js";
import type { JavaScriptArtifactAnalysis } from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";
import {
  addSemanticGraphRelation,
  addSemanticGraphUnknown,
  type SemanticGraphProjectionState,
} from "./JavaScriptSemanticGraphConstruction.js";
import {
  inferredSemanticEvidenceAt,
  unknownSemanticEvidence,
} from "./JavaScriptSemanticGraphEvidence.js";
import { semanticNodesWithinRange } from "./JavaScriptSemanticGraphProjection.js";

/** File-local graph state needed by return, capture, and frontier projection. */
export interface SemanticFlowProjectionContext {
  readonly file: JavaScriptArtifactFile;
  readonly ir: JavaScriptSemanticIr;
  readonly state: SemanticGraphProjectionState;
  readonly moduleNode: JavaScriptSemanticGraphNode;
  readonly bindingNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>;
  readonly callableNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>;
  readonly returnSiteNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>;
  readonly referenceNodes: readonly JavaScriptSemanticGraphNode[];
}

/** Link direct return expressions to their retained semantic references. */
export const projectSemanticReturnValues = (
  context: SemanticFlowProjectionContext,
): void => {
  for (const callable of context.ir.callables)
    for (const site of callable.returnSites) {
      const returnNode = context.returnSiteNodes.get(site.returnSiteId);
      const references = semanticNodesWithinRange(
        context.referenceNodes,
        site.location,
      );
      for (const reference of references)
        addSemanticGraphRelation(context.state, {
          source: reference,
          target: returnNode,
          relation: "aliases",
          resolution:
            site.identityReferenceLocation !== null &&
            rangesEqual(
              reference.identity.source_range,
              site.identityReferenceLocation,
            )
              ? "resolved"
              : "candidate",
        });
    }
};

const rangesEqual = (
  left: JavaScriptSemanticGraphNode["identity"]["source_range"],
  right: JavaScriptSemanticGraphNode["identity"]["source_range"],
): boolean =>
  left !== null &&
  right !== null &&
  left.start.line === right.start.line &&
  left.start.column === right.start.column &&
  left.end.line === right.end.line &&
  left.end.column === right.end.column;

/** Link each captured binding to the callable at the exact reference site. */
export const projectSemanticClosureCaptures = (
  context: SemanticFlowProjectionContext,
): void => {
  for (const capture of context.ir.closureCaptures)
    addSemanticGraphRelation(context.state, {
      source: context.bindingNodes.get(capture.bindingId),
      target: context.callableNodes.get(capture.callableId),
      relation: "captures",
      resolution: "resolved",
      evidence: inferredSemanticEvidenceAt(
        context.file,
        capture.referenceLocation,
      ),
    });
};

/** Retain bounded unresolved dynamic-call and dynamic-property frontiers. */
export const projectSemanticFrontiers = (
  context: SemanticFlowProjectionContext,
): void => {
  for (const frontier of context.ir.frontiers) {
    const unknown = createJavaScriptSemanticGraphUnknown({
      node_id:
        frontier.callableId === null
          ? context.moduleNode.node_id
          : (context.callableNodes.get(frontier.callableId)?.node_id ??
            context.moduleNode.node_id),
      family: frontier.kind === "dynamic-call" ? "call-flow" : "object-flow",
      relation_kinds:
        frontier.kind === "dynamic-call"
          ? ["calls"]
          : ["reads-property", "writes-property"],
      reason: frontier.kind,
      detail: frontier.reason,
      candidate_node_ids: [],
      evidence: unknownSemanticEvidence(context.file, frontier.location),
    });
    addSemanticGraphUnknown(context.state, unknown);
  }
};

/** Publish exact semantic analyzer limits reached by any admitted source file. */
export const semanticRecoveryLimits = (
  analysis: JavaScriptArtifactAnalysis,
): {
  readonly name: string;
  readonly value: number;
  readonly unit: "items";
}[] => {
  const limits = new Map<string, number>();
  for (const { semantic } of analysis.files) {
    if (semantic === null) continue;
    for (const name of semantic.ir.coverage.limitsReached)
      limits.set(`semantic.${name}`, semantic.limits[name]);
  }
  return [...limits]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value, unit: "items" }));
};
