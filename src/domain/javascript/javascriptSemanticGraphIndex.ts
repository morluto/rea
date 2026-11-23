import { isImmutableJsonSnapshot } from "../immutableJson.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type { JavaScriptSemanticGraph } from "./javascriptSemanticGraph.js";
import type {
  JavaScriptSemanticEvidenceContext,
  JavaScriptSemanticGraphNode,
  JavaScriptSemanticGraphRelation,
  JavaScriptSemanticGraphUnknown,
} from "./javascriptSemanticGraphSchemas.js";
import { semanticCallLiteralValues } from "./javascriptSemanticCallLiterals.js";

export type SemanticLiteralPrimitive = string | number | boolean | null;

/** Directed relation lists grouped by endpoint node ID. */
export interface SemanticAdjacency {
  readonly outgoingByNode: ReadonlyMap<
    string,
    readonly JavaScriptSemanticGraphRelation[]
  >;
  readonly incomingByNode: ReadonlyMap<
    string,
    readonly JavaScriptSemanticGraphRelation[]
  >;
}

/** Unknown frontiers split into node-bound and graph-wide records. */
export interface SemanticUnknownIndex {
  readonly byNodeId: ReadonlyMap<
    string,
    readonly JavaScriptSemanticGraphUnknown[]
  >;
  readonly global: readonly JavaScriptSemanticGraphUnknown[];
}

/** Pre-indexed seed candidate node IDs (sorted by Unicode code point). */
export interface SemanticSeedIndex {
  readonly byApplicationNodeId: ReadonlyMap<string, readonly string[]>;
  readonly byFingerprint: ReadonlyMap<string, readonly string[]>;
  readonly byLiteral: ReadonlyMap<SemanticLiteralPrimitive, readonly string[]>;
  readonly byProperty: ReadonlyMap<string, readonly string[]>;
  readonly byEndpoint: ReadonlyMap<string, readonly string[]>;
  readonly byEvent: ReadonlyMap<string, readonly string[]>;
  readonly byBoundaryField: ReadonlyMap<string, readonly string[]>;
}

/** Lazily populated lookup indexes for an immutable JavaScriptSemanticGraph. */
export interface SemanticGraphIndex {
  getNodesById(): ReadonlyMap<string, JavaScriptSemanticGraphNode>;
  getContextsById(): ReadonlyMap<string, JavaScriptSemanticEvidenceContext>;
  getAdjacency(): SemanticAdjacency;
  getUnknowns(): SemanticUnknownIndex;
  getGlobalUnknowns(): readonly JavaScriptSemanticGraphUnknown[];
  getSeedIndex(): SemanticSeedIndex;
}

const semanticGraphIndexes = new WeakMap<
  JavaScriptSemanticGraph,
  SemanticGraphIndex
>();

/** Return a cached structural index when `graph` is an authenticated immutable snapshot. */
export const getSemanticGraphIndex = (
  graph: JavaScriptSemanticGraph,
): SemanticGraphIndex | undefined => {
  if (!isImmutableJsonSnapshot(graph)) return undefined;
  let index = semanticGraphIndexes.get(graph);
  if (index === undefined) {
    index = createSemanticGraphIndex(graph);
    semanticGraphIndexes.set(graph, index);
  }
  return index;
};

/** Build outgoing and incoming relation adjacency lists in a single pass. */
export const buildSemanticAdjacency = (
  relations: readonly JavaScriptSemanticGraphRelation[],
): SemanticAdjacency => {
  const outgoingByNode = new Map<string, JavaScriptSemanticGraphRelation[]>();
  const incomingByNode = new Map<string, JavaScriptSemanticGraphRelation[]>();
  for (const relation of relations) {
    pushBucket(outgoingByNode, relation.source_node_id, relation);
    pushBucket(incomingByNode, relation.target_node_id, relation);
  }
  return { outgoingByNode, incomingByNode };
};

const createSemanticGraphIndex = (
  graph: JavaScriptSemanticGraph,
): SemanticGraphIndex => {
  let nodesById: ReadonlyMap<string, JavaScriptSemanticGraphNode> | undefined;
  let contextsById:
    | ReadonlyMap<string, JavaScriptSemanticEvidenceContext>
    | undefined;
  let adjacency: SemanticAdjacency | undefined;
  let unknownsIndex: SemanticUnknownIndex | undefined;
  let globalUnknowns: readonly JavaScriptSemanticGraphUnknown[] | undefined;
  let seedIndex: SemanticSeedIndex | undefined;

  const getNodesById = (): ReadonlyMap<string, JavaScriptSemanticGraphNode> => {
    if (nodesById === undefined)
      nodesById = new Map(graph.nodes.map((node) => [node.node_id, node]));
    return nodesById;
  };

  return {
    getNodesById,
    getContextsById: () => {
      if (contextsById === undefined)
        contextsById = new Map(
          graph.evidence_contexts.map((context) => [
            context.context_id,
            context,
          ]),
        );
      return contextsById;
    },
    getAdjacency: () => {
      if (adjacency === undefined)
        adjacency = buildSemanticAdjacency(graph.relations);
      return adjacency;
    },
    getUnknowns: () => {
      if (unknownsIndex === undefined) {
        unknownsIndex = buildUnknownIndex(graph.unknowns);
        globalUnknowns = unknownsIndex.global;
      }
      return unknownsIndex;
    },
    getGlobalUnknowns: () => {
      if (globalUnknowns === undefined)
        globalUnknowns = graph.unknowns.filter(
          (unknown) => unknown.node_id === null,
        );
      return globalUnknowns;
    },
    getSeedIndex: () => {
      if (seedIndex === undefined)
        seedIndex = buildSeedIndex(graph, getNodesById());
      return seedIndex;
    },
  };
};

const buildUnknownIndex = (
  unknowns: readonly JavaScriptSemanticGraphUnknown[],
): SemanticUnknownIndex => {
  const byNodeId = new Map<string, JavaScriptSemanticGraphUnknown[]>();
  const global: JavaScriptSemanticGraphUnknown[] = [];
  for (const unknown of unknowns) {
    if (unknown.node_id === null) global.push(unknown);
    else pushBucket(byNodeId, unknown.node_id, unknown);
  }
  return { byNodeId, global };
};

const buildSeedIndex = (
  graph: JavaScriptSemanticGraph,
  nodesById: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
): SemanticSeedIndex => {
  const byApplicationNodeId = new Map<string, string[]>();
  const byFingerprintSets = new Map<string, Set<string>>();
  const byLiteralSets = new Map<SemanticLiteralPrimitive, Set<string>>();
  const representedCalls = new Map<SemanticLiteralPrimitive, Set<string>>();
  const callSitesWithLiterals: JavaScriptSemanticGraphNode[] = [];
  const byProperty = new Map<string, string[]>();
  const byEndpoint = new Map<string, string[]>();
  const byEvent = new Map<string, string[]>();
  const byBoundaryField = new Map<string, string[]>();

  const unresolvedAccesses = new Set<string>();
  for (const { family, node_id } of graph.unknowns)
    if (family === "object-flow" && node_id !== null)
      unresolvedAccesses.add(node_id);

  for (const { fingerprint_sha256, function_node_id } of graph.fingerprints) {
    if (!nodesById.has(function_node_id)) continue;
    pushSetBucket(byFingerprintSets, fingerprint_sha256, function_node_id);
  }

  for (const node of graph.nodes) {
    for (const appNodeId of node.application_node_ids)
      pushBucket(byApplicationNodeId, appNodeId, node.node_id);
    indexNodeByKind(node, {
      byLiteralSets,
      representedCalls,
      callSitesWithLiterals,
      byProperty,
      unresolvedAccesses,
      byEndpoint,
      byEvent,
      byBoundaryField,
    });
  }

  for (const node of callSitesWithLiterals) {
    for (const value of semanticCallLiteralValues(node)) {
      if (representedCalls.get(value)?.has(node.node_id) === true) continue;
      pushSetBucket(byLiteralSets, value, node.node_id);
    }
  }

  return {
    byApplicationNodeId: sortStringBuckets(byApplicationNodeId),
    byFingerprint: sortSetBuckets(byFingerprintSets),
    byLiteral: sortSetBuckets(byLiteralSets),
    byProperty: sortStringBuckets(byProperty),
    byEndpoint: sortStringBuckets(byEndpoint),
    byEvent: sortStringBuckets(byEvent),
    byBoundaryField: sortStringBuckets(byBoundaryField),
  };
};

interface KindIndexState {
  readonly byLiteralSets: Map<SemanticLiteralPrimitive, Set<string>>;
  readonly representedCalls: Map<SemanticLiteralPrimitive, Set<string>>;
  readonly callSitesWithLiterals: JavaScriptSemanticGraphNode[];
  readonly byProperty: Map<string, string[]>;
  readonly unresolvedAccesses: ReadonlySet<string>;
  readonly byEndpoint: Map<string, string[]>;
  readonly byEvent: Map<string, string[]>;
  readonly byBoundaryField: Map<string, string[]>;
}

const indexNodeByKind = (
  node: JavaScriptSemanticGraphNode,
  state: KindIndexState,
): void => {
  if (node.kind === "literal") {
    const value = node.properties.value;
    if (isLiteralPrimitive(value))
      pushSetBucket(state.byLiteralSets, value, node.node_id);
    return;
  }
  if (node.kind === "expression") {
    const callSiteId = node.properties.literal_argument_call_site_node_id;
    const literalArg = node.properties.literal_argument_value;
    if (typeof callSiteId === "string" && isLiteralPrimitive(literalArg)) {
      pushSetBucket(state.representedCalls, literalArg, callSiteId);
      pushSetBucket(state.byLiteralSets, literalArg, node.node_id);
    }
    const path = node.properties.property_path;
    const slotless =
      node.properties.property_slot_resolution === "unresolved" ||
      (node.properties.property_slot_resolution === undefined &&
        state.unresolvedAccesses.has(node.node_id));
    if (slotless && Array.isArray(path)) {
      const last = path.at(-1);
      if (typeof last === "string")
        pushBucket(state.byProperty, last, node.node_id);
    }
    return;
  }
  if (node.kind === "call-site") {
    if (Array.isArray(node.properties.arguments))
      state.callSitesWithLiterals.push(node);
    return;
  }
  if (node.kind === "property-slot") {
    if (typeof node.properties.name === "string")
      pushBucket(state.byProperty, node.properties.name, node.node_id);
    return;
  }
  if (node.kind === "request" || node.kind === "response") {
    if (typeof node.properties.endpoint === "string")
      pushBucket(state.byEndpoint, node.properties.endpoint, node.node_id);
    return;
  }
  if (node.kind === "event" || node.kind === "listener") {
    if (typeof node.properties.event_name === "string")
      pushBucket(state.byEvent, node.properties.event_name, node.node_id);
    return;
  }
  if (node.kind === "boundary" && typeof node.properties.field === "string")
    pushBucket(state.byBoundaryField, node.properties.field, node.node_id);
};

const isLiteralPrimitive = (
  value: unknown,
): value is SemanticLiteralPrimitive =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const pushBucket = <Key, Value>(
  map: Map<Key, Value[]>,
  key: Key,
  value: Value,
): void => {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
};

const pushSetBucket = <Key>(
  map: Map<Key, Set<string>>,
  key: Key,
  value: string,
): void => {
  let bucket = map.get(key);
  if (bucket === undefined) {
    bucket = new Set();
    map.set(key, bucket);
  }
  bucket.add(value);
};

const sortStringBuckets = (
  buckets: Map<string, string[]>,
): ReadonlyMap<string, readonly string[]> => {
  for (const list of buckets.values())
    if (list.length > 1) list.sort(compareUnicodeCodePoints);
  return buckets;
};

const sortSetBuckets = <Key>(
  buckets: Map<Key, Set<string>>,
): ReadonlyMap<Key, readonly string[]> => {
  const sorted = new Map<Key, readonly string[]>();
  for (const [key, set] of buckets) {
    const list = [...set];
    if (list.length > 1) list.sort(compareUnicodeCodePoints);
    sorted.set(key, list);
  }
  return sorted;
};
