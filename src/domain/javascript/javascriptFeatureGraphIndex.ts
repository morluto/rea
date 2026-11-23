import { isImmutableJsonSnapshot } from "../immutableJson.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type { JavaScriptApplicationGraph } from "./javascriptApplicationGraph.js";
import type {
  ApplicationEdge,
  ApplicationNode,
} from "./javascriptApplicationGraphSchemas.js";

/** Directed adjacency entry for deterministic JAG traversal. */
export interface FeatureAdjacencyEntry {
  readonly edge: ApplicationEdge;
  readonly nextNodeId: string;
  /** In "both", the step goes from a contained node up to its container. */
  readonly ascends: boolean;
}

export type FeatureTraversalDirection = "outgoing" | "incoming" | "both";

/** Lazily populated immutable lookup index for one sealed JAG snapshot. */
export interface FeatureGraphIndex {
  readonly nodesById: ReadonlyMap<string, ApplicationNode>;
  readonly nodesByKind: ReadonlyMap<
    ApplicationNode["kind"],
    readonly ApplicationNode[]
  >;
  adjacency(
    direction: FeatureTraversalDirection,
  ): ReadonlyMap<string, readonly FeatureAdjacencyEntry[]>;
}

const featureGraphIndexes = new WeakMap<
  JavaScriptApplicationGraph,
  FeatureGraphIndex
>();

/** Return a cached structural index when `graph` is an authenticated immutable snapshot. */
export const getFeatureGraphIndex = (
  graph: JavaScriptApplicationGraph,
): FeatureGraphIndex | undefined => {
  if (!isImmutableJsonSnapshot(graph)) return undefined;
  let index = featureGraphIndexes.get(graph);
  if (index === undefined) {
    index = buildFeatureGraphIndex(graph);
    featureGraphIndexes.set(graph, index);
  }
  return index;
};

const buildFeatureGraphIndex = (
  graph: JavaScriptApplicationGraph,
): FeatureGraphIndex => {
  const nodesById = new Map<string, ApplicationNode>();
  const nodesByKind = new Map<ApplicationNode["kind"], ApplicationNode[]>();
  for (const node of graph.nodes) {
    nodesById.set(node.node_id, node);
    const bucket = nodesByKind.get(node.kind);
    if (bucket === undefined) nodesByKind.set(node.kind, [node]);
    else bucket.push(node);
  }
  const adjacencyCache: Partial<
    Record<
      FeatureTraversalDirection,
      ReadonlyMap<string, readonly FeatureAdjacencyEntry[]>
    >
  > = {};
  return {
    nodesById,
    nodesByKind,
    adjacency(direction) {
      let cached = adjacencyCache[direction];
      if (cached === undefined) {
        cached = buildFeatureAdjacency(graph.edges, direction);
        adjacencyCache[direction] = cached;
      }
      return cached;
    },
  };
};

/** Build deterministic sorted adjacency lists for one traversal direction. */
export const buildFeatureAdjacency = (
  edges: readonly ApplicationEdge[],
  direction: FeatureTraversalDirection,
): ReadonlyMap<string, FeatureAdjacencyEntry[]> => {
  const adjacency = new Map<string, FeatureAdjacencyEntry[]>();
  for (const edge of edges) {
    if (direction !== "incoming")
      addAdjacency(adjacency, edge.source_node_id, {
        edge,
        nextNodeId: edge.target_node_id,
        ascends: false,
      });
    if (direction !== "outgoing")
      addAdjacency(adjacency, edge.target_node_id, {
        edge,
        nextNodeId: edge.source_node_id,
        ascends: direction === "both" && edge.relation === "contains",
      });
  }
  for (const entries of adjacency.values())
    if (entries.length > 1)
      entries.sort(
        (left, right) =>
          compareUnicodeCodePoints(left.edge.edge_id, right.edge.edge_id) ||
          compareUnicodeCodePoints(left.nextNodeId, right.nextNodeId),
      );
  return adjacency;
};

const addAdjacency = (
  adjacency: Map<string, FeatureAdjacencyEntry[]>,
  nodeId: string,
  entry: FeatureAdjacencyEntry,
): void => {
  const entries = adjacency.get(nodeId);
  if (entries === undefined) adjacency.set(nodeId, [entry]);
  else entries.push(entry);
};
