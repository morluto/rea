import type { JavaScriptApplicationGraph } from "../../domain/javascript/javascriptApplicationGraph.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { javascriptDisplayText } from "../../domain/javascript/javascriptAstValues.js";
import {
  createJavaScriptSemanticGraphNode,
  createJavaScriptSemanticGraphRelation,
  type JavaScriptSemanticGraphNode,
} from "../../domain/javascript/javascriptSemanticGraph.js";
import type { ApplicationGraphEvidence } from "../../domain/javascript/javascriptApplicationEvidenceSchemas.js";
import type {
  JavaScriptSemanticGraphRelation,
  JavaScriptSemanticGraphUnknown,
} from "../../domain/javascript/javascriptSemanticGraphSchemas.js";
import type { JavaScriptSourceRange } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";
import {
  inferredSemanticEvidence,
  observedSemanticEvidence,
  unavailableSemanticRootEvidence,
} from "./JavaScriptSemanticGraphEvidence.js";

/** Mutable local projection state hidden from graph callers. */
export interface SemanticGraphProjectionState {
  readonly nodes: Map<string, JavaScriptSemanticGraphNode>;
  readonly relations: Map<string, JavaScriptSemanticGraphRelation>;
  readonly unknowns: Map<string, JavaScriptSemanticGraphUnknown>;
  readonly roots: Set<string>;
  readonly applicationNodeIdsByLocation: ReadonlyMap<string, readonly string[]>;
}

/** Input for one exact artifact-version semantic node. */
export interface SemanticNodeConstructionInput {
  readonly kind: JavaScriptSemanticGraphNode["kind"];
  readonly roleKey: string;
  readonly location: JavaScriptSourceRange | null;
  readonly label: string | null;
  readonly functionNodeId: string | null;
  readonly properties?: Readonly<Record<string, JsonValue>>;
}

/** Input for one directed static semantic relationship. */
export interface SemanticRelationConstructionInput {
  readonly source: JavaScriptSemanticGraphNode | undefined | null;
  readonly target: JavaScriptSemanticGraphNode | undefined | null;
  readonly relation: JavaScriptSemanticGraphRelation["relation"];
  readonly resolution?: JavaScriptSemanticGraphRelation["resolution"];
  readonly evidence?: ApplicationGraphEvidence;
  readonly properties?: Readonly<Record<string, JsonValue>>;
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
    label: input.label === null ? null : javascriptDisplayText(input.label),
    properties: input.properties ?? {},
    evidence: observedSemanticEvidence(file, input.location),
  });

/** Retain one canonical semantic node. */
export const addSemanticGraphNode = (
  state: SemanticGraphProjectionState,
  node: JavaScriptSemanticGraphNode,
): JavaScriptSemanticGraphNode | null => {
  const existing = state.nodes.get(node.node_id);
  if (existing !== undefined) return existing;
  state.nodes.set(node.node_id, node);
  return node;
};

/** Retain one non-self semantic relationship. */
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
    properties: input.properties ?? {},
    evidence: input.evidence ?? inferredSemanticEvidence(input.source),
  });
  if (state.relations.has(value.relation_id)) return;
  state.relations.set(value.relation_id, value);
};

/** Retain one unresolved frontier. */
export const addSemanticGraphUnknown = (
  state: SemanticGraphProjectionState,
  unknown: JavaScriptSemanticGraphUnknown,
): void => {
  if (state.unknowns.has(unknown.unknown_id)) return;
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
  const indexed = new Map(
    [...identifiers].map(([key, values]) => {
      const sorted = [...values].sort();
      return [key, sorted];
    }),
  );
  return { identifiers: indexed };
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
