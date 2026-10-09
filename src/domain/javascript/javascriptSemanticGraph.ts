import { z } from "zod";

import { canonicalJson } from "../comparisonSemantics.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { canonicalJsonDigestSteps } from "../canonicalJsonDigestSteps.js";
import { freezeOwnedJsonSnapshotSteps } from "../immutableJson.js";
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

const normalizeEvidence = (
  evidence: ApplicationGraphEvidence,
): ApplicationGraphEvidence => ({
  ...evidence,
  coverage: {
    ...evidence.coverage,
    limits: [...evidence.coverage.limits].sort((left, right) =>
      compareUnicodeCodePoints(
        canonicalJson(left, "JavaScript semantic graph"),
        canonicalJson(right, "JavaScript semantic graph"),
      ),
    ),
  },
  limitations: uniqueSorted(evidence.limitations),
  evidence_ids: uniqueSorted(evidence.evidence_ids),
});

/** Derive a semantic node ID from its kind and exact artifact identity. */
export const javaScriptSemanticNodeId = (
  node: Pick<JavaScriptSemanticGraphNode, "kind" | "identity">,
): string =>
  `jsrg_node_${digestCanonicalValue({ kind: node.kind, identity: node.identity }, "JavaScript semantic graph")}`;

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
    node_id: javaScriptSemanticNodeId(semantic),
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
    relation_id: `jsrg_relation_${digestCanonicalValue(semantic, "JavaScript semantic graph")}`,
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
    unknown_id: `jsrg_unknown_${digestCanonicalValue(semantic, "JavaScript semantic graph")}`,
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
  const fingerprintSha256 = digestCanonicalValue(
    semantic.components,
    "JavaScript semantic graph",
  );
  return javaScriptSemanticFingerprintSchema.parse({
    ...semantic,
    fingerprint_sha256: fingerprintSha256,
    fingerprint_id: `jsrg_fingerprint_${digestCanonicalValue(
      {
        function_node_id: semantic.function_node_id,
        algorithm: semantic.algorithm,
        fingerprint_sha256: fingerprintSha256,
      },
      "JavaScript semantic graph",
    )}`,
  });
};

type GraphRecord = z.infer<typeof javaScriptSemanticGraphRecordSchema>;

type SemanticGraphIssue = {
  readonly code: "custom";
  readonly path: PropertyKey[];
  readonly message: string;
};

interface GraphIssueReporter {
  readonly addIssue: (issue: SemanticGraphIssue) => void;
}

const sortedUniqueIssue = (
  values: readonly string[],
  path: PropertyKey[],
  label: string,
  context: GraphIssueReporter,
): void => {
  for (let index = 1; index < values.length; index += 1) {
    if (
      compareUnicodeCodePoints(values[index - 1] ?? "", values[index] ?? "") < 0
    )
      continue;
    context.addIssue({
      code: "custom",
      path: [...path, index],
      message: `${label} must be sorted and unique`,
    });
    return;
  }
};

function* checkCoverageSteps(
  graph: GraphRecord,
  context: GraphIssueReporter,
): Generator<void> {
  const families = graph.coverage.families.map(({ family }) => family);
  if (
    canonicalJson(families, "JavaScript semantic graph") !==
    canonicalJson(
      JAVASCRIPT_SEMANTIC_RELATION_FAMILIES,
      "JavaScript semantic graph",
    )
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
  for (const [index, relation] of graph.relations.entries()) {
    if (index % 256 === 0) yield;
    const family = JAVASCRIPT_SEMANTIC_RELATION_FAMILY[relation.relation];
    relationsByFamily.set(family, (relationsByFamily.get(family) ?? 0) + 1);
  }
  const unknownsById = new Map<string, GraphRecord["unknowns"][number]>();
  for (const [index, unknown] of graph.unknowns.entries()) {
    if (index % 256 === 0) yield;
    unknownsById.set(unknown.unknown_id, unknown);
  }
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
}

const checkCanonicalOrder = (
  graph: GraphRecord,
  context: GraphIssueReporter,
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

function* checkNodesSteps(
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  context: GraphIssueReporter,
): Generator<void> {
  for (const [index, node] of graph.nodes.entries()) {
    if (index % 256 === 0) yield;
    if (node.node_id !== javaScriptSemanticNodeId(node))
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
}

function* checkRootsSteps(
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  context: GraphIssueReporter,
): Generator<void> {
  for (const [index, root] of graph.root_node_ids.entries()) {
    if (index % 256 === 0) yield;
    if (!nodes.has(root))
      context.addIssue({
        code: "custom",
        path: ["root_node_ids"],
        message: "Root identifier must name a semantic node",
      });
  }
}

function* checkRelationsSteps(
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  context: GraphIssueReporter,
): Generator<void> {
  for (const [index, relation] of graph.relations.entries()) {
    if (index % 256 === 0) yield;
    const { relation_id: identifier, ...semantic } = relation;
    if (
      identifier !==
      "jsrg_relation_" +
        digestCanonicalValue(semantic, "JavaScript semantic graph")
    )
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
}

function* checkUnknownsSteps(
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  context: GraphIssueReporter,
): Generator<void> {
  for (const [index, unknown] of graph.unknowns.entries()) {
    if (index % 256 === 0) yield;
    const { unknown_id: identifier, ...semantic } = unknown;
    if (
      identifier !==
      "jsrg_unknown_" +
        digestCanonicalValue(semantic, "JavaScript semantic graph")
    )
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
    if (unknown.candidate_node_ids.some((nodeId) => !nodes.has(nodeId)))
      context.addIssue({
        code: "custom",
        path: ["unknowns", index, "candidate_node_ids"],
        message: "Unknown frontier candidate node is absent",
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
}

const checkUnknownReferences = (
  graph: GraphRecord,
  context: GraphIssueReporter,
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

function* checkFingerprintsSteps(
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  context: GraphIssueReporter,
): Generator<void> {
  for (const [index, fingerprint] of graph.fingerprints.entries()) {
    if (index % 256 === 0) yield;
    if (nodes.get(fingerprint.function_node_id)?.kind !== "function")
      context.addIssue({
        code: "custom",
        path: ["fingerprints", index, "function_node_id"],
        message: "Fingerprint must name a function node",
      });
    if (
      fingerprint.fingerprint_sha256 !==
      digestCanonicalValue(fingerprint.components, "JavaScript semantic graph")
    )
      context.addIssue({
        code: "custom",
        path: ["fingerprints", index, "fingerprint_sha256"],
        message: "Fingerprint component commitment is stale",
      });
    const expectedIdentifier =
      "jsrg_fingerprint_" +
      digestCanonicalValue(
        {
          function_node_id: fingerprint.function_node_id,
          algorithm: fingerprint.algorithm,
          fingerprint_sha256: fingerprint.fingerprint_sha256,
        },
        "JavaScript semantic graph",
      );
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
}

function* checkGraphContentSteps(
  graph: GraphRecord,
  context: GraphIssueReporter,
): Generator<void> {
  checkCanonicalOrder(graph, context);
  const nodes = new Map<string, JavaScriptSemanticGraphNode>();
  for (const [index, node] of graph.nodes.entries()) {
    if (index % 256 === 0) yield;
    nodes.set(node.node_id, node);
  }
  yield* checkNodesSteps(graph, nodes, context);
  yield* checkRootsSteps(graph, nodes, context);
  yield* checkRelationsSteps(graph, nodes, context);
  yield* checkUnknownsSteps(graph, nodes, context);
  checkUnknownReferences(graph, context);
  yield* checkFingerprintsSteps(graph, nodes, context);
  yield* checkCoverageSteps(graph, context);
  if (graph.coverage.status !== "complete" && graph.limitations.length === 0)
    context.addIssue({
      code: "custom",
      path: ["limitations"],
      message: "Non-complete graph coverage requires a limitation",
    });
}

const checkGraphContent = (
  graph: GraphRecord,
  context: GraphIssueReporter,
): void => {
  const steps = checkGraphContentSteps(graph, context);
  while (!steps.next().done) {
    // Synchronous callers apply the same integrity checks without scheduling.
  }
};

const checkGraph = (graph: GraphRecord, context: GraphIssueReporter): void => {
  checkGraphContent(graph, context);
  const { graph_id: identifier, ...semantic } = graph;
  if (
    identifier !==
    "jsrg_" + digestCanonicalValue(semantic, "JavaScript semantic graph")
  )
    context.addIssue({
      code: "custom",
      path: ["graph_id"],
      message: "Graph identifier is stale",
    });
};

/** Strict semantic graph schema with verified canonical commitments. */
export const javaScriptSemanticGraphSchema =
  javaScriptSemanticGraphRecordSchema.superRefine(checkGraph);

/** Fully validated JavaScript Semantic Relation Graph. */
export type JavaScriptSemanticGraph = z.infer<
  typeof javaScriptSemanticGraphSchema
>;

const normalizeGraphInput = (
  parsed: JavaScriptSemanticGraphInput,
): JavaScriptSemanticGraphInput => ({
  ...parsed,
  root_node_ids: uniqueSorted(parsed.root_node_ids),
  nodes: [...parsed.nodes].sort((left, right) =>
    compareUnicodeCodePoints(left.node_id, right.node_id),
  ),
  relations: [...parsed.relations].sort((left, right) =>
    compareUnicodeCodePoints(left.relation_id, right.relation_id),
  ),
  fingerprints: [...parsed.fingerprints].sort((left, right) =>
    compareUnicodeCodePoints(left.fingerprint_id, right.fingerprint_id),
  ),
  unknowns: [...parsed.unknowns].sort((left, right) =>
    compareUnicodeCodePoints(left.unknown_id, right.unknown_id),
  ),
  coverage: {
    ...parsed.coverage,
    limits: [...parsed.coverage.limits].sort((left, right) =>
      compareUnicodeCodePoints(
        canonicalJson(left, "JavaScript semantic graph"),
        canonicalJson(right, "JavaScript semantic graph"),
      ),
    ),
    families: [...parsed.coverage.families]
      .map((family) => ({
        ...family,
        unknown_ids: uniqueSorted(family.unknown_ids),
      }))
      .sort((left, right) =>
        compareUnicodeCodePoints(left.family, right.family),
      ),
  },
  limitations: uniqueSorted(parsed.limitations),
});

/** Normalize a complete companion graph and derive its graph ID. */
export const createJavaScriptSemanticGraph = (
  input: unknown,
): JavaScriptSemanticGraph => {
  const semantic = normalizeGraphInput(
    javaScriptSemanticGraphInputSchema.parse(input),
  );
  // The input schema already cloned and validated every field. Validate the
  // normalized relationships in place, then derive the only added field. The
  // public schema still verifies arbitrary records and their commitments.
  const record: GraphRecord = {
    ...semantic,
    graph_id: `jsrg_${digestCanonicalValue(semantic, "JavaScript semantic graph")}`,
  };
  const issues: SemanticGraphIssue[] = [];
  checkGraphContent(record, {
    addIssue: (issue) => {
      issues.push(issue);
    },
  });
  if (issues.length > 0) throw new z.ZodError(issues);
  return record;
};

const validatedImmutableSemanticGraphs = new WeakSet<object>();

/** Clone input synchronously; commit, check and seal the owned graph in steps. */
export const createImmutableJavaScriptSemanticGraphSteps = (
  input: unknown,
): Generator<void, JavaScriptSemanticGraph> =>
  validateAndSealSemanticGraphSteps(
    normalizeGraphInput(javaScriptSemanticGraphInputSchema.parse(input)),
  );

function* validateAndSealSemanticGraphSteps(
  semantic: JavaScriptSemanticGraphInput,
): Generator<void, JavaScriptSemanticGraph> {
  const graph: GraphRecord = {
    ...semantic,
    graph_id: `jsrg_${yield* canonicalJsonDigestSteps(semantic)}`,
  };
  const issues: SemanticGraphIssue[] = [];
  yield* checkGraphContentSteps(graph, {
    addIssue: (issue) => {
      issues.push(issue);
    },
  });
  if (issues.length > 0) throw new z.ZodError(issues);
  yield* freezeOwnedJsonSnapshotSteps(graph);
  validatedImmutableSemanticGraphs.add(graph);
  return graph;
}

/** Recognize the exact completely sealed graph produced by the owned factory. */
export const isValidatedImmutableJavaScriptSemanticGraph = (
  value: unknown,
): value is JavaScriptSemanticGraph =>
  typeof value === "object" &&
  value !== null &&
  validatedImmutableSemanticGraphs.has(value);
