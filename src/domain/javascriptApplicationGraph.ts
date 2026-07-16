import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import type {
  ApplicationGraphEvidence,
  ApplicationNodeIdentity,
} from "./javascriptApplicationEvidenceSchemas.js";
import {
  applicationEdgeInputSchema,
  applicationEdgeSchema,
  applicationNodeInputSchema,
  applicationNodeObservationSchema,
  applicationNodeSchema,
  javascriptApplicationGraphInputSchema,
  javascriptApplicationGraphRecordSchema,
  type ApplicationEdge,
  type ApplicationNode,
  type JavaScriptApplicationGraphInput,
} from "./javascriptApplicationGraphSchemas.js";

/** Compare strings by Unicode code point for canonical graph ordering. */
export const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError(
      "JavaScript Application Graph could not canonicalize data",
    );
  return encoded;
};

const digestCanonical = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const OBSERVATION_IDENTIFIER_STRATEGY = {
  strategy: "semantic-content-sha256" as const,
  stability: "observation-exact" as const,
};
const EDGE_IDENTIFIER_STRATEGY = {
  strategy: "semantic-content-sha256" as const,
  stability: "relationship-exact" as const,
};

const uniqueSorted = <Value extends string>(
  values: readonly Value[],
): Value[] => [...new Set(values)].sort(compareCodePoints);

const limitKey = (
  limit: ApplicationGraphEvidence["coverage"]["limits"][number],
) => canonicalJson(limit);

const normalizeLimits = (
  limits: ApplicationGraphEvidence["coverage"]["limits"],
): ApplicationGraphEvidence["coverage"]["limits"] =>
  [...new Map(limits.map((limit) => [limitKey(limit), limit])).values()].sort(
    (left, right) => compareCodePoints(limitKey(left), limitKey(right)),
  );

const normalizeEvidence = (
  evidence: ApplicationGraphEvidence,
): ApplicationGraphEvidence => ({
  ...evidence,
  coverage: {
    ...evidence.coverage,
    limits: normalizeLimits(evidence.coverage.limits),
  },
  limitations: uniqueSorted(evidence.limitations),
  evidence_ids: uniqueSorted(evidence.evidence_ids),
});

const normalizeIdentity = (
  identity: ApplicationNodeIdentity,
): ApplicationNodeIdentity =>
  identity.strategy === "structural-fingerprint"
    ? { ...identity, basis: uniqueSorted(identity.basis) }
    : identity;

const nodeSemantic = (node: Pick<ApplicationNode, "kind" | "identity">) => ({
  kind: node.kind,
  identity: node.identity,
});

const nodeId = (node: Pick<ApplicationNode, "kind" | "identity">): string =>
  `jag_node_${digestCanonical(nodeSemantic(node))}`;

const observationSemantic = (
  nodeIdentifier: string,
  observation: Omit<
    z.infer<typeof applicationNodeObservationSchema>,
    "observation_id"
  >,
) => ({ node_id: nodeIdentifier, ...observation });

const observationId = (
  nodeIdentifier: string,
  observation: Omit<
    z.infer<typeof applicationNodeObservationSchema>,
    "observation_id"
  >,
): string =>
  `jag_observation_${digestCanonical(
    observationSemantic(nodeIdentifier, observation),
  )}`;

type EdgeSemantic = Omit<ApplicationEdge, "edge_id">;

const edgeId = (edge: EdgeSemantic): string =>
  `jag_edge_${digestCanonical(edge)}`;

const sortedUniqueIssue = (
  values: readonly string[],
  path: PropertyKey[],
  label: string,
  context: z.RefinementCtx,
): void => {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodePoints(values[index - 1] ?? "", values[index] ?? "") < 0)
      continue;
    context.addIssue({
      code: "custom",
      message: `${label} must be sorted and unique by Unicode code point`,
      path: [...path, index],
    });
    return;
  }
};

const checkEvidenceNormalization = (
  evidence: ApplicationGraphEvidence,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void => {
  sortedUniqueIssue(
    evidence.limitations,
    [...path, "limitations"],
    "Evidence limitations",
    context,
  );
  sortedUniqueIssue(
    evidence.evidence_ids,
    [...path, "evidence_ids"],
    "Evidence identifiers",
    context,
  );
  sortedUniqueIssue(
    evidence.coverage.limits.map(limitKey),
    [...path, "coverage", "limits"],
    "Evidence limits",
    context,
  );

  const runtimeLocation =
    evidence.location.available && evidence.location.value.kind === "runtime";
  const staticAuthority = [
    "artifact-bytes",
    "ast-static-analysis",
    "static-relationship-inference",
    "native-analysis-provider",
  ].includes(evidence.authority);
  if (runtimeLocation && staticAuthority)
    context.addIssue({
      code: "custom",
      message: "Static and native authorities cannot claim a runtime location",
      path: [...path, "location"],
    });
};

const observationMatchesIdentity = (
  node: ApplicationNode,
  observation: ApplicationNode["observations"][number],
): boolean => {
  const { identity } = node;
  const { evidence } = observation;
  if (identity.strategy === "content-digest")
    return (
      evidence.state === "observed" &&
      evidence.artifact.available &&
      evidence.artifact.sha256 === identity.sha256
    );
  if (identity.strategy === "source-map-original")
    return (
      evidence.state === "observed" &&
      evidence.artifact.available &&
      evidence.artifact.sha256 === identity.source_map_sha256
    );
  if (identity.strategy === "canonical-path")
    return (
      evidence.artifact.available &&
      evidence.artifact.sha256 === identity.artifact_sha256 &&
      evidence.location.available &&
      evidence.location.value.kind === "artifact-path" &&
      evidence.location.value.path === identity.path
    );
  if (identity.strategy === "artifact-local-key")
    return (
      evidence.artifact.available &&
      evidence.artifact.sha256 === identity.artifact_sha256
    );
  if (identity.strategy === "runtime-instance") {
    if (
      !["passive-cdp-runtime", "controlled-replay"].includes(
        evidence.authority,
      ) ||
      !evidence.location.available ||
      evidence.location.value.kind !== "runtime"
    )
      return false;
    const location = evidence.location.value;
    return (
      location.capture_sha256 === identity.capture_sha256 &&
      [location.target_key, location.frame_key, location.script_key].includes(
        identity.runtime_key,
      )
    );
  }
  if (identity.strategy === "structural-fingerprint")
    return evidence.state === "inferred";
  return evidence.state === "observed";
};

const checkNode = (
  node: ApplicationNode,
  index: number,
  context: z.RefinementCtx,
): void => {
  if (node.node_id !== nodeId(node))
    context.addIssue({
      code: "custom",
      message: "Node identifier does not match its kind and identity",
      path: ["nodes", index, "node_id"],
    });
  if (
    node.identity.strategy === "structural-fingerprint" &&
    canonicalJson(node.identity.basis) !==
      canonicalJson(uniqueSorted(node.identity.basis))
  )
    context.addIssue({
      code: "custom",
      message: "Structural fingerprint basis must be sorted and unique",
      path: ["nodes", index, "identity", "basis"],
    });

  sortedUniqueIssue(
    node.observations.map(({ observation_id: id }) => id),
    ["nodes", index, "observations"],
    "Node observations",
    context,
  );
  for (const [observationIndex, observation] of node.observations.entries()) {
    const { observation_id: identifier, ...semantic } = observation;
    if (identifier !== observationId(node.node_id, semantic))
      context.addIssue({
        code: "custom",
        message: "Observation identifier does not match its semantic content",
        path: [
          "nodes",
          index,
          "observations",
          observationIndex,
          "observation_id",
        ],
      });
    checkEvidenceNormalization(
      observation.evidence,
      ["nodes", index, "observations", observationIndex, "evidence"],
      context,
    );
  }
  if (
    !node.observations.some((observation) =>
      observationMatchesIdentity(node, observation),
    )
  )
    context.addIssue({
      code: "custom",
      message: "Node identity is not supported by a compatible observation",
      path: ["nodes", index, "identity"],
    });
};

type GraphRecord = z.infer<typeof javascriptApplicationGraphRecordSchema>;

const checkGraphInvariants = (
  graph: GraphRecord,
  context: z.RefinementCtx,
): void => {
  sortedUniqueIssue(
    graph.root_node_ids,
    ["root_node_ids"],
    "Root nodes",
    context,
  );
  sortedUniqueIssue(
    graph.nodes.map(({ node_id: id }) => id),
    ["nodes"],
    "Nodes",
    context,
  );
  sortedUniqueIssue(
    graph.edges.map(({ edge_id: id }) => id),
    ["edges"],
    "Edges",
    context,
  );
  sortedUniqueIssue(
    graph.limitations,
    ["limitations"],
    "Graph limitations",
    context,
  );
  sortedUniqueIssue(
    graph.coverage.limits.map(limitKey),
    ["coverage", "limits"],
    "Graph limits",
    context,
  );
  if (graph.coverage.status !== "complete" && graph.limitations.length === 0)
    context.addIssue({
      code: "custom",
      message: "Non-complete graph coverage requires an explicit limitation",
      path: ["limitations"],
    });

  const nodesById = new Map(graph.nodes.map((node) => [node.node_id, node]));
  for (const root of graph.root_node_ids)
    if (!nodesById.has(root))
      context.addIssue({
        code: "custom",
        message: "Root identifier must name a graph node",
        path: ["root_node_ids"],
      });
  for (const [index, node] of graph.nodes.entries())
    checkNode(node, index, context);
  for (const [index, edge] of graph.edges.entries()) {
    const { edge_id: identifier, ...semantic } = edge;
    if (identifier !== edgeId(semantic))
      context.addIssue({
        code: "custom",
        message: "Edge identifier does not match its semantic content",
        path: ["edges", index, "edge_id"],
      });
    if (
      !nodesById.has(edge.source_node_id) ||
      !nodesById.has(edge.target_node_id)
    )
      context.addIssue({
        code: "custom",
        message: "Edge endpoints must name graph nodes",
        path: ["edges", index],
      });
    if (edge.source_node_id === edge.target_node_id)
      context.addIssue({
        code: "custom",
        message: "Application graph edges cannot be self-referential",
        path: ["edges", index],
      });
    if (
      edge.relation === "changed_from" &&
      nodesById.get(edge.source_node_id)?.kind !==
        nodesById.get(edge.target_node_id)?.kind
    )
      context.addIssue({
        code: "custom",
        message: "changed_from endpoints must have the same node kind",
        path: ["edges", index, "relation"],
      });
    checkEvidenceNormalization(
      edge.evidence,
      ["edges", index, "evidence"],
      context,
    );
  }

  const { graph_id: identifier, ...semantic } = graph;
  if (identifier !== `jag_${digestCanonical(semantic)}`)
    context.addIssue({
      code: "custom",
      message: "Graph identifier does not match its semantic content",
      path: ["graph_id"],
    });
};

/** Strict versioned JavaScript Application Graph with verified commitments. */
export const javascriptApplicationGraphSchema =
  javascriptApplicationGraphRecordSchema.superRefine(checkGraphInvariants);

/** Fully validated JavaScript Application Graph v1. */
export type JavaScriptApplicationGraph = z.infer<
  typeof javascriptApplicationGraphSchema
>;

/** Build one normalized application entity and derive all semantic IDs. */
export const createJavaScriptApplicationNode = (
  input: unknown,
): ApplicationNode => {
  const parsed = applicationNodeInputSchema.parse(input);
  const identity = normalizeIdentity(parsed.identity);
  const identifier = nodeId({ kind: parsed.kind, identity });
  const observations = parsed.observations
    .map((observation) => {
      const semantic = {
        ...observation,
        evidence: normalizeEvidence(observation.evidence),
        identifier_strategy: OBSERVATION_IDENTIFIER_STRATEGY,
      };
      return applicationNodeObservationSchema.parse({
        ...semantic,
        observation_id: observationId(identifier, semantic),
      });
    })
    .sort((left, right) =>
      compareCodePoints(left.observation_id, right.observation_id),
    );
  return applicationNodeSchema.parse({
    node_id: identifier,
    kind: parsed.kind,
    identity,
    observations,
  });
};

/** Build one normalized directed relationship and derive its semantic ID. */
export const createJavaScriptApplicationEdge = (
  input: unknown,
): ApplicationEdge => {
  const parsed = applicationEdgeInputSchema.parse(input);
  const semantic = {
    ...parsed,
    evidence: normalizeEvidence(parsed.evidence),
    identifier_strategy: EDGE_IDENTIFIER_STRATEGY,
  };
  return applicationEdgeSchema.parse({
    ...semantic,
    edge_id: edgeId(semantic),
  });
};

/** Normalize a complete graph and derive its top-level semantic ID. */
export const createJavaScriptApplicationGraph = (
  input: unknown,
): JavaScriptApplicationGraph => {
  const parsed = javascriptApplicationGraphInputSchema.parse(input);
  const semantic: JavaScriptApplicationGraphInput = {
    ...parsed,
    root_node_ids: uniqueSorted(parsed.root_node_ids),
    nodes: [...parsed.nodes].sort((left, right) =>
      compareCodePoints(left.node_id, right.node_id),
    ),
    edges: [...parsed.edges].sort((left, right) =>
      compareCodePoints(left.edge_id, right.edge_id),
    ),
    coverage: {
      ...parsed.coverage,
      limits: normalizeLimits(parsed.coverage.limits),
    },
    limitations: uniqueSorted(parsed.limitations),
  };
  return javascriptApplicationGraphSchema.parse({
    ...semantic,
    graph_id: `jag_${digestCanonical(semantic)}`,
  });
};

/** Parse a stored graph, rejecting unsupported versions and stale IDs. */
export const parseJavaScriptApplicationGraph = (
  input: unknown,
): JavaScriptApplicationGraph => {
  const envelope = z
    .object({ schema: z.string(), schema_version: z.number() })
    .passthrough()
    .safeParse(input);
  if (
    envelope.success &&
    envelope.data.schema === "JavaScriptApplicationGraph" &&
    envelope.data.schema_version !== 1
  )
    throw new TypeError(
      `Unsupported JavaScript Application Graph schema version: ${String(envelope.data.schema_version)}`,
    );
  return javascriptApplicationGraphSchema.parse(input);
};

/** Compute the byte-stable SHA-256 commitment of a verified graph. */
export const computeJavaScriptApplicationGraphSha256 = (
  input: unknown,
): string => digestCanonical(parseJavaScriptApplicationGraph(input));

/** Serialize a verified graph as RFC 8785 canonical JSON. */
export const serializeJavaScriptApplicationGraph = (input: unknown): string =>
  canonicalJson(parseJavaScriptApplicationGraph(input));

export type { ApplicationEdge, ApplicationGraphEvidence, ApplicationNode };
