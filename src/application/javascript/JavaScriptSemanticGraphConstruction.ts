import { javascriptSourceRangeKey } from "../../domain/javascript/javascriptSourceCoordinates.js";
import type { z } from "zod";
import type { JavaScriptApplicationGraph } from "../../domain/javascript/javascriptApplicationGraph.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { javascriptDisplayText } from "../../domain/javascript/javascriptAstValues.js";
import {
  createJavaScriptSemanticGraphNode,
  createJavaScriptSemanticGraphUnknown,
  createJavaScriptSemanticGraphRelation,
  JavaScriptSemanticEvidenceContextRegistry,
  javaScriptSemanticNodeId,
} from "../../domain/javascript/javascriptSemanticGraph.js";
import type {
  JavaScriptSemanticGraphNode,
  JavaScriptSemanticGraphRelation,
  JavaScriptSemanticGraphUnknown,
  JavaScriptSemanticUnknownOmission,
  javaScriptSemanticUnknownInputSchema,
} from "../../domain/javascript/javascriptSemanticGraphSchemas.js";
import type { ApplicationGraphEvidence } from "../../domain/javascript/javascriptApplicationEvidenceSchemas.js";
import type { JavaScriptSourceRange } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  serializedSemanticFactBytes,
  type SemanticFileGraphBudget,
} from "./JavaScriptSemanticFileGraphBudget.js";
import type {
  JavaScriptSemanticFileProjectionCoverage,
  JavaScriptSemanticFingerprint,
} from "../../domain/javascript/javascriptSemanticGraphSchemas.js";
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
  /** Absolute retained unknown count allowed during this file; null outside admission. */
  unknownCapacity: number | null;
  readonly unknownOmissions: Map<string, JavaScriptSemanticUnknownOmission>;
  readonly evidenceContexts: JavaScriptSemanticEvidenceContextRegistry;
  readonly roots: Set<string>;
  /** Byte admission for the source file being projected; absent when adopting. */
  fileBudget?: SemanticFileGraphBudget;
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

/** Create empty projection state; application-node links are bound at finish. */
export const createSemanticGraphProjectionState =
  (): SemanticGraphProjectionState => ({
    nodes: new Map(),
    relations: new Map(),
    unknowns: new Map(),
    unknownCapacity: null,
    unknownOmissions: new Map(),
    evidenceContexts: new JavaScriptSemanticEvidenceContextRegistry(),
    roots: new Set(),
  });

/** Bind application IDs before final byte admission, preserving connected facts. */
export function* bindSemanticGraphApplicationNodesSteps(
  state: SemanticGraphProjectionState,
  applicationGraph: Pick<JavaScriptApplicationGraph, "nodes">,
  fingerprints: JavaScriptSemanticFingerprint[] = [],
  budget?: SemanticFileGraphBudget,
): Generator<void, void> {
  const applicationNodeIdsByLocation = yield* indexApplicationNodesSteps(
    applicationGraph.nodes,
  );
  for (const [identifier, node] of state.nodes) {
    yield;
    state.nodes.set(identifier, {
      ...node,
      // The index owns this immutable-to-consumers array. Share its storage
      // until admission so many nodes at one location cannot expand it eagerly.
      application_node_ids:
        applicationNodeIdsByLocation.get(
          applicationLocationKey(
            node.identity.artifact_sha256,
            node.identity.module_path,
            node.identity.source_range,
          ),
        ) ?? [],
    });
  }
  if (budget === undefined) return;
  // These nodes were already admitted and retained by the parent. Reuse their
  // references while their final, linked representation is admitted atomically.
  for (const [id, node] of state.nodes) {
    budget.pendingNodes.set(id, node);
    yield;
  }
  state.nodes.clear();
  let rootArrayBytes = 2;
  for (const id of state.roots) {
    yield;
    const bytes =
      Buffer.byteLength(JSON.stringify(id)) + (rootArrayBytes === 2 ? 2 : 1);
    if (!admitSemanticFact(state, budget, [id], undefined, bytes))
      state.roots.delete(id);
    else rootArrayBytes += bytes;
  }
  for (const [id, relation] of state.relations) {
    yield;
    if (
      !admitSemanticFact(
        state,
        budget,
        [relation.source_node_id, relation.target_node_id],
        relation,
      )
    )
      state.relations.delete(id);
  }
  const retained: JavaScriptSemanticFingerprint[] = [];
  for (const fingerprint of fingerprints) {
    yield;
    if (
      admitSemanticFact(
        state,
        budget,
        [fingerprint.function_node_id],
        fingerprint,
      )
    )
      retained.push(fingerprint);
  }
  fingerprints.length = 0;
  for (const fingerprint of retained) {
    fingerprints.push(fingerprint);
    yield;
  }
  for (const [id, unknown] of state.unknowns) {
    yield;
    if (
      !admitSemanticFact(
        state,
        budget,
        [
          ...(unknown.node_id === null ? [] : [unknown.node_id]),
          ...unknown.candidate_node_ids,
        ],
        unknown,
      )
    )
      state.unknowns.delete(id);
  }
  if (!budget.closed)
    for (const id of budget.pendingNodes.keys()) {
      yield;
      if (!admitSemanticFact(state, budget, [id])) break;
    }
  budget.pendingNodes.clear();
}

/** Account final serialized facts, including links and first-referenced contexts. */
export function* measureSemanticFilesSteps(
  state: SemanticGraphProjectionState,
  fingerprints: readonly JavaScriptSemanticFingerprint[],
): Generator<
  void,
  ReadonlyMap<string, { readonly bytes: number; readonly facts: number }>
> {
  const measurements = new Map<string, { bytes: number; facts: number }>();
  const contexts = new Set<string>();
  const facts = function* () {
    yield* state.nodes.values();
    yield* state.relations.values();
    yield* state.unknowns.values();
    yield* fingerprints;
  };
  for (const fact of facts()) {
    yield;
    const context = state.evidenceContexts.context(fact.evidence.context_id);
    const location = fact.evidence.location;
    if (!context.artifact.available || !location.available) continue;
    const path =
      location.value.kind === "artifact-path"
        ? location.value.path
        : location.value.kind === "source-range"
          ? location.value.source
          : null;
    if (path === null) continue;
    const key = `${context.artifact.sha256}\u0000${path}`;
    let count = serializedSemanticFactBytes(fact);
    if (!contexts.has(context.context_id)) {
      contexts.add(context.context_id);
      count += serializedSemanticFactBytes(context);
    }
    const current = measurements.get(key) ?? { bytes: 0, facts: 0 };
    current.bytes += count;
    current.facts += 1;
    measurements.set(key, current);
  }
  return measurements;
}

/** Construct one canonical semantic node backed by an exact artifact file. */
export const constructSemanticGraphNode = (
  file: JavaScriptArtifactFile,
  input: SemanticNodeConstructionInput,
  state: SemanticGraphProjectionState,
): JavaScriptSemanticGraphNode =>
  createJavaScriptSemanticGraphNode(
    {
      kind: input.kind,
      identity: {
        artifact_sha256: file.sha256,
        module_path: file.path,
        source_range: input.location,
        role_key: input.roleKey,
      },
      function_node_id: input.functionNodeId,
      application_node_ids: [],
      label: input.label === null ? null : javascriptDisplayText(input.label),
      properties: input.properties ?? {},
      evidence: observedSemanticEvidence(file, input.location),
    },
    state.evidenceContexts,
  );

/** Reuse retained identities and reject a closed budget before allocation. */
export const retainSemanticGraphNode = (
  state: SemanticGraphProjectionState,
  file: JavaScriptArtifactFile,
  input: SemanticNodeConstructionInput,
): JavaScriptSemanticGraphNode | null => {
  if (state.fileBudget?.closed === true) {
    state.fileBudget.markIncomplete();
    return null;
  }
  const identifier = javaScriptSemanticNodeId({
    kind: input.kind,
    identity: {
      artifact_sha256: file.sha256,
      module_path: file.path,
      source_range: input.location,
      role_key: input.roleKey,
    },
  });
  const existing =
    state.nodes.get(identifier) ??
    state.fileBudget?.pendingNodes.get(identifier);
  if (existing !== undefined) return existing;
  return addSemanticGraphNode(
    state,
    constructSemanticGraphNode(file, input, state),
  );
};

/**
 * Retain one canonical semantic node. Under a file budget, only module roots
 * are charged immediately; other nodes are charged when an admitted fact
 * first references them, so a truncated file keeps connected facts.
 */
export const addSemanticGraphNode = (
  state: SemanticGraphProjectionState,
  node: JavaScriptSemanticGraphNode,
): JavaScriptSemanticGraphNode | null => {
  const budget = state.fileBudget;
  const existing =
    state.nodes.get(node.node_id) ?? budget?.pendingNodes.get(node.node_id);
  if (existing !== undefined) return existing;
  if (budget === undefined) {
    state.nodes.set(node.node_id, node);
    return node;
  }
  if (node.kind !== "module") {
    if (!budget.reservePending(node.node_id, node, state.evidenceContexts))
      return null;
    budget.pendingNodes.set(node.node_id, node);
    return node;
  }
  if (!budget.admitNode(node, state.evidenceContexts)) {
    budget.omitNode(node.node_id);
    return null;
  }
  state.nodes.set(node.node_id, node);
  return node;
};

/** Commit required owners, endpoints and their fact as one admission transaction. */
const admitSemanticFact = (
  state: SemanticGraphProjectionState,
  budget: SemanticFileGraphBudget,
  nodeIds: readonly string[],
  fact?:
    | JavaScriptSemanticGraphRelation
    | JavaScriptSemanticGraphUnknown
    | JavaScriptSemanticFingerprint,
  additionalBytes = 0,
): boolean => {
  const pending = new Map<string, JavaScriptSemanticGraphNode>();
  const visit = (nodeId: string): boolean => {
    if (state.nodes.has(nodeId) || pending.has(nodeId)) return true;
    const node = budget.pendingNodes.get(nodeId);
    if (node === undefined) return false;
    pending.set(nodeId, node);
    return node.function_node_id === null || visit(node.function_node_id);
  };
  if (!nodeIds.every(visit)) return false;
  if (
    !budget.admitBatch(
      [...pending.values(), ...(fact === undefined ? [] : [fact])],
      pending.size,
      state.evidenceContexts,
      [
        ...pending.keys(),
        ...(fact !== undefined && "unknown_id" in fact
          ? [fact.unknown_id]
          : []),
      ],
      additionalBytes,
    )
  )
    return false;
  for (const [id, node] of pending) {
    budget.releasePending(id);
    budget.pendingNodes.delete(id);
    state.nodes.set(id, node);
  }
  return true;
};

/** Admit a callable and its fingerprint atomically during source indexing. */
export const admitSemanticIndexedFingerprint = (
  state: SemanticGraphProjectionState,
  fingerprint: JavaScriptSemanticFingerprint,
): boolean => {
  const budget = state.fileBudget;
  if (budget === undefined) return true;
  if (
    !admitSemanticFact(
      state,
      budget,
      [fingerprint.function_node_id],
      fingerprint,
    )
  )
    return false;
  budget.retainedFingerprints.set(fingerprint.function_node_id, fingerprint);
  return true;
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
  if (state.fileBudget?.closed === true) {
    state.fileBudget.markIncomplete();
    return;
  }
  const value = createJavaScriptSemanticGraphRelation(
    {
      source_node_id: input.source.node_id,
      target_node_id: input.target.node_id,
      relation: input.relation,
      resolution: input.resolution ?? "candidate",
      properties: input.properties ?? {},
      evidence:
        input.evidence ??
        inferredSemanticEvidence(
          state.evidenceContexts.resolve(input.source.evidence),
        ),
    },
    state.evidenceContexts,
  );
  if (state.relations.has(value.relation_id)) return;
  const budget = state.fileBudget;
  if (
    budget !== undefined &&
    !admitSemanticFact(
      state,
      budget,
      [value.source_node_id, value.target_node_id],
      value,
    )
  ) {
    budget.omitRelation(value.relation_id);
    return;
  }
  state.relations.set(value.relation_id, value);
};

/** Aggregate examined omissions without retaining unbounded discarded identities. */
export const recordSemanticUnknownOmission = (
  state: SemanticGraphProjectionState,
  omission: JavaScriptSemanticUnknownOmission,
): void => {
  const key = `${omission.family}:${omission.reason}`;
  const occurrences =
    (state.unknownOmissions.get(key)?.occurrences ?? 0) + omission.occurrences;
  if (!Number.isSafeInteger(occurrences))
    throw new RangeError("Semantic unknown omission count overflow");
  state.unknownOmissions.set(key, { ...omission, occurrences });
};

/** Admit unknown provenance only while its independent retained capacity allows it. */
export const addSemanticGraphUnknown = (
  state: SemanticGraphProjectionState,
  input: Omit<
    z.input<typeof javaScriptSemanticUnknownInputSchema>,
    "relation_kinds" | "candidate_node_ids"
  > & {
    readonly relation_kinds: readonly JavaScriptSemanticGraphRelation["relation"][];
    readonly candidate_node_ids: readonly string[];
  },
): void => {
  const budget = state.fileBudget;
  if (budget?.closed === true) {
    budget.markIncomplete();
    return;
  }
  if (
    state.unknownCapacity !== null &&
    state.unknowns.size + (budget?.deferredUnknowns.size ?? 0) >=
      state.unknownCapacity
  ) {
    recordSemanticUnknownOmission(state, {
      family: input.family,
      reason: input.reason,
      occurrences: 1,
    });
    budget?.omitUnknown(input.family, input.reason);
    return;
  }
  const unknown = createJavaScriptSemanticGraphUnknown(
    input,
    state.evidenceContexts,
  );
  if (
    state.unknowns.has(unknown.unknown_id) ||
    budget?.deferredUnknowns.has(unknown.unknown_id)
  )
    return;
  if (budget === undefined) {
    state.unknowns.set(unknown.unknown_id, unknown);
    return;
  }
  budget.countUnknown(unknown);
  if (
    budget.reservePending(unknown.unknown_id, unknown, state.evidenceContexts)
  )
    budget.deferredUnknowns.set(unknown.unknown_id, unknown);
};

/**
 * Close one budgeted file: offer fingerprints, then unknown frontiers with the
 * nodes they name, then nodes no admitted fact referenced. Report exact counts.
 */
export const finishSemanticFileBudget = (
  state: SemanticGraphProjectionState,
  budget: SemanticFileGraphBudget,
  fingerprints: readonly JavaScriptSemanticFingerprint[],
): {
  readonly fingerprints: JavaScriptSemanticFingerprint[];
  readonly coverage: JavaScriptSemanticFileProjectionCoverage;
} => {
  const retainedFingerprints = [...budget.retainedFingerprints.values()];
  for (const fingerprint of fingerprints) {
    if (budget.retainedFingerprints.has(fingerprint.function_node_id)) continue;
    if (
      admitSemanticFact(
        state,
        budget,
        [fingerprint.function_node_id],
        fingerprint,
      )
    )
      retainedFingerprints.push(fingerprint);
  }
  for (const unknown of budget.deferredUnknowns.values()) {
    let retained = unknown;
    let admitted = admitSemanticFact(
      state,
      budget,
      [
        ...(unknown.node_id === null ? [] : [unknown.node_id]),
        ...unknown.candidate_node_ids,
      ],
      unknown,
    );
    if (!admitted && budget.nodeLimitReached && !budget.closed) {
      // Preserve a frontier even when its referenced node could not be kept.
      // Its source evidence remains intact; unavailable links must not point
      // at discarded graph identities.
      const { unknown_id: _id, evidence, ...fields } = unknown;
      retained = createJavaScriptSemanticGraphUnknown(
        {
          ...fields,
          node_id:
            unknown.node_id !== null && state.nodes.has(unknown.node_id)
              ? unknown.node_id
              : null,
          candidate_node_ids: unknown.candidate_node_ids.filter((id) =>
            state.nodes.has(id),
          ),
          evidence: state.evidenceContexts.resolve(evidence),
        },
        state.evidenceContexts,
      );
      budget.releasePending(unknown.unknown_id);
      admitted = admitSemanticFact(state, budget, [], retained);
    }
    if (admitted && !state.unknowns.has(retained.unknown_id)) {
      budget.countUnknown(unknown, true);
      state.unknowns.set(retained.unknown_id, retained);
    }
    budget.releasePending(unknown.unknown_id);
  }
  budget.deferredUnknowns.clear();
  for (const nodeId of budget.pendingNodes.keys()) {
    if (!admitSemanticFact(state, budget, [nodeId])) budget.omitNode(nodeId);
    budget.releasePending(nodeId);
  }
  budget.pendingNodes.clear();
  const omittedFingerprints = Math.max(
    0,
    fingerprints.length - retainedFingerprints.length,
  );
  const truncated =
    budget.incomplete ||
    budget.omittedNodes > 0 ||
    budget.omittedRelations > 0 ||
    omittedFingerprints > 0 ||
    budget.unknownCounts.some(
      ({ total, retained }) => total === null || retained < total,
    );
  return {
    fingerprints: retainedFingerprints,
    coverage: {
      status: truncated ? "truncated" : "complete",
      graph_byte_budget: budget.byteLimitReached ? budget.limit : null,
      retained_graph_bytes: budget.used,
      omitted_nodes: budget.incomplete ? null : budget.omittedNodes,
      omitted_relations:
        budget.incomplete || budget.omittedNodes > 0
          ? null
          : budget.omittedRelations,
      omitted_fingerprints: budget.incomplete ? null : omittedFingerprints,
      unknowns: budget.unknownCounts,
    },
  };
};

/** Add a truthful root when no source file could produce semantic IR. */
export const addSemanticFallbackRoot = (
  rootArtifactSha256: string,
  state: SemanticGraphProjectionState,
): void => {
  const node = addSemanticGraphNode(
    state,
    createJavaScriptSemanticGraphNode(
      {
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
      },
      state.evidenceContexts,
    ),
  );
  if (node !== null) state.roots.add(node.node_id);
};

function* indexApplicationNodesSteps(
  nodes: JavaScriptApplicationGraph["nodes"],
): Generator<void, ReadonlyMap<string, string[]>> {
  const identifiers = new Map<string, Set<string>>();
  for (const node of nodes) {
    yield;
    for (const observation of node.observations) {
      yield;
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
  const indexed = new Map<string, string[]>();
  for (const [key, values] of identifiers) {
    indexed.set(key, [...values].sort());
    yield;
  }
  return indexed;
}

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
    range === null ? "artifact-path" : javascriptSourceRangeKey(range),
  ].join("\u0000");
