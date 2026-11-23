import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type { JavaScriptSemanticGraph } from "./javascriptSemanticGraph.js";
import {
  buildSemanticAdjacency,
  getSemanticGraphIndex,
  type SemanticAdjacency,
  type SemanticGraphIndex,
} from "./javascriptSemanticGraphIndex.js";
import type {
  JavaScriptSemanticEvidenceContext,
  JavaScriptSemanticGraphNode,
  JavaScriptSemanticGraphRelation,
  JavaScriptSemanticGraphUnknown,
} from "./javascriptSemanticGraphSchemas.js";
import { isJavaScriptSemanticOwnershipRelation as ownershipRelation } from "./javascriptSemanticQueryRelations.js";
import {
  javaScriptSemanticQueryResultSchema,
  type JavaScriptSemanticQueryInput,
  type JavaScriptSemanticQueryResult,
} from "./javascriptSemanticQuerySchemas.js";
import { assessJavaScriptSemanticQuery } from "./javascriptSemanticQueryAssessment.js";
import {
  javaScriptSemanticQueryIdentifier as queryIdentifier,
  resolveJavaScriptSemanticQuerySeeds as resolveSeeds,
} from "./javascriptSemanticQueryIdentity.js";

interface Traversal {
  readonly nodeIds: Set<string>;
  readonly retainedNodes: JavaScriptSemanticGraphNode[];
  readonly retainedRelations: JavaScriptSemanticGraphRelation[];
  readonly functionIds: Set<string>;
  readonly modules: Set<string>;
  readonly candidateRelations: number;
}

/** Run a query already parsed by its owning request boundary. */
export const queryJavaScriptSemanticGraph = (
  graph: JavaScriptSemanticGraph,
  input: JavaScriptSemanticQueryInput,
): JavaScriptSemanticQueryResult => {
  const queryId = queryIdentifier(graph, input);
  const seeds = resolveSeeds(graph, input);
  const index = getSemanticGraphIndex(graph);
  const allowed =
    input.allowed_relations === undefined
      ? null
      : new Set(input.allowed_relations);
  if (seeds.length === 0)
    return buildEmptySeedQueryResult(graph, input, queryId, index, allowed);

  const nodes =
    index !== undefined
      ? index.getNodesById()
      : new Map(graph.nodes.map((node) => [node.node_id, node]));
  const adjacency =
    index !== undefined
      ? index.getAdjacency()
      : buildSemanticAdjacency(graph.relations);
  const traversal = traverse(nodes, seeds, adjacency, input, allowed);
  const relevantUnknowns = relevantUnknownFrontiers(
    graph,
    traversal.nodeIds,
    input.direction,
    allowed,
    index,
  );
  const expectedMatches = expectedMatchesFor(
    traversal.retainedNodes,
    traversal.retainedRelations,
    input,
  );
  const retainedContextIds = collectContextIds(
    traversal.retainedNodes,
    traversal.retainedRelations,
    relevantUnknowns,
  );
  const evidenceContexts = selectEvidenceContexts(
    graph,
    retainedContextIds,
    index,
  );
  const assessment = assessJavaScriptSemanticQuery({
    graph,
    totalSeeds: seeds.length,
    expectedMatches: expectedMatches.length,
    hasExpectation: input.expected !== null,
    unknowns: relevantUnknowns,
    candidateRelations: traversal.candidateRelations,
  });
  return javaScriptSemanticQueryResultSchema.parse({
    query_id: queryId,
    source_graph_id: graph.graph_id,
    seed: input.seed,
    direction: input.direction,
    status: assessment.status,
    seed_node_ids: seeds,
    evidence_contexts: evidenceContexts,
    nodes: traversal.retainedNodes,
    relations: traversal.retainedRelations,
    unknowns: relevantUnknowns,
    expected_match_node_ids: expectedMatches.map(({ node_id }) => node_id),
    summary: {
      total_seed_matches: seeds.length,
      traversed_nodes: traversal.nodeIds.size,
      traversed_relations: traversal.retainedRelations.length,
      traversed_functions: traversal.functionIds.size,
      traversed_modules: traversal.modules.size,
      relevant_unknowns: relevantUnknowns.length,
    },
    coverage: assessment.coverage,
    limitations: assessment.limitations,
  });
};

const buildEmptySeedQueryResult = (
  graph: JavaScriptSemanticGraph,
  input: JavaScriptSemanticQueryInput,
  queryId: string,
  index: SemanticGraphIndex | undefined,
  allowed: ReadonlySet<JavaScriptSemanticGraphRelation["relation"]> | null,
): JavaScriptSemanticQueryResult => {
  const globalUnknowns =
    index !== undefined
      ? index.getGlobalUnknowns()
      : graph.unknowns.filter((unknown) => unknown.node_id === null);
  const relevantUnknowns = globalUnknowns.filter((unknown) =>
    unknownMatchesFilter(unknown, input.direction, allowed),
  );
  const evidenceContexts =
    relevantUnknowns.length === 0
      ? []
      : selectEvidenceContexts(
          graph,
          collectContextIds([], [], relevantUnknowns),
          index,
        );
  const assessment = assessJavaScriptSemanticQuery({
    graph,
    totalSeeds: 0,
    expectedMatches: 0,
    hasExpectation: input.expected !== null,
    unknowns: relevantUnknowns,
    candidateRelations: 0,
  });
  return javaScriptSemanticQueryResultSchema.parse({
    query_id: queryId,
    source_graph_id: graph.graph_id,
    seed: input.seed,
    direction: input.direction,
    status: assessment.status,
    seed_node_ids: [],
    evidence_contexts: evidenceContexts,
    nodes: [],
    relations: [],
    unknowns: relevantUnknowns,
    expected_match_node_ids: [],
    summary: {
      total_seed_matches: 0,
      traversed_nodes: 0,
      traversed_relations: 0,
      traversed_functions: 0,
      traversed_modules: 0,
      relevant_unknowns: relevantUnknowns.length,
    },
    coverage: assessment.coverage,
    limitations: assessment.limitations,
  });
};

const traverse = (
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  seeds: readonly string[],
  adjacency: SemanticAdjacency,
  input: JavaScriptSemanticQueryInput,
  allowed: ReadonlySet<JavaScriptSemanticGraphRelation["relation"]> | null,
): Traversal => {
  const nodeIds = new Set(seeds);
  const retainedNodes: JavaScriptSemanticGraphNode[] = [];
  const retainedRelationsMap = new Map<
    string,
    JavaScriptSemanticGraphRelation
  >();
  const functionIds = new Set<string>();
  const modules = new Set<string>();
  const queue = [...nodeIds];
  for (const nodeId of nodeIds) {
    const node = nodes.get(nodeId);
    if (node !== undefined) {
      retainedNodes.push(node);
      retainOwners(node, functionIds, modules);
    }
  }
  const direction = input.direction;
  const includeCandidates = input.include_ambiguous_dynamic_edges;
  const seenCandidateIds =
    direction === "ownership" ? new Set<string>() : undefined;
  let candidateRelations = 0;

  const visitIncident = (
    relation: JavaScriptSemanticGraphRelation,
    nextNodeId: string,
  ): void => {
    if (allowed !== null && !allowed.has(relation.relation)) return;
    if (relation.resolution === "candidate") {
      if (seenCandidateIds === undefined) candidateRelations += 1;
      else if (!seenCandidateIds.has(relation.relation_id)) {
        seenCandidateIds.add(relation.relation_id);
        candidateRelations += 1;
      }
      if (!includeCandidates) return;
    }
    retainedRelationsMap.set(relation.relation_id, relation);
    if (nodeIds.has(nextNodeId)) return;
    const nextNode = nodes.get(nextNodeId);
    if (nextNode === undefined) return;
    nodeIds.add(nextNodeId);
    retainedNodes.push(nextNode);
    retainOwners(nextNode, functionIds, modules);
    queue.push(nextNodeId);
  };

  for (let offset = 0; offset < queue.length; offset += 1) {
    const current = queue[offset];
    if (current === undefined) continue;
    if (direction === "forward-influence") {
      for (const relation of adjacency.outgoingByNode.get(current) ?? [])
        visitIncident(relation, relation.target_node_id);
    } else if (direction === "backward-provenance") {
      for (const relation of adjacency.incomingByNode.get(current) ?? [])
        visitIncident(relation, relation.source_node_id);
    } else if (direction === "callers") {
      for (const relation of adjacency.incomingByNode.get(current) ?? [])
        if (relation.relation === "calls")
          visitIncident(relation, relation.source_node_id);
    } else {
      for (const relation of adjacency.outgoingByNode.get(current) ?? [])
        if (ownershipRelation(relation.relation))
          visitIncident(relation, relation.target_node_id);
      for (const relation of adjacency.incomingByNode.get(current) ?? [])
        if (ownershipRelation(relation.relation))
          visitIncident(relation, relation.source_node_id);
    }
  }

  if (retainedNodes.length > 1)
    retainedNodes.sort((left, right) =>
      compareUnicodeCodePoints(left.node_id, right.node_id),
    );
  const retainedRelations = [...retainedRelationsMap.values()];
  if (retainedRelations.length > 1)
    retainedRelations.sort((left, right) =>
      compareUnicodeCodePoints(left.relation_id, right.relation_id),
    );
  return {
    nodeIds,
    retainedNodes,
    retainedRelations,
    functionIds,
    modules,
    candidateRelations,
  };
};

const retainOwners = (
  node: JavaScriptSemanticGraphNode,
  functions: Set<string>,
  modules: Set<string>,
): void => {
  const functionId =
    node.kind === "function" ? node.node_id : node.function_node_id;
  if (functionId !== null) functions.add(functionId);
  modules.add(node.identity.module_path);
};

const unknownMatchesFilter = (
  unknown: JavaScriptSemanticGraphUnknown,
  direction: JavaScriptSemanticQueryInput["direction"],
  allowed: ReadonlySet<JavaScriptSemanticGraphRelation["relation"]> | null,
): boolean =>
  unknown.relation_kinds.some(
    (relation) =>
      directionAllowsRelation(direction, relation) &&
      (allowed === null || allowed.has(relation)),
  );

const relevantUnknownFrontiers = (
  graph: JavaScriptSemanticGraph,
  nodeIds: ReadonlySet<string>,
  direction: JavaScriptSemanticQueryInput["direction"],
  allowed: ReadonlySet<JavaScriptSemanticGraphRelation["relation"]> | null,
  index: SemanticGraphIndex | undefined,
): JavaScriptSemanticGraphUnknown[] => {
  if (index === undefined)
    return graph.unknowns.filter(
      (unknown) =>
        (unknown.node_id === null || nodeIds.has(unknown.node_id)) &&
        unknownMatchesFilter(unknown, direction, allowed),
    );
  const unknownsIndex = index.getUnknowns();
  const retained: JavaScriptSemanticGraphUnknown[] = [];
  for (const unknown of unknownsIndex.global)
    if (unknownMatchesFilter(unknown, direction, allowed))
      retained.push(unknown);
  for (const nodeId of nodeIds) {
    for (const unknown of unknownsIndex.byNodeId.get(nodeId) ?? [])
      if (unknownMatchesFilter(unknown, direction, allowed))
        retained.push(unknown);
  }
  if (retained.length > 1)
    retained.sort((left, right) =>
      compareUnicodeCodePoints(left.unknown_id, right.unknown_id),
    );
  return retained;
};

const directionAllowsRelation = (
  direction: JavaScriptSemanticQueryInput["direction"],
  relation: JavaScriptSemanticGraphRelation["relation"],
): boolean =>
  direction === "callers"
    ? relation === "calls"
    : direction === "ownership"
      ? ownershipRelation(relation)
      : true;

const collectContextIds = (
  nodes: readonly JavaScriptSemanticGraphNode[],
  relations: readonly JavaScriptSemanticGraphRelation[],
  unknowns: readonly JavaScriptSemanticGraphUnknown[],
): Set<string> => {
  const ids = new Set<string>();
  for (const node of nodes) ids.add(node.evidence.context_id);
  for (const relation of relations) ids.add(relation.evidence.context_id);
  for (const unknown of unknowns) ids.add(unknown.evidence.context_id);
  return ids;
};

const selectEvidenceContexts = (
  graph: JavaScriptSemanticGraph,
  contextIds: ReadonlySet<string>,
  index: SemanticGraphIndex | undefined,
): JavaScriptSemanticEvidenceContext[] => {
  if (contextIds.size === 0) return [];
  if (index === undefined)
    return graph.evidence_contexts.filter(({ context_id }) =>
      contextIds.has(context_id),
    );
  const contextsById = index.getContextsById();
  const retained: JavaScriptSemanticEvidenceContext[] = [];
  for (const contextId of contextIds) {
    const context = contextsById.get(contextId);
    if (context !== undefined) retained.push(context);
  }
  if (retained.length > 1)
    retained.sort((left, right) =>
      compareUnicodeCodePoints(left.context_id, right.context_id),
    );
  return retained;
};

const expectedMatchesFor = (
  nodes: readonly JavaScriptSemanticGraphNode[],
  relations: readonly JavaScriptSemanticGraphRelation[],
  input: JavaScriptSemanticQueryInput,
): JavaScriptSemanticGraphNode[] => {
  if (input.expected === null) return [];
  const classes = new Set(input.expected.classes);
  const connected = new Set(
    relations.map((relation) =>
      input.expected?.role === "source"
        ? relation.target_node_id
        : relation.source_node_id,
    ),
  );
  return nodes.filter(
    ({ kind, node_id }) => classes.has(kind) && !connected.has(node_id),
  );
};
