import {
  createJavaScriptSemanticGraph,
  type JavaScriptSemanticGraph,
  type JavaScriptSemanticGraphNode,
} from "../domain/javascriptSemanticGraph.js";
import {
  JAVASCRIPT_SEMANTIC_RELATION_FAMILIES,
  JAVASCRIPT_SEMANTIC_RELATION_FAMILY,
} from "../domain/javascriptSemanticGraphSchemas.js";
import type {
  JavaScriptSemanticCallArgument,
  JavaScriptSemanticIr,
} from "../domain/javascriptSemanticIr.js";
import type { JavaScriptApplicationGraph } from "../domain/javascriptApplicationGraph.js";
import type { JavaScriptArtifactAnalysis } from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";
import { inferredSemanticEvidenceAt } from "./JavaScriptSemanticGraphEvidence.js";
import {
  projectSemanticClosureCaptures,
  projectSemanticFrontiers,
  projectSemanticReturnValues,
  semanticRecoveryLimits,
  type SemanticFlowProjectionContext,
} from "./JavaScriptSemanticGraphFlowProjection.js";
import {
  owningSemanticCallableNode,
  semanticFamilyStatus,
  semanticNodesWithinRange,
  semanticRangesEqual as rangesEqual,
} from "./JavaScriptSemanticGraphProjection.js";
import {
  addSemanticFallbackRoot as addFallbackRoot,
  addSemanticGraphNode as addNode,
  addSemanticGraphRelation as addRelation,
  constructSemanticGraphNode as semanticNode,
  createSemanticGraphProjectionState as emptyState,
  MAX_APPLICATION_NODE_IDS_PER_SEMANTIC_NODE,
  MAX_SEMANTIC_GRAPH_NODES,
  MAX_SEMANTIC_GRAPH_RELATIONS,
  MAX_SEMANTIC_GRAPH_UNKNOWNS,
  type SemanticGraphProjectionState as BuilderState,
} from "./JavaScriptSemanticGraphConstruction.js";

interface BuilderInput {
  readonly rootArtifactSha256: string;
  readonly applicationGraph: Pick<
    JavaScriptApplicationGraph,
    "graph_id" | "nodes"
  >;
  readonly analysis: JavaScriptArtifactAnalysis;
}

interface FileContext extends SemanticFlowProjectionContext {
  readonly file: JavaScriptArtifactFile;
  readonly ir: JavaScriptSemanticIr;
  readonly state: BuilderState;
  readonly moduleNode: JavaScriptSemanticGraphNode;
  readonly bindingNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>;
  readonly callableNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>;
  readonly callSiteNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>;
  readonly returnSiteNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>;
  readonly argumentNodes: Map<string, JavaScriptSemanticGraphNode>;
  readonly referenceNodes: JavaScriptSemanticGraphNode[];
  readonly callResolutions: ReadonlyMap<string, "candidate" | "resolved">;
}

/** Project bounded per-file semantic IR into an artifact-bound companion graph. */
export const buildJavaScriptSemanticGraph = ({
  rootArtifactSha256,
  applicationGraph,
  analysis,
}: BuilderInput): JavaScriptSemanticGraph => {
  const state = emptyState(applicationGraph);
  for (const analyzed of analysis.files) {
    if (analyzed.semantic === null) continue;
    projectFile(analyzed.file, analyzed.semantic.ir, state);
  }
  if (state.roots.size === 0) addFallbackRoot(rootArtifactSha256, state);
  const semanticTruncated = analysis.files.some(
    ({ semantic }) => semantic?.ir.coverage.status === "truncated",
  );
  const truncated = state.limitsReached.size > 0 || semanticTruncated;
  const unknowns = [...state.unknowns.values()];
  return createJavaScriptSemanticGraph({
    schema: "JavaScriptSemanticRelationGraph",
    schema_version: 1,
    root_artifact_sha256: rootArtifactSha256,
    application_graph_id: applicationGraph.graph_id,
    root_node_ids: [...state.roots],
    nodes: [...state.nodes.values()],
    relations: [...state.relations.values()],
    fingerprints: [],
    unknowns,
    coverage: {
      status: truncated ? "partial" : "unknown",
      truncated,
      omitted_nodes: truncated ? null : 0,
      omitted_relations: truncated ? null : 0,
      limits: [
        {
          name: "max_nodes",
          value: MAX_SEMANTIC_GRAPH_NODES,
          unit: "items",
        },
        {
          name: "max_relations",
          value: MAX_SEMANTIC_GRAPH_RELATIONS,
          unit: "items",
        },
        {
          name: "max_unknowns",
          value: MAX_SEMANTIC_GRAPH_UNKNOWNS,
          unit: "items",
        },
        {
          name: "max_application_node_ids_per_semantic_node",
          value: MAX_APPLICATION_NODE_IDS_PER_SEMANTIC_NODE,
          unit: "items",
        },
        ...semanticRecoveryLimits(analysis),
      ],
      families: JAVASCRIPT_SEMANTIC_RELATION_FAMILIES.map((family) => ({
        family,
        status: semanticFamilyStatus(family, analysis, truncated),
        retained_relations: [...state.relations.values()].filter(
          (relation) =>
            JAVASCRIPT_SEMANTIC_RELATION_FAMILY[relation.relation] === family,
        ).length,
        omitted_relations: truncated ? null : 0,
        unknown_ids: unknowns
          .filter((unknown) => unknown.family === family)
          .map(({ unknown_id: identifier }) => identifier),
      })),
    },
    limitations: [
      "The semantic graph contains static syntax observations and conservative relationship candidates; it does not claim runtime execution.",
      "Local data flow does not claim control-flow-sensitive reaching definitions or arbitrary dynamic property resolution.",
      "Function fingerprints and promise, event, process, request, boundary, timer, configuration, and resource extraction are not available in this graph version's current extractor coverage.",
      ...(truncated
        ? [
            "Semantic graph projection reached one or more explicit hard limits.",
          ]
        : []),
    ],
  });
};

const projectFile = (
  file: JavaScriptArtifactFile,
  ir: JavaScriptSemanticIr,
  state: BuilderState,
): void => {
  const moduleNode = addNode(
    state,
    semanticNode(
      file,
      {
        kind: "module",
        roleKey: "module",
        location: null,
        label: file.path,
        functionNodeId: null,
      },
      state,
    ),
  );
  if (moduleNode === null) return;
  state.roots.add(moduleNode.node_id);
  const callableNodes = new Map(
    ir.callables.flatMap((callable) => {
      const node = addNode(
        state,
        semanticNode(
          file,
          {
            kind: "function",
            roleKey: `callable:${callable.callableId}`,
            location: callable.location,
            label: callable.name,
            functionNodeId: null,
          },
          state,
        ),
      );
      return node === null ? [] : [[callable.callableId, node] as const];
    }),
  );
  const bindingNodes = new Map(
    ir.bindings.flatMap((binding) => {
      const location = binding.definitions[0]?.location ?? null;
      const kind = binding.kind === "parameter" ? "parameter" : "binding";
      const owner = owningSemanticCallableNode(location, ir, callableNodes);
      const node = addNode(
        state,
        semanticNode(
          file,
          {
            kind,
            roleKey: `binding:${binding.bindingId}`,
            location,
            label: binding.name,
            functionNodeId: owner?.node_id ?? null,
          },
          state,
        ),
      );
      return node === null ? [] : [[binding.bindingId, node] as const];
    }),
  );
  const returnSiteNodes = createReturnSiteNodes(file, ir, callableNodes, state);
  const callSiteNodes = createCallSiteNodes(file, ir, callableNodes, state);
  const context: FileContext = {
    file,
    ir,
    state,
    moduleNode,
    bindingNodes,
    callableNodes,
    callSiteNodes,
    returnSiteNodes,
    argumentNodes: new Map(),
    referenceNodes: [],
    callResolutions: new Map(
      ir.callSites.map((call) => [
        call.callSiteId,
        call.resolution === "exact" ? "resolved" : "candidate",
      ]),
    ),
  };
  projectDefinitionsAndReferences(context);
  projectCalls(context);
  projectSemanticClosureCaptures(context);
  projectSemanticFrontiers(context);
};

const createReturnSiteNodes = (
  file: JavaScriptArtifactFile,
  ir: JavaScriptSemanticIr,
  callables: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  state: BuilderState,
): Map<string, JavaScriptSemanticGraphNode> => {
  const result = new Map<string, JavaScriptSemanticGraphNode>();
  for (const callable of ir.callables) {
    const owner = callables.get(callable.callableId);
    if (owner === undefined) continue;
    for (const site of callable.returnSites) {
      const identifier = site.returnSiteId;
      const node = addNode(
        state,
        semanticNode(
          file,
          {
            kind: "return-site",
            roleKey: identifier,
            location: site.location,
            label: "return",
            functionNodeId: owner.node_id,
          },
          state,
        ),
      );
      if (node !== null) result.set(identifier, node);
    }
  }
  return result;
};

const createCallSiteNodes = (
  file: JavaScriptArtifactFile,
  ir: JavaScriptSemanticIr,
  callables: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  state: BuilderState,
): Map<string, JavaScriptSemanticGraphNode> => {
  const result = new Map<string, JavaScriptSemanticGraphNode>();
  for (const call of ir.callSites) {
    const owner =
      call.callerCallableId === null
        ? null
        : (callables.get(call.callerCallableId)?.node_id ?? null);
    const node = addNode(
      state,
      semanticNode(
        file,
        {
          kind: "call-site",
          roleKey: `call:${call.callSiteId}`,
          location: call.location,
          label: call.kind,
          functionNodeId: owner,
        },
        state,
      ),
    );
    if (node !== null) result.set(call.callSiteId, node);
  }
  return result;
};

const projectDefinitionsAndReferences = (context: FileContext): void => {
  for (const binding of context.ir.bindings) {
    const bindingNode = context.bindingNodes.get(binding.bindingId);
    if (bindingNode === undefined) continue;
    for (const [index, definition] of binding.definitions.entries()) {
      const definitionNode = addNode(
        context.state,
        semanticNode(
          context.file,
          {
            kind: "expression",
            roleKey: `definition:${binding.bindingId}:${String(index)}`,
            location: definition.location,
            label: definition.kind,
            functionNodeId: bindingNode.function_node_id,
          },
          context.state,
        ),
      );
      addRelation(context.state, {
        source: definitionNode,
        target: bindingNode,
        relation: "defines",
        resolution: "resolved",
      });
    }
  }
  for (const [index, reference] of context.ir.references.entries()) {
    const expression = addNode(
      context.state,
      semanticNode(
        context.file,
        {
          kind: "expression",
          roleKey: `reference:${String(index)}:${reference.role}:${reference.name}`,
          location: reference.location,
          label: reference.name,
          functionNodeId:
            owningSemanticCallableNode(
              reference.location,
              context.ir,
              context.callableNodes,
            )?.node_id ?? null,
        },
        context.state,
      ),
    );
    const binding =
      reference.bindingId === null
        ? undefined
        : context.bindingNodes.get(reference.bindingId);
    if (expression !== null) context.referenceNodes.push(expression);
    if (binding === undefined || expression === null) continue;
    if (reference.role === "read")
      addRelation(context.state, {
        source: binding,
        target: expression,
        relation: "reads",
        resolution: "resolved",
        evidence: inferredSemanticEvidenceAt(context.file, reference.location),
      });
    else
      addRelation(context.state, {
        source: expression,
        target: binding,
        relation: "writes",
        resolution: "resolved",
      });
  }
};

const projectCalls = (context: FileContext): void => {
  for (const call of context.ir.callSites) {
    const callNode = context.callSiteNodes.get(call.callSiteId);
    if (callNode === undefined) continue;
    for (const callableId of call.calleeCallableIds) {
      const callable = context.callableNodes.get(callableId);
      addRelation(context.state, {
        source: callNode,
        target: callable,
        relation: "calls",
        resolution: call.resolution === "exact" ? "resolved" : "candidate",
      });
    }
    for (const argument of call.arguments) {
      const argumentNode = createArgumentNode(
        context,
        callNode,
        call.callSiteId,
        argument,
      );
      if (argumentNode !== null)
        context.argumentNodes.set(
          `${call.callSiteId}\u0000${String(argument.index)}`,
          argumentNode,
        );
      const references = semanticNodesWithinRange(
        context.referenceNodes,
        argument.location,
      );
      for (const reference of references)
        addRelation(context.state, {
          source: reference,
          target: argumentNode,
          relation: "aliases",
          resolution:
            references.length === 1 &&
            rangesEqual(reference.identity.source_range, argument.location)
              ? "resolved"
              : "candidate",
        });
    }
  }
  for (const flow of context.ir.argumentFlows) {
    const argument = context.argumentNodes.get(
      `${flow.callSiteId}\u0000${String(flow.argumentIndex)}`,
    );
    const parameter = context.bindingNodes.get(flow.parameterBindingId);
    addRelation(context.state, {
      source: argument,
      target: parameter,
      relation: "argument-to-parameter",
      resolution: context.callResolutions.get(flow.callSiteId) ?? "candidate",
    });
  }
  for (const flow of context.ir.callReturnFlows)
    addRelation(context.state, {
      source: context.returnSiteNodes.get(flow.returnSiteId),
      target: context.callSiteNodes.get(flow.callSiteId),
      relation: "returns-to-call",
      resolution: context.callResolutions.get(flow.callSiteId) ?? "candidate",
    });
  for (const flow of context.ir.callResultFlows)
    addRelation(context.state, {
      source: context.callSiteNodes.get(flow.callSiteId),
      target: context.bindingNodes.get(flow.bindingId),
      relation: "aliases",
      resolution: context.callResolutions.get(flow.callSiteId) ?? "candidate",
    });
  projectSemanticReturnValues(context);
};

const createArgumentNode = (
  context: FileContext,
  callNode: JavaScriptSemanticGraphNode,
  callSiteId: string,
  argument: JavaScriptSemanticCallArgument,
): JavaScriptSemanticGraphNode | null =>
  addNode(
    context.state,
    semanticNode(
      context.file,
      {
        kind: "expression",
        roleKey: `argument:${callSiteId}:${String(argument.index)}`,
        location: argument.location,
        label: argument.spread
          ? "spread argument"
          : `argument ${String(argument.index)}`,
        functionNodeId: callNode.function_node_id,
      },
      context.state,
    ),
  );
