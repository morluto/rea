import type { JavaScriptApplicationGraph } from "../domain/javascriptApplicationGraph.js";
import {
  createJavaScriptSemanticGraphNode,
  createJavaScriptSemanticGraphRelation,
  type JavaScriptSemanticGraphNode,
} from "../domain/javascriptSemanticGraph.js";
import type { ApplicationGraphEvidence } from "../domain/javascriptApplicationEvidenceSchemas.js";
import type {
  JavaScriptSemanticGraphRelation,
  JavaScriptSemanticGraphUnknown,
} from "../domain/javascriptSemanticGraphSchemas.js";
import type { JavaScriptSourceRange } from "../domain/javascriptStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";
import {
  inferredSemanticEvidence,
  observedSemanticEvidence,
  unavailableSemanticRootEvidence,
} from "./JavaScriptSemanticGraphEvidence.js";

/** Hard semantic graph node bound enforced during artifact projection. */
export const MAX_SEMANTIC_GRAPH_NODES = 100_000;
/** Hard semantic graph relation bound enforced during artifact projection. */
export const MAX_SEMANTIC_GRAPH_RELATIONS = 200_000;
/** Hard unresolved-frontier bound enforced across all analyzed files. */
export const MAX_SEMANTIC_GRAPH_UNKNOWNS = 100_000;
/** Maximum structural nodes linked to one exact semantic location. */
export const MAX_APPLICATION_NODE_IDS_PER_SEMANTIC_NODE = 64;

type SemanticGraphProjectionLimit =
  | "max_application_node_ids_per_semantic_node"
  | "max_nodes"
  | "max_relations"
  | "max_unknowns";

/** Mutable local projection state hidden from graph callers. */
export interface SemanticGraphProjectionState {
  readonly nodes: Map<string, JavaScriptSemanticGraphNode>;
  readonly relations: Map<string, JavaScriptSemanticGraphRelation>;
  readonly unknowns: Map<string, JavaScriptSemanticGraphUnknown>;
  readonly roots: Set<string>;
  readonly limitsReached: Set<SemanticGraphProjectionLimit>;
  readonly applicationNodeIdsByLocation: ReadonlyMap<string, readonly string[]>;
}

/** Input for one exact artifact-version semantic node. */
export interface SemanticNodeConstructionInput {
  readonly kind: JavaScriptSemanticGraphNode["kind"];
  readonly roleKey: string;
  readonly location: JavaScriptSourceRange | null;
  readonly label: string | null;
  readonly functionNodeId: string | null;
}

/** Input for one directed static semantic relationship. */
export interface SemanticRelationConstructionInput {
  readonly source: JavaScriptSemanticGraphNode | undefined | null;
  readonly target: JavaScriptSemanticGraphNode | undefined | null;
  readonly relation: JavaScriptSemanticGraphRelation["relation"];
  readonly resolution?: JavaScriptSemanticGraphRelation["resolution"];
  readonly evidence?: ApplicationGraphEvidence;
}

/** Create empty projection state with structural application-node mappings. */
export const createSemanticGraphProjectionState = (
  applicationGraph: Pick<JavaScriptApplicationGraph, "nodes">,
): SemanticGraphProjectionState => {
  const index = indexApplicationNodes(applicationGraph.nodes);
  return {
    nodes: new Map(),
    relations: new Map(),
    unknowns: new Map(),
    roots: new Set(),
    limitsReached: new Set(
      index.truncated ? ["max_application_node_ids_per_semantic_node"] : [],
    ),
    applicationNodeIdsByLocation: index.identifiers,
  };
};

/** Construct one canonical semantic node backed by an exact artifact file. */
export const constructSemanticGraphNode = (
  file: JavaScriptArtifactFile,
  input: SemanticNodeConstructionInput,
  state: SemanticGraphProjectionState,
): JavaScriptSemanticGraphNode =>
  createJavaScriptSemanticGraphNode({
    kind: input.kind,
    identity: {
      artifact_sha256: file.sha256,
      module_path: file.path,
      source_range: input.location,
      role_key: input.roleKey,
    },
    function_node_id: input.functionNodeId,
    application_node_ids: matchingApplicationNodeIds(file, input, state),
    label: input.label,
    properties: {},
    evidence: observedSemanticEvidence(file, input.location),
  });

/** Retain one canonical node unless the hard graph bound was reached. */
export const addSemanticGraphNode = (
  state: SemanticGraphProjectionState,
  node: JavaScriptSemanticGraphNode,
): JavaScriptSemanticGraphNode | null => {
  const existing = state.nodes.get(node.node_id);
  if (existing !== undefined) return existing;
  if (state.nodes.size >= MAX_SEMANTIC_GRAPH_NODES) {
    state.limitsReached.add("max_nodes");
    return null;
  }
  state.nodes.set(node.node_id, node);
  return node;
};

/** Retain one non-self semantic relationship unless its hard bound was reached. */
export const addSemanticGraphRelation = (
  state: SemanticGraphProjectionState,
  input: SemanticRelationConstructionInput,
): void => {
  if (
    input.source === undefined ||
    input.source === null ||
    input.target === undefined ||
    input.target === null ||
    input.source.node_id === input.target.node_id
  )
    return;
  const value = createJavaScriptSemanticGraphRelation({
    source_node_id: input.source.node_id,
    target_node_id: input.target.node_id,
    relation: input.relation,
    resolution: input.resolution ?? "candidate",
    properties: {},
    evidence: input.evidence ?? inferredSemanticEvidence(input.source),
  });
  if (state.relations.has(value.relation_id)) return;
  if (state.relations.size >= MAX_SEMANTIC_GRAPH_RELATIONS) {
    state.limitsReached.add("max_relations");
    return;
  }
  state.relations.set(value.relation_id, value);
};

/** Retain one unresolved frontier unless the global graph bound was reached. */
export const addSemanticGraphUnknown = (
  state: SemanticGraphProjectionState,
  unknown: JavaScriptSemanticGraphUnknown,
): void => {
  if (state.unknowns.has(unknown.unknown_id)) return;
  if (state.unknowns.size >= MAX_SEMANTIC_GRAPH_UNKNOWNS) {
    state.limitsReached.add("max_unknowns");
    return;
  }
  state.unknowns.set(unknown.unknown_id, unknown);
};

/** Add a truthful root when no source file could produce semantic IR. */
export const addSemanticFallbackRoot = (
  rootArtifactSha256: string,
  state: SemanticGraphProjectionState,
): void => {
  const node = addSemanticGraphNode(
    state,
    createJavaScriptSemanticGraphNode({
      kind: "module",
      identity: {
        artifact_sha256: rootArtifactSha256,
        module_path: "unknown-semantic-root",
        source_range: null,
        role_key: "artifact-root",
      },
      function_node_id: null,
      application_node_ids: [],
      label: "unavailable semantic root",
      properties: {},
      evidence: unavailableSemanticRootEvidence(rootArtifactSha256),
    }),
  );
  if (node !== null) state.roots.add(node.node_id);
};

const indexApplicationNodes = (
  nodes: JavaScriptApplicationGraph["nodes"],
): {
  readonly identifiers: ReadonlyMap<string, readonly string[]>;
  readonly truncated: boolean;
} => {
  const identifiers = new Map<string, Set<string>>();
  for (const node of nodes) {
    for (const observation of node.observations) {
      const { artifact, location } = observation.evidence;
      if (!artifact.available || !location.available) continue;
      if (location.value.kind === "artifact-path") {
        addApplicationNodeIdentifier(
          identifiers,
          applicationLocationKey(artifact.sha256, location.value.path, null),
          node.node_id,
        );
      }
      if (location.value.kind === "source-range") {
        addApplicationNodeIdentifier(
          identifiers,
          applicationLocationKey(artifact.sha256, location.value.source, {
            start: location.value.start,
            end: location.value.end,
          }),
          node.node_id,
        );
      }
    }
  }
  let truncated = false;
  const indexed = new Map(
    [...identifiers].map(([key, values]) => {
      const sorted = [...values].sort();
      if (sorted.length > MAX_APPLICATION_NODE_IDS_PER_SEMANTIC_NODE)
        truncated = true;
      return [key, sorted.slice(0, MAX_APPLICATION_NODE_IDS_PER_SEMANTIC_NODE)];
    }),
  );
  return { identifiers: indexed, truncated };
};

const matchingApplicationNodeIds = (
  file: JavaScriptArtifactFile,
  input: SemanticNodeConstructionInput,
  state: SemanticGraphProjectionState,
): string[] => [
  ...(state.applicationNodeIdsByLocation.get(
    applicationLocationKey(file.sha256, file.path, input.location),
  ) ?? []),
];

const addApplicationNodeIdentifier = (
  identifiers: Map<string, Set<string>>,
  key: string,
  nodeId: string,
): void => {
  const values = identifiers.get(key) ?? new Set<string>();
  values.add(nodeId);
  identifiers.set(key, values);
};

const applicationLocationKey = (
  artifactSha256: string,
  path: string,
  range: JavaScriptSourceRange | null,
): string =>
  [
    artifactSha256,
    path,
    range === null
      ? "artifact-path"
      : `${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`,
  ].join("\u0000");
