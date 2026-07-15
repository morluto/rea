import {
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationNode,
  type ApplicationEdge,
  type ApplicationNode,
} from "../domain/javascriptApplicationGraph.js";

/** Deduplicate graph entities while retaining distinct evidence observations. */
export class JavaScriptArtifactGraphAccumulator {
  readonly #nodes = new Map<string, ApplicationNode>();
  readonly #edges = new Map<string, ApplicationEdge>();
  #omittedObservations = 0;

  /** Create or merge one canonical node. */
  addNode(input: unknown): ApplicationNode {
    const created = createJavaScriptApplicationNode(input);
    const existing = this.#nodes.get(created.node_id);
    if (existing === undefined) {
      this.#nodes.set(created.node_id, created);
      return created;
    }
    const bySemanticId = new Map(
      [...existing.observations, ...created.observations].map((observation) => [
        observation.observation_id,
        observationInput(observation),
      ]),
    );
    const observations = [...bySemanticId.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, 64)
      .map(([, observation]) => observation);
    this.#omittedObservations += Math.max(0, bySemanticId.size - 64);
    const merged = createJavaScriptApplicationNode({
      kind: existing.kind,
      identity: existing.identity,
      observations,
    });
    this.#nodes.set(merged.node_id, merged);
    return merged;
  }

  /** Create or replace one canonical edge by semantic identifier. */
  addEdge(input: unknown): ApplicationEdge {
    const edge = createJavaScriptApplicationEdge(input);
    this.#edges.set(edge.edge_id, edge);
    return edge;
  }

  /** Return all accumulated canonical nodes. */
  nodes(): readonly ApplicationNode[] {
    return [...this.#nodes.values()];
  }

  /** Return all accumulated canonical edges. */
  edges(): readonly ApplicationEdge[] {
    return [...this.#edges.values()];
  }

  /** Count distinct node observations omitted by the graph contract bound. */
  omittedObservations(): number {
    return this.#omittedObservations;
  }
}

const observationInput = (
  observation: ApplicationNode["observations"][number],
) => {
  const {
    observation_id: _observationId,
    identifier_strategy: _strategy,
    ...input
  } = observation;
  return input;
};
