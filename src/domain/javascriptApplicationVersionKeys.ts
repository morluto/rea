import type { ApplicationNode } from "./javascriptApplicationGraph.js";
import { compareCodePoints } from "./javascriptApplicationGraph.js";
import type { ApplicationVersionMatchBasis } from "./javascriptApplicationVersionComparisonSchemas.js";
import type { JsonValue } from "./jsonValue.js";

/** One deterministic one-to-one match between two graph versions. */
export interface ApplicationVersionNodePair {
  readonly left: ApplicationNode;
  readonly right: ApplicationNode;
  readonly basis: Exclude<ApplicationVersionMatchBasis, "none">;
  readonly confidence: "exact" | "high" | "medium";
}

/** Matched nodes plus ambiguity candidates that were never forced into pairs. */
export interface ApplicationVersionMatchingProjection {
  readonly pairs: ApplicationVersionNodePair[];
  readonly unmatchedLeft: ApplicationNode[];
  readonly unmatchedRight: ApplicationNode[];
  readonly candidatesForLeft: ReadonlyMap<string, readonly string[]>;
  readonly candidatesForRight: ReadonlyMap<string, readonly string[]>;
}

interface MatchTier {
  readonly basis: ApplicationVersionNodePair["basis"];
  readonly confidence: ApplicationVersionNodePair["confidence"];
  readonly key: (node: ApplicationNode) => string | null;
}

const matchTiers = (): readonly MatchTier[] => [
  { basis: "exact-content-digest", confidence: "exact", key: contentDigestKey },
  {
    basis: "exact-module-source-digest",
    confidence: "exact",
    key: moduleSourceDigestKey,
  },
  { basis: "exact-node-identity", confidence: "exact", key: nodeIdentityKey },
  { basis: "source-map-identity", confidence: "high", key: sourceMapKey },
  {
    basis: "structural-fingerprint",
    confidence: "medium",
    key: structuralFingerprintKey,
  },
  { basis: "semantic-key", confidence: "medium", key: semanticKey },
];

/** Apply ordered, unique-only matching tiers without fuzzy pairing. */
export const matchJavaScriptApplicationVersions = (
  leftNodes: readonly ApplicationNode[],
  rightNodes: readonly ApplicationNode[],
): ApplicationVersionMatchingProjection => {
  const left = new Map(leftNodes.map((node) => [node.node_id, node]));
  const right = new Map(rightNodes.map((node) => [node.node_id, node]));
  const leftCandidates = new Map<string, Set<string>>();
  const rightCandidates = new Map<string, Set<string>>();
  const pairs: ApplicationVersionNodePair[] = [];
  for (const tier of matchTiers())
    applyTier({ left, right, pairs, leftCandidates, rightCandidates, tier });
  const remainingLeft = sortedNodes(left.values());
  const remainingRight = sortedNodes(right.values());
  const leftIds = new Set(remainingLeft.map(({ node_id: id }) => id));
  const rightIds = new Set(remainingRight.map(({ node_id: id }) => id));
  return {
    pairs: pairs.sort((a, b) =>
      compareCodePoints(
        `${a.left.node_id}\0${a.right.node_id}`,
        `${b.left.node_id}\0${b.right.node_id}`,
      ),
    ),
    unmatchedLeft: remainingLeft,
    unmatchedRight: remainingRight,
    candidatesForLeft: filteredCandidates(leftCandidates, rightIds),
    candidatesForRight: filteredCandidates(rightCandidates, leftIds),
  };
};

interface TierContext {
  readonly left: Map<string, ApplicationNode>;
  readonly right: Map<string, ApplicationNode>;
  readonly pairs: ApplicationVersionNodePair[];
  readonly leftCandidates: Map<string, Set<string>>;
  readonly rightCandidates: Map<string, Set<string>>;
  readonly tier: MatchTier;
}

const applyTier = (context: TierContext): void => {
  const leftByKey = nodesByKey(context.left.values(), context.tier.key);
  const rightByKey = nodesByKey(context.right.values(), context.tier.key);
  for (const key of [...leftByKey.keys()].sort(compareCodePoints)) {
    const leftGroup = leftByKey.get(key) ?? [];
    const rightGroup = rightByKey.get(key) ?? [];
    if (rightGroup.length === 0) continue;
    recordCandidates(leftGroup, rightGroup, context.leftCandidates, context.rightCandidates);
    if (leftGroup.length !== 1 || rightGroup.length !== 1) continue;
    const leftNode = leftGroup[0];
    const rightNode = rightGroup[0];
    if (leftNode === undefined || rightNode === undefined) continue;
    context.pairs.push({ left: leftNode, right: rightNode, ...context.tier });
    context.left.delete(leftNode.node_id);
    context.right.delete(rightNode.node_id);
  }
};

const nodesByKey = (
  nodes: Iterable<ApplicationNode>,
  keyFor: (node: ApplicationNode) => string | null,
): Map<string, ApplicationNode[]> => {
  const output = new Map<string, ApplicationNode[]>();
  for (const node of nodes) {
    const key = keyFor(node);
    if (key === null) continue;
    output.set(key, [...(output.get(key) ?? []), node]);
  }
  return output;
};

const recordCandidates = (
  left: readonly ApplicationNode[],
  right: readonly ApplicationNode[],
  leftCandidates: Map<string, Set<string>>,
  rightCandidates: Map<string, Set<string>>,
): void => {
  for (const leftNode of left) {
    const candidates =
      leftCandidates.get(leftNode.node_id) ?? new Set<string>();
    for (const rightNode of right) candidates.add(rightNode.node_id);
    leftCandidates.set(leftNode.node_id, candidates);
  }
  for (const rightNode of right) {
    const candidates =
      rightCandidates.get(rightNode.node_id) ?? new Set<string>();
    for (const leftNode of left) candidates.add(leftNode.node_id);
    rightCandidates.set(rightNode.node_id, candidates);
  }
};

const filteredCandidates = (
  candidates: ReadonlyMap<string, ReadonlySet<string>>,
  retained: ReadonlySet<string>,
): ReadonlyMap<string, readonly string[]> =>
  new Map(
    [...candidates.entries()].flatMap(([nodeId, values]) => {
      const filtered = [...values]
        .filter((value) => retained.has(value))
        .sort(compareCodePoints);
      return filtered.length === 0 ? [] : [[nodeId, filtered] as const];
    }),
  );

const nodeIdentityKey = (node: ApplicationNode): string =>
  `node\0${node.kind}\0${node.node_id}`;

const contentDigestKey = (node: ApplicationNode): string | null =>
  node.identity.strategy === "content-digest"
    ? `content\0${node.kind}\0${node.identity.sha256}`
    : null;

const moduleSourceDigestKey = (node: ApplicationNode): string | null => {
  if (node.kind !== "javascript-module") return null;
  const value = uniqueStringProperty(node, "source_sha256");
  return value === null ? null : `module-source\0${node.kind}\0${value}`;
};

const sourceMapKey = (node: ApplicationNode): string | null =>
  node.kind === "source-module" &&
  node.identity.strategy === "source-map-original"
    ? `source-map\0${node.identity.original_source}`
    : null;

const structuralFingerprintKey = (node: ApplicationNode): string | null => {
  if (node.kind !== "javascript-module") return null;
  const digest = uniqueStringProperty(node, "structural_fingerprint_sha256");
  const algorithm = uniqueStringProperty(
    node,
    "structural_fingerprint_algorithm",
  );
  const status = uniqueStringProperty(node, "structural_fingerprint_status");
  return digest === null || algorithm === null || status !== "complete"
    ? null
    : `structural\0${node.kind}\0${algorithm}\0${digest}`;
};

const semanticKey = (node: ApplicationNode): string | null => {
  if (
    [
      "javascript-module",
      "javascript-chunk",
      "runtime-script-instance",
      "unknown",
    ].includes(node.kind)
  )
    return null;
  const properties = firstProperties(node);
  const value = semanticValue(node, properties);
  return value === null ? null : `semantic\0${node.kind}\0${value}`;
};

const semanticValue = (
  node: ApplicationNode,
  properties: Readonly<Record<string, JsonValue>>,
): string | null => {
  if (node.kind === "endpoint")
    return joined(properties.endpoint_kind, properties.value);
  if (node.kind === "storage")
    return joined(
      properties.storage_kind,
      properties.name ?? properties.mechanism,
    );
  if (node.kind === "ipc-channel")
    return properties.resolution === "dynamic"
      ? null
      : (stringValue(properties.channel) ?? firstLabel(node));
  if (node.kind === "context-bridge-api")
    return firstLabel(node) ?? stringValue(properties.api_name);
  if (node.kind === "native-export")
    return (
      joined(
        properties.specifier,
        stringList(properties.requested_members).join(","),
      ) ?? firstLabel(node)
    );
  if (
    [
      "electron-main",
      "electron-preload",
      "electron-renderer",
      "electron-utility",
    ].includes(node.kind)
  )
    return joined(properties.declared_path, properties.resolved_path);
  if (node.kind === "package") return stringValue(properties.name);
  return canonicalPath(node) ?? stringValue(properties.path);
};

const canonicalPath = (node: ApplicationNode): string | null =>
  node.identity.strategy === "canonical-path" ? node.identity.path : null;

const firstProperties = (node: ApplicationNode) =>
  node.observations[0]?.properties ?? {};

const firstLabel = (node: ApplicationNode): string | null =>
  node.observations.find(({ label }) => label !== null)?.label ?? null;

const uniqueStringProperty = (
  node: ApplicationNode,
  name: string,
): string | null => {
  const values = [
    ...new Set(
      node.observations
        .map(({ properties }) => properties[name])
        .filter((value): value is string => typeof value === "string"),
    ),
  ];
  return values.length === 1 ? (values[0] ?? null) : null;
};

const joined = (...values: readonly unknown[]): string | null => {
  const strings = values.map(stringValue);
  return strings.some((value) => value === null) ? null : strings.join("\0");
};

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .sort(compareCodePoints)
    : [];

const sortedNodes = (nodes: Iterable<ApplicationNode>): ApplicationNode[] =>
  [...nodes].sort((left, right) =>
    compareCodePoints(left.node_id, right.node_id),
  );
