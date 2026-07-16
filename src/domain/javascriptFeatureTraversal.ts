import {
  compareCodePoints,
  type ApplicationEdge,
  type ApplicationNode,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import type { TraceApplicationFeatureInput } from "./javascriptFeatureTraceSchemas.js";

interface AdjacencyEntry {
  readonly edge: ApplicationEdge;
  readonly nextNodeId: string;
}

interface Predecessor {
  readonly previousNodeId: string;
  readonly edgeId: string;
}

/** Bounded graph projection plus the first deterministic path to each node. */
export interface ApplicationFeatureTraversal {
  readonly nodes: ApplicationNode[];
  readonly edges: ApplicationEdge[];
  readonly depths: ReadonlyMap<string, number>;
  readonly predecessors: ReadonlyMap<string, Predecessor>;
  readonly frontierNodeIds: string[];
  readonly omittedNodeCount: number;
  readonly omittedEdgeCount: number;
}

/** Traverse a JAG without treating edge inference as observed reachability. */
export const traverseApplicationFeature = (
  graph: JavaScriptApplicationGraph,
  seedNodeIds: readonly string[],
  direction: TraceApplicationFeatureInput["direction"],
  limits: TraceApplicationFeatureInput["limits"],
): ApplicationFeatureTraversal => {
  const nodeById = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const adjacency = buildAdjacency(graph.edges, direction);
  const visited = new Set(seedNodeIds);
  const retainedEdges = new Map<string, ApplicationEdge>();
  const omittedNodes = new Set<string>();
  const omittedEdges = new Set<string>();
  const frontier = new Set<string>();
  const depths = new Map(seedNodeIds.map((nodeId) => [nodeId, 0]));
  const predecessors = new Map<string, Predecessor>();
  const queue = [...seedNodeIds];
  for (let offset = 0; offset < queue.length; offset += 1) {
    const current = queue[offset];
    if (current === undefined) continue;
    const depth = depths.get(current) ?? 0;
    for (const entry of adjacency.get(current) ?? []) {
      if (depth >= limits.max_depth) {
        recordOmission(entry, current, omittedNodes, omittedEdges, frontier);
        continue;
      }
      if (!visited.has(entry.nextNodeId) && visited.size >= limits.max_nodes) {
        recordOmission(entry, current, omittedNodes, omittedEdges, frontier);
        continue;
      }
      if (
        !retainedEdges.has(entry.edge.edge_id) &&
        retainedEdges.size >= limits.max_edges
      ) {
        omittedEdges.add(entry.edge.edge_id);
        frontier.add(current);
        frontier.add(entry.nextNodeId);
        continue;
      }
      retainedEdges.set(entry.edge.edge_id, entry.edge);
      if (visited.has(entry.nextNodeId)) continue;
      if (!nodeById.has(entry.nextNodeId)) continue;
      visited.add(entry.nextNodeId);
      depths.set(entry.nextNodeId, depth + 1);
      predecessors.set(entry.nextNodeId, {
        previousNodeId: current,
        edgeId: entry.edge.edge_id,
      });
      queue.push(entry.nextNodeId);
    }
  }
  return {
    nodes: [...visited]
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is ApplicationNode => node !== undefined)
      .sort((left, right) => compareCodePoints(left.node_id, right.node_id)),
    edges: [...retainedEdges.values()].sort((left, right) =>
      compareCodePoints(left.edge_id, right.edge_id),
    ),
    depths,
    predecessors,
    frontierNodeIds: [...frontier].sort(compareCodePoints),
    omittedNodeCount: omittedNodes.size,
    omittedEdgeCount: omittedEdges.size,
  };
};

const buildAdjacency = (
  edges: readonly ApplicationEdge[],
  direction: TraceApplicationFeatureInput["direction"],
): ReadonlyMap<string, AdjacencyEntry[]> => {
  const adjacency = new Map<string, AdjacencyEntry[]>();
  for (const edge of edges) {
    if (direction !== "incoming")
      addAdjacency(adjacency, edge.source_node_id, {
        edge,
        nextNodeId: edge.target_node_id,
      });
    if (direction !== "outgoing")
      addAdjacency(adjacency, edge.target_node_id, {
        edge,
        nextNodeId: edge.source_node_id,
      });
  }
  for (const entries of adjacency.values())
    entries.sort((left, right) =>
      compareCodePoints(
        `${left.edge.edge_id}\0${left.nextNodeId}`,
        `${right.edge.edge_id}\0${right.nextNodeId}`,
      ),
    );
  return adjacency;
};

const addAdjacency = (
  adjacency: Map<string, AdjacencyEntry[]>,
  nodeId: string,
  entry: AdjacencyEntry,
): void => {
  adjacency.set(nodeId, [...(adjacency.get(nodeId) ?? []), entry]);
};

const recordOmission = (
  entry: AdjacencyEntry,
  current: string,
  omittedNodes: Set<string>,
  omittedEdges: Set<string>,
  frontier: Set<string>,
): void => {
  omittedNodes.add(entry.nextNodeId);
  omittedEdges.add(entry.edge.edge_id);
  frontier.add(current);
  frontier.add(entry.nextNodeId);
};
