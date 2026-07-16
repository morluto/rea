import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import type { Evidence } from "./evidence.js";
import {
  compareCodePoints,
  type ApplicationEdge,
  type ApplicationNode,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import type {
  ApplicationVersionComparisonItem,
  CompareApplicationVersionsInput,
} from "./javascriptApplicationVersionComparisonSchemas.js";
import type {
  ApplicationVersionMatchingProjection,
  ApplicationVersionNodePair,
} from "./javascriptApplicationVersionKeys.js";

/** All classified entities before the caller's item bound is applied. */
export interface ApplicationVersionItemProjection {
  readonly items: ApplicationVersionComparisonItem[];
  readonly omittedCandidateReferences: number;
}

interface ItemContext {
  readonly leftGraph: JavaScriptApplicationGraph;
  readonly rightGraph: JavaScriptApplicationGraph;
  readonly leftEvidenceId: string;
  readonly rightEvidenceId: string;
  readonly leftNativeEvidence: readonly Evidence[];
  readonly rightNativeEvidence: readonly Evidence[];
  readonly pairByLeft: ReadonlyMap<string, string>;
  readonly pairByRight: ReadonlyMap<string, string>;
  readonly maxCandidates: number;
}

/** Classify matched, unmatched, and ambiguous nodes without inventing absence. */
export const classifyJavaScriptApplicationVersions = (
  matching: ApplicationVersionMatchingProjection,
  context: Omit<ItemContext, "pairByLeft" | "pairByRight" | "maxCandidates"> & {
    readonly maxCandidates: CompareApplicationVersionsInput["limits"]["max_candidate_nodes"];
  },
): ApplicationVersionItemProjection => {
  const pairByLeft = new Map(
    matching.pairs.map(({ left, right }) => [
      left.node_id,
      `pair:${left.node_id}:${right.node_id}`,
    ]),
  );
  const pairByRight = new Map(
    matching.pairs.map(({ left, right }) => [
      right.node_id,
      `pair:${left.node_id}:${right.node_id}`,
    ]),
  );
  const fullContext: ItemContext = { ...context, pairByLeft, pairByRight };
  let omittedCandidateReferences = 0;
  const leftItems = matching.unmatchedLeft.map((node) => {
    const candidates = matching.candidatesForLeft.get(node.node_id) ?? [];
    omittedCandidateReferences += Math.max(
      0,
      candidates.length - context.maxCandidates,
    );
    return unmatchedItem(
      node,
      "left",
      candidates.slice(0, context.maxCandidates),
      fullContext,
    );
  });
  const rightItems = matching.unmatchedRight.map((node) => {
    const candidates = matching.candidatesForRight.get(node.node_id) ?? [];
    omittedCandidateReferences += Math.max(
      0,
      candidates.length - context.maxCandidates,
    );
    return unmatchedItem(
      node,
      "right",
      candidates.slice(0, context.maxCandidates),
      fullContext,
    );
  });
  return {
    items: [
      ...matching.pairs.map((pair) => matchedItem(pair, fullContext)),
      ...leftItems,
      ...rightItems,
    ].sort((left, right) => compareCodePoints(left.item_id, right.item_id)),
    omittedCandidateReferences,
  };
};

const matchedItem = (
  pair: ApplicationVersionNodePair,
  context: ItemContext,
): ApplicationVersionComparisonItem => {
  const dimensions = changedDimensions(pair, context);
  const complete = graphsComplete(context);
  const observedChange = dimensions.some((dimension) =>
    ["content", "location", "properties"].includes(dimension),
  );
  const status: ApplicationVersionComparisonItem["status"] =
    observedChange || (complete && dimensions.length > 0)
      ? "changed"
      : complete
        ? "unchanged"
        : "unknown";
  const finalDimensions =
    status === "unknown" && !dimensions.includes("coverage")
      ? [...dimensions, "coverage" as const]
      : dimensions;
  const semantic = {
    status,
    node_kind: pair.left.kind,
    left_node_id: pair.left.node_id,
    right_node_id: pair.right.node_id,
    match: {
      status: "matched" as const,
      basis: pair.basis,
      confidence: pair.confidence,
      candidate_left_node_ids: [],
      candidate_right_node_ids: [],
    },
    dimensions: finalDimensions,
    evidence_links: itemEvidenceLinks(pair.left, pair.right, context),
    limitations: pairLimitations(pair, status),
  };
  return itemWithId(semantic);
};

const unmatchedItem = (
  node: ApplicationNode,
  side: "left" | "right",
  candidates: readonly string[],
  context: ItemContext,
): ApplicationVersionComparisonItem => {
  const ambiguous = candidates.length > 0;
  const oppositeComplete =
    (side === "left" ? context.rightGraph : context.leftGraph).coverage
      .status === "complete";
  const status: ApplicationVersionComparisonItem["status"] = ambiguous
    ? "unknown"
    : oppositeComplete
      ? side === "left"
        ? "removed"
        : "added"
      : "unknown";
  const semantic = {
    status,
    node_kind: node.kind,
    left_node_id: side === "left" ? node.node_id : null,
    right_node_id: side === "right" ? node.node_id : null,
    match: {
      status: ambiguous ? ("ambiguous" as const) : ("unmatched" as const),
      basis: "none" as const,
      confidence: "unknown" as const,
      candidate_left_node_ids: side === "right" ? [...candidates] : [],
      candidate_right_node_ids: side === "left" ? [...candidates] : [],
    },
    dimensions: [
      "availability" as const,
      ...(status === "unknown" && !ambiguous ? (["coverage"] as const) : []),
    ],
    evidence_links: itemEvidenceLinks(
      side === "left" ? node : undefined,
      side === "right" ? node : undefined,
      context,
    ),
    limitations: [
      ...(ambiguous
        ? [
            "Multiple nodes share the same permitted match key; no cross-version pair was selected.",
          ]
        : []),
      ...(status === "unknown" && !ambiguous
        ? [
            "The opposite graph is incomplete, so an unmatched node cannot be classified as added or removed.",
          ]
        : []),
    ],
  };
  return itemWithId(semantic);
};

const changedDimensions = (
  pair: ApplicationVersionNodePair,
  context: ItemContext,
): ApplicationVersionComparisonItem["dimensions"] => {
  const dimensions: ApplicationVersionComparisonItem["dimensions"] = [];
  const leftContent = contentIdentity(pair.left);
  const rightContent = contentIdentity(pair.right);
  if (
    leftContent !== null &&
    rightContent !== null &&
    leftContent !== rightContent
  )
    dimensions.push("content");
  if (canonical(locations(pair.left)) !== canonical(locations(pair.right)))
    dimensions.push("location");
  if (canonical(properties(pair.left)) !== canonical(properties(pair.right)))
    dimensions.push("properties");
  if (
    relationshipSignature(pair.left, "left", context) !==
    relationshipSignature(pair.right, "right", context)
  )
    dimensions.push("relationships");
  return dimensions;
};

const contentIdentity = (node: ApplicationNode): string | null => {
  if (node.identity.strategy === "content-digest")
    return `content:${node.identity.sha256}`;
  if (node.kind === "javascript-module")
    return stringProperty(node, "source_sha256");
  if (
    node.kind === "source-module" &&
    node.identity.strategy === "source-map-original"
  )
    return node.identity.source_sha256;
  return null;
};

const locations = (node: ApplicationNode) =>
  node.observations
    .map(({ evidence }) =>
      evidence.location.available ? evidence.location.value : evidence.location,
    )
    .sort((left, right) =>
      compareCodePoints(canonical(left), canonical(right)),
    );

const properties = (node: ApplicationNode) =>
  node.observations
    .map(({ label, properties: values }) => ({ label, properties: values }))
    .sort((left, right) =>
      compareCodePoints(canonical(left), canonical(right)),
    );

const relationshipSignature = (
  node: ApplicationNode,
  side: "left" | "right",
  context: ItemContext,
): string => {
  const graph = side === "left" ? context.leftGraph : context.rightGraph;
  const paired = side === "left" ? context.pairByLeft : context.pairByRight;
  const nodeById = new Map(graph.nodes.map((value) => [value.node_id, value]));
  const signatures = graph.edges.flatMap((edge) => {
    if (edge.source_node_id === node.node_id)
      return [
        edgeSignature(
          "out",
          edge.relation,
          edge.target_node_id,
          paired,
          nodeById,
        ),
      ];
    if (edge.target_node_id === node.node_id)
      return [
        edgeSignature(
          "in",
          edge.relation,
          edge.source_node_id,
          paired,
          nodeById,
        ),
      ];
    return [];
  });
  return canonical(signatures.sort(compareCodePoints));
};

const edgeSignature = (
  direction: "in" | "out",
  relation: ApplicationEdge["relation"],
  neighborId: string,
  paired: ReadonlyMap<string, string>,
  nodeById: ReadonlyMap<string, ApplicationNode>,
): string => {
  const mapped = paired.get(neighborId);
  const neighbor = nodeById.get(neighborId);
  return `${direction}\0${relation}\0${mapped ?? `unmatched:${neighbor?.kind ?? "unknown"}`}`;
};

const itemEvidenceLinks = (
  left: ApplicationNode | undefined,
  right: ApplicationNode | undefined,
  context: ItemContext,
): string[] =>
  [
    ...new Set([
      context.leftEvidenceId,
      context.rightEvidenceId,
      ...nativeLinks(left, context.leftNativeEvidence),
      ...nativeLinks(right, context.rightNativeEvidence),
    ]),
  ].sort(compareCodePoints);

const nativeLinks = (
  node: ApplicationNode | undefined,
  evidence: readonly Evidence[],
): string[] => {
  const digest =
    node === undefined
      ? null
      : contentIdentity(node)?.replace(/^content:/u, "");
  return digest === null
    ? []
    : evidence
        .filter(({ subject }) => subject?.digest.sha256 === digest)
        .map(({ evidence_id: id }) => id);
};

const pairLimitations = (
  pair: ApplicationVersionNodePair,
  status: ApplicationVersionComparisonItem["status"],
): string[] => [
  ...(pair.basis === "structural-fingerprint"
    ? [
        "Structural fingerprint equality is rename-resistant inference; it is not byte identity or proof of semantic equivalence.",
      ]
    : []),
  ...(pair.basis === "source-map-identity"
    ? [
        "Source-map original names identify a candidate source lineage; changed or unavailable source content remains explicit.",
      ]
    : []),
  ...(pair.basis === "semantic-key"
    ? [
        "Semantic-key pairing is a deterministic inference and is never promoted to exact identity.",
      ]
    : []),
  ...(status === "unknown"
    ? ["Incomplete graph coverage prevents a complete node-level conclusion."]
    : []),
];

const itemWithId = (
  semantic: Omit<ApplicationVersionComparisonItem, "item_id">,
): ApplicationVersionComparisonItem => ({
  ...semantic,
  item_id: `javc_item_${digestCanonical(semantic)}`,
});

const stringProperty = (node: ApplicationNode, key: string): string | null => {
  const values = [
    ...new Set(
      node.observations
        .map(({ properties: values }) => values[key])
        .filter((value): value is string => typeof value === "string"),
    ),
  ];
  return values.length === 1 ? (values[0] ?? null) : null;
};

const graphsComplete = (context: ItemContext): boolean =>
  context.leftGraph.coverage.status === "complete" &&
  context.rightGraph.coverage.status === "complete";

const canonical = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Application version item could not canonicalize data");
  return encoded;
};

const digestCanonical = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
