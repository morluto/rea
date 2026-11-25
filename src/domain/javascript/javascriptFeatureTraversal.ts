import type {
  ApplicationEdge,
  ApplicationNode,
} from "./javascriptApplicationGraphSchemas.js";
import type { JavaScriptApplicationGraph } from "./javascriptApplicationGraph.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import {
  buildFeatureAdjacency,
  getFeatureGraphIndex,
} from "./javascriptFeatureGraphIndex.js";

interface Predecessor {
  readonly previousNodeId: string;
  readonly edgeId: string;
}

/** Complete reachable graph projection plus the first deterministic path to each node. */
export interface ApplicationFeatureTraversal {
  readonly nodes: ApplicationNode[];
  readonly edges: ApplicationEdge[];
  readonly predecessors: ReadonlyMap<string, Predecessor>;
}

/** Traverse a JAG without treating edge inference as observed reachability. */
export const traverseApplicationFeature = (
  graph: JavaScriptApplicationGraph,
  seedNodeIds: readonly string[],
  direction: "outgoing" | "incoming" | "both",
): ApplicationFeatureTraversal => {
  const index = getFeatureGraphIndex(graph);
  const nodeById =
    index?.nodesById ??
    new Map(graph.nodes.map((node) => [node.node_id, node]));
  const adjacency =
    index?.adjacency(direction) ??
    buildFeatureAdjacency(graph.edges, direction);
  const visited = new Set(seedNodeIds);
  const retainedEdges = new Map<string, ApplicationEdge>();
  const predecessors = new Map<string, Predecessor>();
  // A feature crosses relationships in both directions: a renderer invokes a
  // channel that its handler also points at. A container reached from one of
  // its children only leads further up; expanding it would return every
  // sibling in a shared asset or artifact root.
  const ascendedOnly = new Set<string>();
  const queue = [...seedNodeIds];
  for (let offset = 0; offset < queue.length; offset += 1) {
    const current = queue[offset];
    if (current === undefined) continue;
    const confined = ascendedOnly.has(current);
    for (const entry of adjacency.get(current) ?? []) {
      if (confined && !entry.ascends) continue;
      retainedEdges.set(entry.edge.edge_id, entry.edge);
      const next = entry.nextNodeId;
      if (!nodeById.has(next)) continue;
      const nextConfined = confined || entry.ascends;
      // A node reached only from below is expanded again once it is reached
      // another way.
      if (visited.has(next) && (nextConfined || !ascendedOnly.has(next)))
        continue;
      if (!visited.has(next)) {
        visited.add(next);
        predecessors.set(next, {
          previousNodeId: current,
          edgeId: entry.edge.edge_id,
        });
      }
      if (nextConfined) ascendedOnly.add(next);
      else ascendedOnly.delete(next);
      queue.push(next);
    }
  }
  const nodes: ApplicationNode[] = [];
  for (const nodeId of visited) {
    const node = nodeById.get(nodeId);
    if (node !== undefined) nodes.push(node);
  }
  if (nodes.length > 1)
    nodes.sort((left, right) =>
      compareUnicodeCodePoints(left.node_id, right.node_id),
    );
  const edges = [...retainedEdges.values()];
  if (edges.length > 1)
    edges.sort((left, right) =>
      compareUnicodeCodePoints(left.edge_id, right.edge_id),
    );
  return {
    nodes,
    edges,
    predecessors,
  };
};
