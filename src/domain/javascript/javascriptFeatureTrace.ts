import { appendToMapList } from "../appendToMapList.js";
import { isImmutableJsonSnapshot } from "../immutableJson.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type { Evidence } from "../evidence.js";
import {
  createJavaScriptApplicationGraph,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import type {
  ApplicationEdge,
  ApplicationNode,
} from "./javascriptApplicationGraphSchemas.js";
import {
  applicationFeatureTraceResultSchema,
  featureSeedMatchMode,
  type ApplicationFeatureSeed,
  type ApplicationFeatureTraceResult,
  type TraceApplicationFeatureInput,
} from "./javascriptFeatureTraceSchemas.js";
import {
  findApplicationFeatureSeedsInGraph,
  normalizeFeatureSeedText,
  type ApplicationFeatureSeedMatch,
} from "./javascriptFeatureSeed.js";
import type { JavaScriptSemanticGraph } from "./javascriptSemanticGraph.js";
import type { JavaScriptSemanticGraphNode } from "./javascriptSemanticGraphSchemas.js";
import { semanticCallLiteralValues } from "./javascriptSemanticCallLiterals.js";
import {
  traverseApplicationFeature,
  type ApplicationFeatureTraversal,
} from "./javascriptFeatureTraversal.js";
import { buildJavaScriptNativeHandoffs } from "./javascriptNativeHandoff.js";

/** Pure, authenticated inputs projected by the application service. */
export interface ApplicationFeatureTraceProjectionInput {
  readonly sourceEvidenceId: string;
  readonly graph: JavaScriptApplicationGraph;
  readonly semanticGraph?: JavaScriptSemanticGraph | null;
  readonly semanticPage?: { readonly offset: number; readonly limit: number };
  readonly nativeEvidence: readonly Evidence[];
  readonly seed: ApplicationFeatureSeed;
  readonly direction: TraceApplicationFeatureInput["direction"];
}

/** Trace a literal feature through its complete reachable, authority-preserving JAG. */
export const traceApplicationFeature = (
  input: ApplicationFeatureTraceProjectionInput,
): ApplicationFeatureTraceResult => {
  const seedMatches = findApplicationFeatureSeedsInGraph(
    input.graph,
    input.seed,
  );
  if (seedMatches.length === 0) return noMatchResult(input);
  const traversal = traverseApplicationFeature(
    input.graph,
    seedMatches.map(({ node_id: id }) => id),
    input.direction,
  );
  const graph = traceGraph(input, seedMatches, traversal);
  const paths = terminalPaths(traversal, seedMatches);
  const nativeAddonIds = new Set(
    traversal.nodes
      .filter(({ kind }) => kind === "native-addon")
      .map(({ node_id }) => node_id),
  );
  const nativeHandoffs =
    nativeAddonIds.size === 0
      ? []
      : buildJavaScriptNativeHandoffs(
          input.graph,
          nativeAddonIds,
          input.nativeEvidence,
        );
  const evidenceLinks = uniqueSorted([
    input.sourceEvidenceId,
    ...nativeHandoffs.flatMap(({ evidence_ids: ids }) => ids),
  ]);
  const semantic = {
    source_evidence_id: input.sourceEvidenceId,
    source_graph_id: input.graph.graph_id,
    seed: input.seed,
    direction: input.direction,
    seed_matches: seedMatches,
    graph,
    paths,
    native_handoffs: nativeHandoffs,
    summary: {
      matched_seeds: seedMatches.length,
      traced_nodes: traversal.nodes.length,
      traced_edges: traversal.edges.length,
      terminal_paths: paths.length,
      native_handoffs: nativeHandoffs.length,
      ...factSummary(traversal.nodes, traversal.edges),
    },
    coverage: {
      status: traceCoverageStatus(input.graph),
      source_graph_status: input.graph.coverage.status,
      total_seed_matches: seedMatches.length,
    },
    evidence_links: evidenceLinks,
    limitations: traceLimitations(input.graph),
  };
  return applicationFeatureTraceResultSchema.parse({
    ...semantic,
    trace_id: `jatr_${digestCanonicalValue(semantic, "Feature trace")}`,
  });
};

const noMatchResult = (
  input: ApplicationFeatureTraceProjectionInput,
): ApplicationFeatureTraceResult => {
  const discovery = discoverSemanticLabels(input);
  const semantic = {
    source_evidence_id: input.sourceEvidenceId,
    source_graph_id: input.graph.graph_id,
    seed: input.seed,
    direction: input.direction,
    seed_matches: [],
    ...(discovery === undefined ? {} : { semantic_discovery: discovery }),
    graph: null,
    paths: [],
    native_handoffs: [],
    summary: {
      matched_seeds: 0,
      traced_nodes: 0,
      traced_edges: 0,
      terminal_paths: 0,
      native_handoffs: 0,
      observed_facts: 0,
      inferred_facts: 0,
      unknown_facts: 0,
      unavailable_facts: 0,
    },
    coverage: {
      status: "no-match" as const,
      source_graph_status: input.graph.coverage.status,
      total_seed_matches: 0,
    },
    evidence_links: [input.sourceEvidenceId],
    limitations: uniqueSorted([
      "No application graph entity matched the literal seed; this is not evidence that the feature is absent.",
      ...(discovery === undefined
        ? []
        : [
            "Semantic discovery matches retained node labels and direct string call arguments; matches are starting points, not application-graph feature traces. Use trace_javascript_semantics with a returned trace_seed and the same application Evidence.",
          ]),
      ...sourceCoverageLimitations(input.graph),
    ]),
  };
  return applicationFeatureTraceResultSchema.parse({
    ...semantic,
    trace_id: `jatr_${digestCanonicalValue(semantic, "Feature trace")}`,
  });
};

type SemanticDiscoveryMatch = NonNullable<
  ApplicationFeatureTraceResult["semantic_discovery"]
>["matches"][number];

interface IndexedSemanticNodeLabels {
  readonly match: SemanticDiscoveryMatch;
  readonly rawTexts: readonly string[];
}

interface SemanticLabelCaseCache {
  readonly normalizedEntries: readonly {
    readonly match: SemanticDiscoveryMatch;
    readonly texts: readonly string[];
  }[];
  readonly byExact: ReadonlyMap<string, readonly SemanticDiscoveryMatch[]>;
}

interface SemanticLabelIndex {
  readonly entries: readonly IndexedSemanticNodeLabels[];
  sensitive?: SemanticLabelCaseCache;
  insensitive?: SemanticLabelCaseCache;
}

const semanticLabelIndexes = new WeakMap<
  JavaScriptSemanticGraph,
  SemanticLabelIndex
>();

const extractNodeLabelTexts = (node: JavaScriptSemanticGraphNode): string[] => {
  const texts: string[] = [];
  if (node.label !== null) texts.push(node.label);
  for (const literal of semanticCallLiteralValues(node))
    if (typeof literal === "string") texts.push(literal);
  return texts;
};

const getSemanticLabelIndex = (
  graph: JavaScriptSemanticGraph,
): SemanticLabelIndex | undefined => {
  if (!isImmutableJsonSnapshot(graph)) return undefined;
  let index = semanticLabelIndexes.get(graph);
  if (index === undefined) {
    const entries: IndexedSemanticNodeLabels[] = [];
    for (const node of graph.nodes) {
      const rawTexts = extractNodeLabelTexts(node);
      if (rawTexts.length === 0) continue;
      entries.push({
        match: {
          node_id: node.node_id,
          kind: node.kind,
          trace_seed: { kind: "semantic-node", node_id: node.node_id },
        },
        rawTexts,
      });
    }
    index = { entries };
    semanticLabelIndexes.set(graph, index);
  }
  return index;
};

const getSemanticLabelCaseCache = (
  index: SemanticLabelIndex,
  caseSensitive: boolean,
): SemanticLabelCaseCache => {
  const existing = caseSensitive ? index.sensitive : index.insensitive;
  if (existing !== undefined) return existing;
  const normalizedEntries: {
    readonly match: SemanticDiscoveryMatch;
    readonly texts: readonly string[];
  }[] = [];
  const byExact = new Map<string, SemanticDiscoveryMatch[]>();
  for (const entry of index.entries) {
    const texts: string[] = [];
    const seenTexts = new Set<string>();
    for (const raw of entry.rawTexts) {
      const normalized = normalizeFeatureSeedText(raw, caseSensitive);
      texts.push(normalized);
      if (!seenTexts.has(normalized)) {
        seenTexts.add(normalized);
        appendToMapList(byExact, normalized, entry.match);
      }
    }
    normalizedEntries.push({ match: entry.match, texts });
  }
  const built: SemanticLabelCaseCache = { normalizedEntries, byExact };
  if (caseSensitive) index.sensitive = built;
  else index.insensitive = built;
  return built;
};

/** Semantic discovery is independent of the application graph traversal. */
const discoverSemanticLabels = (
  input: ApplicationFeatureTraceProjectionInput,
): ApplicationFeatureTraceResult["semantic_discovery"] => {
  const graph = input.semanticGraph;
  const seed = input.seed;
  if (graph === undefined || graph === null || seed.kind !== "string")
    return undefined;
  const query = normalizeFeatureSeedText(seed.value, seed.case_sensitive);
  const mode = featureSeedMatchMode(seed);
  const { offset, limit } = input.semanticPage ?? { offset: 0, limit: 64 };
  const indexed = getSemanticLabelIndex(graph);
  if (indexed !== undefined) {
    const cache = getSemanticLabelCaseCache(indexed, seed.case_sensitive);
    if (mode === "exact") {
      const all = cache.byExact.get(query) ?? [];
      const matches = all.slice(offset, offset + limit);
      return {
        source_graph_id: graph.graph_id,
        source_coverage: graph.coverage.status,
        total: all.length,
        offset,
        limit,
        next_offset:
          offset + matches.length < all.length ? offset + matches.length : null,
        matches,
      };
    }
    const matches: SemanticDiscoveryMatch[] = [];
    let total = 0;
    for (const entry of cache.normalizedEntries) {
      if (!entry.texts.some((value) => value.includes(query))) continue;
      if (total >= offset && matches.length < limit) matches.push(entry.match);
      total += 1;
    }
    return {
      source_graph_id: graph.graph_id,
      source_coverage: graph.coverage.status,
      total,
      offset,
      limit,
      next_offset:
        offset + matches.length < total ? offset + matches.length : null,
      matches,
    };
  }
  const matches: SemanticDiscoveryMatch[] = [];
  let total = 0;
  for (const node of graph.nodes) {
    if (!nodeMatchesSemanticLabel(node, query, mode, seed.case_sensitive))
      continue;
    if (total >= offset && matches.length < limit)
      matches.push({
        node_id: node.node_id,
        kind: node.kind,
        trace_seed: { kind: "semantic-node", node_id: node.node_id },
      });
    total += 1;
  }
  return {
    source_graph_id: graph.graph_id,
    source_coverage: graph.coverage.status,
    total,
    offset,
    limit,
    next_offset:
      offset + matches.length < total ? offset + matches.length : null,
    matches,
  };
};

const nodeMatchesSemanticLabel = (
  node: JavaScriptSemanticGraphNode,
  query: string,
  mode: "exact" | "contains",
  caseSensitive: boolean,
): boolean => {
  if (node.label !== null) {
    const normalized = normalizeFeatureSeedText(node.label, caseSensitive);
    if (mode === "exact" ? normalized === query : normalized.includes(query))
      return true;
  }
  for (const literal of semanticCallLiteralValues(node)) {
    if (typeof literal !== "string") continue;
    const normalized = normalizeFeatureSeedText(literal, caseSensitive);
    if (mode === "exact" ? normalized === query : normalized.includes(query))
      return true;
  }
  return false;
};

const traceGraph = (
  input: ApplicationFeatureTraceProjectionInput,
  seedMatches: readonly ApplicationFeatureSeedMatch[],
  traversal: ApplicationFeatureTraversal,
): JavaScriptApplicationGraph => {
  return createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: uniqueSorted(seedMatches.map(({ node_id: id }) => id)),
    nodes: traversal.nodes,
    edges: traversal.edges,
    coverage: traceGraphCoverage(input.graph),
    limitations: uniqueSorted([
      ...input.graph.limitations,
      "Trace edges retain their source authority; graph connectivity does not prove runtime execution or reachability.",
    ]),
  });
};

const traceGraphCoverage = (
  source: JavaScriptApplicationGraph,
): JavaScriptApplicationGraph["coverage"] => {
  return source.coverage.status === "complete"
    ? { status: "complete", truncated: false, omitted_count: 0, limits: [] }
    : source.coverage;
};

const terminalPaths = (
  traversal: ApplicationFeatureTraversal,
  seeds: readonly ApplicationFeatureSeedMatch[],
): ApplicationFeatureTraceResult["paths"] => {
  const seedIds = new Set(seeds.map(({ node_id: id }) => id));
  const edgeById = new Map(traversal.edges.map((edge) => [edge.edge_id, edge]));
  return traversal.nodes
    .filter(
      (node) =>
        isTerminal(node) &&
        (!seedIds.has(node.node_id) || traversal.nodes.length === 1),
    )
    .map((node) => pathTo(node, traversal.predecessors, edgeById))
    .filter((path): path is NonNullable<typeof path> => path !== null)
    .sort((left, right) =>
      compareUnicodeCodePoints(left.path_id, right.path_id),
    );
};

const pathTo = (
  node: ApplicationNode,
  predecessors: ApplicationFeatureTraversal["predecessors"],
  edgeById: ReadonlyMap<string, ApplicationEdge>,
): ApplicationFeatureTraceResult["paths"][number] | null => {
  const nodeIds = [node.node_id];
  const edgeIds: string[] = [];
  let current = node.node_id;
  while (predecessors.has(current)) {
    const predecessor = predecessors.get(current);
    if (predecessor === undefined) break;
    nodeIds.push(predecessor.previousNodeId);
    edgeIds.push(predecessor.edgeId);
    current = predecessor.previousNodeId;
  }
  nodeIds.reverse();
  edgeIds.reverse();
  const edges = edgeIds
    .map((edgeId) => edgeById.get(edgeId))
    .filter((edge): edge is ApplicationEdge => edge !== undefined);
  if (edges.length !== edgeIds.length) return null;
  const semantic = {
    start_node_id: nodeIds[0] ?? node.node_id,
    end_node_id: node.node_id,
    end_kind: node.kind,
    node_ids: nodeIds,
    edge_ids: edgeIds,
    authorities: uniqueSorted(edges.map(({ evidence }) => evidence.authority)),
    contains_inference: edges.some(
      ({ evidence }) => evidence.state === "inferred",
    ),
  };
  return {
    ...semantic,
    path_id: `jatp_${digestCanonicalValue(semantic, "Feature trace")}`,
  };
};

const isTerminal = (node: ApplicationNode): boolean =>
  [
    "endpoint",
    "storage",
    "url-scheme",
    "native-addon",
    "native-export",
    "unknown",
  ].includes(node.kind) ||
  (node.kind === "javascript-expression" &&
    node.observations.some((o) => o.properties.step_kind === "terminal"));

const factSummary = (
  nodes: readonly ApplicationNode[],
  edges: readonly ApplicationEdge[],
) => {
  let observed = 0;
  let inferred = 0;
  let unknown = 0;
  let unavailable = 0;
  const countState = (state: ApplicationEdge["evidence"]["state"]): void => {
    if (state === "observed") observed += 1;
    else if (state === "inferred") inferred += 1;
    else if (state === "unknown") unknown += 1;
    else unavailable += 1;
  };
  for (const { observations } of nodes)
    for (const { evidence } of observations) countState(evidence.state);
  for (const { evidence } of edges) countState(evidence.state);
  return {
    observed_facts: observed,
    inferred_facts: inferred,
    unknown_facts: unknown,
    unavailable_facts: unavailable,
  };
};

const traceCoverageStatus = (
  graph: JavaScriptApplicationGraph,
): ApplicationFeatureTraceResult["coverage"]["status"] =>
  graph.coverage.status === "complete" ? "complete-within-source" : "partial";

const traceLimitations = (graph: JavaScriptApplicationGraph): string[] =>
  uniqueSorted([
    "A trace reports graph relationships, not proof that code executed or that a feature is reachable in every state.",
    "Static, native, passive-runtime, inferred, and unknown facts retain their original authority in the returned graph.",
    "Native handoffs never open a binary or invoke a provider automatically; snapshot reuse remains provider/profile/target exact.",
    ...sourceCoverageLimitations(graph),
  ]);

const sourceCoverageLimitations = (
  graph: JavaScriptApplicationGraph,
): string[] =>
  graph.coverage.status === "complete"
    ? []
    : [
        "The source application graph is incomplete; unmatched seeds and frontiers remain unknown.",
      ];
