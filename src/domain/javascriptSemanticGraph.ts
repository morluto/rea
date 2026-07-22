import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { compareCodePoints } from "./javascriptApplicationGraph.js";
import type { ApplicationGraphEvidence } from "./javascriptApplicationEvidenceSchemas.js";
import {
  JAVASCRIPT_SEMANTIC_RELATION_FAMILIES,
  JAVASCRIPT_SEMANTIC_RELATION_FAMILY,
  javaScriptSemanticFingerprintInputSchema,
  javaScriptSemanticFingerprintSchema,
  javaScriptSemanticGraphInputSchema,
  javaScriptSemanticGraphRecordSchema,
  javaScriptSemanticNodeInputSchema,
  javaScriptSemanticNodeSchema,
  javaScriptSemanticRelationInputSchema,
  javaScriptSemanticRelationSchema,
  javaScriptSemanticUnknownInputSchema,
  javaScriptSemanticUnknownSchema,
  type JavaScriptSemanticGraphInput,
  type JavaScriptSemanticGraphNode,
  type JavaScriptSemanticGraphRelation,
} from "./javascriptSemanticGraphSchemas.js";

const canonicalJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError(
      "JavaScript semantic graph could not canonicalize data",
    );
  return encoded;
};

const digestCanonical = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const uniqueSorted = <Value extends string>(
  values: readonly Value[],
): Value[] => [...new Set(values)].sort(compareCodePoints);

const normalizeEvidence = (
  evidence: ApplicationGraphEvidence,
): ApplicationGraphEvidence => ({
  ...evidence,
  coverage: {
    ...evidence.coverage,
    limits: [...evidence.coverage.limits].sort((left, right) =>
      compareCodePoints(canonicalJson(left), canonicalJson(right)),
    ),
  },
  limitations: uniqueSorted(evidence.limitations),
  evidence_ids: uniqueSorted(evidence.evidence_ids),
});

const nodeIdentity = (
  node: Pick<JavaScriptSemanticGraphNode, "kind" | "identity">,
) => ({ kind: node.kind, identity: node.identity });

const nodeId = (
  node: Pick<JavaScriptSemanticGraphNode, "kind" | "identity">,
): string => `jsrg_node_${digestCanonical(nodeIdentity(node))}`;

/** Normalize one semantic entity and derive its artifact-version identifier. */
export const createJavaScriptSemanticGraphNode = (
  input: unknown,
): JavaScriptSemanticGraphNode => {
  const parsed = javaScriptSemanticNodeInputSchema.parse(input);
  const semantic = {
    ...parsed,
    application_node_ids: uniqueSorted(parsed.application_node_ids),
    evidence: normalizeEvidence(parsed.evidence),
    identifier_strategy: {
      strategy: "semantic-content-sha256" as const,
      stability: "artifact-version" as const,
    },
  };
  return javaScriptSemanticNodeSchema.parse({
    ...semantic,
    node_id: nodeId(semantic),
  });
};

/** Normalize one semantic relationship and derive its exact identifier. */
export const createJavaScriptSemanticGraphRelation = (
  input: unknown,
): JavaScriptSemanticGraphRelation => {
  const parsed = javaScriptSemanticRelationInputSchema.parse(input);
  const semantic = {
    ...parsed,
    evidence: normalizeEvidence(parsed.evidence),
    identifier_strategy: {
      strategy: "semantic-content-sha256" as const,
      stability: "relationship-exact" as const,
    },
  };
  return javaScriptSemanticRelationSchema.parse({
    ...semantic,
    relation_id: `jsrg_relation_${digestCanonical(semantic)}`,
  });
};

/** Normalize one unresolved semantic frontier and derive its identifier. */
export const createJavaScriptSemanticGraphUnknown = (input: unknown) => {
  const parsed = javaScriptSemanticUnknownInputSchema.parse(input);
  const semantic = {
    ...parsed,
    relation_kinds: uniqueSorted(parsed.relation_kinds),
    candidate_node_ids: uniqueSorted(parsed.candidate_node_ids),
    evidence: normalizeEvidence(parsed.evidence),
  };
  return javaScriptSemanticUnknownSchema.parse({
    ...semantic,
    unknown_id: `jsrg_unknown_${digestCanonical(semantic)}`,
  });
};

/** Normalize one function fingerprint and derive its component commitment. */
export const createJavaScriptSemanticFingerprint = (input: unknown) => {
  const parsed = javaScriptSemanticFingerprintInputSchema.parse(input);
  const semantic = {
    ...parsed,
    components: {
      ...parsed.components,
      effects: uniqueSorted(parsed.components.effects),
    },
    limitations: uniqueSorted(parsed.limitations),
    evidence: normalizeEvidence(parsed.evidence),
  };
  const fingerprintSha256 = digestCanonical(semantic.components);
  return javaScriptSemanticFingerprintSchema.parse({
    ...semantic,
    fingerprint_sha256: fingerprintSha256,
    fingerprint_id: `jsrg_fingerprint_${digestCanonical({
      function_node_id: semantic.function_node_id,
      algorithm: semantic.algorithm,
      fingerprint_sha256: fingerprintSha256,
    })}`,
  });
};

type GraphRecord = z.infer<typeof javaScriptSemanticGraphRecordSchema>;

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
      path: [...path, index],
      message: `${label} must be sorted and unique`,
    });
    return;
  }
};

const checkCoverage = (graph: GraphRecord, context: z.RefinementCtx): void => {
  const families = graph.coverage.families.map(({ family }) => family);
  if (
    canonicalJson(families) !==
    canonicalJson(JAVASCRIPT_SEMANTIC_RELATION_FAMILIES)
  )
    context.addIssue({
      code: "custom",
      path: ["coverage", "families"],
      message:
        "Coverage must name every semantic relation family once in canonical order",
    });
  if (
    graph.coverage.status === "complete" &&
    (graph.coverage.truncated ||
      graph.coverage.omitted_nodes !== 0 ||
      graph.coverage.omitted_relations !== 0 ||
      graph.coverage.families.some(({ status }) => status !== "complete"))
  )
    context.addIssue({
      code: "custom",
      path: ["coverage"],
      message: "Complete graph coverage cannot omit or truncate semantic facts",
    });
  if (graph.coverage.truncated && graph.coverage.limits.length === 0)
    context.addIssue({
      code: "custom",
      path: ["coverage", "limits"],
      message: "Truncated graph coverage must identify an effective limit",
    });
  const relationsByFamily = new Map(
    JAVASCRIPT_SEMANTIC_RELATION_FAMILIES.map((family) => [family, 0]),
  );
  for (const relation of graph.relations) {
    const family = JAVASCRIPT_SEMANTIC_RELATION_FAMILY[relation.relation];
    relationsByFamily.set(family, (relationsByFamily.get(family) ?? 0) + 1);
  }
  const unknownsById = new Map(
    graph.unknowns.map((unknown) => [unknown.unknown_id, unknown]),
  );
  for (const [index, family] of graph.coverage.families.entries()) {
    if (family.retained_relations !== relationsByFamily.get(family.family))
      context.addIssue({
        code: "custom",
        path: ["coverage", "families", index, "retained_relations"],
        message: "Family retained relation count does not match graph content",
      });
    if (
      family.unknown_ids.some(
        (identifier) => unknownsById.get(identifier)?.family !== family.family,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["coverage", "families", index, "unknown_ids"],
        message: "Family coverage references an unknown from another family",
      });
    if (
      family.status === "complete" &&
      (family.omitted_relations !== 0 || family.unknown_ids.length > 0)
    )
      context.addIssue({
        code: "custom",
        path: ["coverage", "families", index],
        message: "Complete family coverage cannot omit or retain unknown facts",
      });
  }
};

const checkCanonicalOrder = (
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
    graph.nodes.map(({ node_id }) => node_id),
    ["nodes"],
    "Nodes",
    context,
  );
  sortedUniqueIssue(
    graph.relations.map(({ relation_id }) => relation_id),
    ["relations"],
    "Relations",
    context,
  );
  sortedUniqueIssue(
    graph.fingerprints.map(({ fingerprint_id }) => fingerprint_id),
    ["fingerprints"],
    "Fingerprints",
    context,
  );
  sortedUniqueIssue(
    graph.unknowns.map(({ unknown_id }) => unknown_id),
    ["unknowns"],
    "Unknown frontiers",
    context,
  );
  sortedUniqueIssue(graph.limitations, ["limitations"], "Limitations", context);
};

const checkNodes = (
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  context: z.RefinementCtx,
): void => {
  for (const [index, node] of graph.nodes.entries()) {
    if (node.node_id !== nodeId(node))
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "node_id"],
        message: "Node identifier is stale",
      });
    if (
      node.function_node_id !== null &&
      nodes.get(node.function_node_id)?.kind !== "function"
    )
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "function_node_id"],
        message: "Function owner must name a function node",
      });
  }
};

const checkRoots = (
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  context: z.RefinementCtx,
): void => {
  for (const root of graph.root_node_ids)
    if (!nodes.has(root))
      context.addIssue({
        code: "custom",
        path: ["root_node_ids"],
        message: "Root identifier must name a semantic node",
      });
};

const checkRelations = (
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  context: z.RefinementCtx,
): void => {
  for (const [index, relation] of graph.relations.entries()) {
    const { relation_id: identifier, ...semantic } = relation;
    if (identifier !== "jsrg_relation_" + digestCanonical(semantic))
      context.addIssue({
        code: "custom",
        path: ["relations", index, "relation_id"],
        message: "Relation identifier is stale",
      });
    if (
      !nodes.has(relation.source_node_id) ||
      !nodes.has(relation.target_node_id)
    )
      context.addIssue({
        code: "custom",
        path: ["relations", index],
        message: "Relation endpoints must name semantic nodes",
      });
    if (relation.source_node_id === relation.target_node_id)
      context.addIssue({
        code: "custom",
        path: ["relations", index],
        message: "Semantic relations cannot be self-referential",
      });
    if (
      relation.resolution === "candidate" &&
      relation.evidence.state === "observed"
    )
      context.addIssue({
        code: "custom",
        path: ["relations", index, "evidence", "state"],
        message: "Candidate relations cannot claim observed resolution",
      });
  }
};

const checkUnknowns = (
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  context: z.RefinementCtx,
): void => {
  for (const [index, unknown] of graph.unknowns.entries()) {
    const { unknown_id: identifier, ...semantic } = unknown;
    if (identifier !== "jsrg_unknown_" + digestCanonical(semantic))
      context.addIssue({
        code: "custom",
        path: ["unknowns", index, "unknown_id"],
        message: "Unknown frontier identifier is stale",
      });
    if (unknown.node_id !== null && !nodes.has(unknown.node_id))
      context.addIssue({
        code: "custom",
        path: ["unknowns", index, "node_id"],
        message: "Unknown frontier node is absent",
      });
    if (
      unknown.relation_kinds.some(
        (kind) => JAVASCRIPT_SEMANTIC_RELATION_FAMILY[kind] !== unknown.family,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["unknowns", index, "relation_kinds"],
        message: "Unknown relation kinds must belong to their declared family",
      });
    if (!["unknown", "unavailable"].includes(unknown.evidence.state))
      context.addIssue({
        code: "custom",
        path: ["unknowns", index, "evidence", "state"],
        message: "Unknown frontiers require unknown or unavailable evidence",
      });
  }
};

const checkUnknownReferences = (
  graph: GraphRecord,
  context: z.RefinementCtx,
): void => {
  const unknownIds = new Set(
    graph.unknowns.map(({ unknown_id }) => unknown_id),
  );
  for (const [index, family] of graph.coverage.families.entries())
    if (family.unknown_ids.some((identifier) => !unknownIds.has(identifier)))
      context.addIssue({
        code: "custom",
        path: ["coverage", "families", index, "unknown_ids"],
        message: "Family coverage references an absent unknown frontier",
      });
};

const checkFingerprints = (
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  context: z.RefinementCtx,
): void => {
  for (const [index, fingerprint] of graph.fingerprints.entries()) {
    if (nodes.get(fingerprint.function_node_id)?.kind !== "function")
      context.addIssue({
        code: "custom",
        path: ["fingerprints", index, "function_node_id"],
        message: "Fingerprint must name a function node",
      });
    if (
      fingerprint.fingerprint_sha256 !== digestCanonical(fingerprint.components)
    )
      context.addIssue({
        code: "custom",
        path: ["fingerprints", index, "fingerprint_sha256"],
        message: "Fingerprint component commitment is stale",
      });
    const expectedIdentifier =
      "jsrg_fingerprint_" +
      digestCanonical({
        function_node_id: fingerprint.function_node_id,
        algorithm: fingerprint.algorithm,
        fingerprint_sha256: fingerprint.fingerprint_sha256,
      });
    if (fingerprint.fingerprint_id !== expectedIdentifier)
      context.addIssue({
        code: "custom",
        path: ["fingerprints", index, "fingerprint_id"],
        message: "Fingerprint identifier is stale",
      });
    if (
      fingerprint.status !== "complete" &&
      fingerprint.limitations.length === 0
    )
      context.addIssue({
        code: "custom",
        path: ["fingerprints", index, "limitations"],
        message: "Incomplete fingerprints require a limitation",
      });
  }
};

const checkGraph = (graph: GraphRecord, context: z.RefinementCtx): void => {
  checkCanonicalOrder(graph, context);
  const nodes = new Map(graph.nodes.map((node) => [node.node_id, node]));
  checkNodes(graph, nodes, context);
  checkRoots(graph, nodes, context);
  checkRelations(graph, nodes, context);
  checkUnknowns(graph, nodes, context);
  checkUnknownReferences(graph, context);
  checkFingerprints(graph, nodes, context);
  checkCoverage(graph, context);
  if (graph.coverage.status !== "complete" && graph.limitations.length === 0)
    context.addIssue({
      code: "custom",
      path: ["limitations"],
      message: "Non-complete graph coverage requires a limitation",
    });
  const { graph_id: identifier, ...semantic } = graph;
  if (identifier !== "jsrg_" + digestCanonical(semantic))
    context.addIssue({
      code: "custom",
      path: ["graph_id"],
      message: "Graph identifier is stale",
    });
};

/** Strict semantic graph schema with verified canonical commitments. */
export const javaScriptSemanticGraphSchema =
  javaScriptSemanticGraphRecordSchema.superRefine(checkGraph);

/** Fully validated JavaScript Semantic Relation Graph v1. */
export type JavaScriptSemanticGraph = z.infer<
  typeof javaScriptSemanticGraphSchema
>;

/** Normalize a complete companion graph and derive its graph ID. */
export const createJavaScriptSemanticGraph = (
  input: unknown,
): JavaScriptSemanticGraph => {
  const parsed = javaScriptSemanticGraphInputSchema.parse(input);
  const semantic: JavaScriptSemanticGraphInput = {
    ...parsed,
    root_node_ids: uniqueSorted(parsed.root_node_ids),
    nodes: [...parsed.nodes].sort((left, right) =>
      compareCodePoints(left.node_id, right.node_id),
    ),
    relations: [...parsed.relations].sort((left, right) =>
      compareCodePoints(left.relation_id, right.relation_id),
    ),
    fingerprints: [...parsed.fingerprints].sort((left, right) =>
      compareCodePoints(left.fingerprint_id, right.fingerprint_id),
    ),
    unknowns: [...parsed.unknowns].sort((left, right) =>
      compareCodePoints(left.unknown_id, right.unknown_id),
    ),
    coverage: {
      ...parsed.coverage,
      limits: [...parsed.coverage.limits].sort((left, right) =>
        compareCodePoints(canonicalJson(left), canonicalJson(right)),
      ),
      families: [...parsed.coverage.families]
        .map((family) => ({
          ...family,
          unknown_ids: uniqueSorted(family.unknown_ids),
        }))
        .sort((left, right) => compareCodePoints(left.family, right.family)),
    },
    limitations: uniqueSorted(parsed.limitations),
  };
  return javaScriptSemanticGraphSchema.parse({
    ...semantic,
    graph_id: `jsrg_${digestCanonical(semantic)}`,
  });
};

/** Parse a stored semantic graph and reject unsupported versions or stale IDs. */
export const parseJavaScriptSemanticGraph = (
  input: unknown,
): JavaScriptSemanticGraph => {
  const envelope = z
    .object({ schema: z.string(), schema_version: z.number() })
    .passthrough()
    .safeParse(input);
  if (
    envelope.success &&
    envelope.data.schema === "JavaScriptSemanticRelationGraph" &&
    envelope.data.schema_version !== 1
  )
    throw new TypeError(
      `Unsupported JavaScript Semantic Relation Graph schema version: ${String(envelope.data.schema_version)}`,
    );
  return javaScriptSemanticGraphSchema.parse(input);
};

/** Serialize a verified semantic graph as canonical JSON. */
export const serializeJavaScriptSemanticGraph = (input: unknown): string =>
  canonicalJson(parseJavaScriptSemanticGraph(input));

/** Compute the canonical SHA-256 commitment of a verified semantic graph. */
export const computeJavaScriptSemanticGraphSha256 = (input: unknown): string =>
  digestCanonical(parseJavaScriptSemanticGraph(input));

export type { JavaScriptSemanticGraphNode, JavaScriptSemanticGraphRelation };
