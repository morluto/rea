import { isJavaScriptModuleUnit } from "./javascriptModuleUnits.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type { JavaScriptApplicationGraph } from "./javascriptApplicationGraph.js";
import type { ApplicationNode } from "./javascriptApplicationGraphSchemas.js";
import { getFeatureGraphIndex } from "./javascriptFeatureGraphIndex.js";
import {
  featureSeedMatchMode,
  type ApplicationFeatureSeed,
} from "./javascriptFeatureTraceSchemas.js";
import type { JsonValue } from "../jsonValue.js";

/** One explicit field that matched a feature seed. */
export interface ApplicationFeatureSeedMatch {
  readonly node_id: string;
  readonly kind: ApplicationNode["kind"];
  readonly basis: "node-id" | "label" | "identity" | "property";
  readonly field: string;
}

interface SuffixPattern {
  readonly name: string;
  readonly dotName: string;
}

type TypedSeedKind = "api" | "channel" | "module" | "native-export";

const suffixPatterns = (names: readonly string[]): readonly SuffixPattern[] =>
  names.map((name) => ({ name, dotName: `.${name}` }));

const SCALAR_PATTERNS: Readonly<
  Record<TypedSeedKind, readonly SuffixPattern[]>
> = {
  api: suffixPatterns([
    "label",
    "api_name",
    "api_key",
    "key",
    "methods",
    "members",
  ]),
  channel: suffixPatterns(["label", "channel", "key"]),
  module: suffixPatterns([
    "label",
    "module_key",
    "path",
    "source",
    "original_source",
    "source_root",
    "exports",
  ]),
  "native-export": suffixPatterns([
    "label",
    "key",
    "requested_members",
    "members",
  ]),
};

const MEMBER_PATTERNS: Readonly<
  Record<TypedSeedKind, readonly SuffixPattern[]>
> = {
  api: suffixPatterns(["methods", "members"]),
  channel: [],
  module: suffixPatterns(["exports"]),
  "native-export": suffixPatterns(["requested_members", "members"]),
};

const keyMatchesAny = (
  key: string,
  patterns: readonly SuffixPattern[],
): boolean => {
  for (const { name, dotName } of patterns)
    if (key === name || key.endsWith(dotName)) return true;
  return false;
};

/** Locate every graph node matching a typed literal seed without regex execution. */
export const findApplicationFeatureSeeds = (
  nodes: readonly ApplicationNode[],
  seed: ApplicationFeatureSeed,
): ApplicationFeatureSeedMatch[] => collectSeedMatches([nodes], seed);

/** Locate matching seeds using immutable graph indexes when available. */
export const findApplicationFeatureSeedsInGraph = (
  graph: JavaScriptApplicationGraph,
  seed: ApplicationFeatureSeed,
): ApplicationFeatureSeedMatch[] => {
  const index = getFeatureGraphIndex(graph);
  if (index === undefined)
    return findApplicationFeatureSeeds(graph.nodes, seed);
  const mode = featureSeedMatchMode(seed);
  if (seed.kind === "node-id" && mode === "exact") {
    const query = normalizeFeatureSeedText(seed.value, seed.case_sensitive);
    const node = index.nodesById.get(query);
    return node === undefined
      ? []
      : [
          {
            node_id: node.node_id,
            kind: node.kind,
            basis: "node-id",
            field: "node_id",
          },
        ];
  }
  return collectSeedMatches(
    candidateNodeBuckets(graph, index, seed.kind),
    seed,
  );
};

const candidateNodeBuckets = (
  graph: JavaScriptApplicationGraph,
  index: NonNullable<ReturnType<typeof getFeatureGraphIndex>>,
  kind: ApplicationFeatureSeed["kind"],
): readonly (readonly ApplicationNode[])[] => {
  if (kind === "string" || kind === "node-id") return [graph.nodes];
  if (kind === "route") return [index.nodesByKind.get("endpoint") ?? []];
  if (kind === "api")
    return [
      index.nodesByKind.get("context-bridge-api") ?? [],
      index.nodesByKind.get("javascript-expression") ?? [],
    ];
  if (kind === "channel") return [index.nodesByKind.get("ipc-channel") ?? []];
  if (kind === "module")
    return [
      index.nodesByKind.get("javascript-asset") ?? [],
      index.nodesByKind.get("javascript-module") ?? [],
      index.nodesByKind.get("source-module") ?? [],
    ];
  return [index.nodesByKind.get("native-export") ?? []];
};

const collectSeedMatches = (
  buckets: readonly (readonly ApplicationNode[])[],
  seed: ApplicationFeatureSeed,
): ApplicationFeatureSeedMatch[] => {
  const mode = featureSeedMatchMode(seed);
  const caseSensitive = seed.case_sensitive;
  const query = normalizeFeatureSeedText(seed.value, caseSensitive);
  const requestedEntryPath =
    seed.kind === "api" && "entry_path" in seed ? seed.entry_path : undefined;
  const matches: ApplicationFeatureSeedMatch[] = [];
  for (const nodes of buckets) {
    for (const node of nodes) {
      if (!kindMatches(node, seed.kind)) continue;
      if (
        seed.kind === "api" &&
        requestedEntryPath !== undefined &&
        !hasMatchingEntryPath(node, requestedEntryPath)
      )
        continue;
      const match = firstMatchingCandidate(
        node,
        seed.kind,
        query,
        mode,
        caseSensitive,
      );
      if (match !== undefined)
        matches.push({
          node_id: node.node_id,
          kind: node.kind,
          basis: match.basis,
          field: match.field,
        });
    }
  }
  if (matches.length > 1)
    matches.sort((left, right) =>
      compareUnicodeCodePoints(
        `${left.node_id}\0${left.basis}\0${left.field}`,
        `${right.node_id}\0${right.basis}\0${right.field}`,
      ),
    );
  return matches;
};

const hasMatchingEntryPath = (
  node: ApplicationNode,
  requestedEntryPath: readonly string[],
): boolean =>
  node.observations.some(({ properties }) => {
    const entryPath = properties.entry_path;
    return (
      Array.isArray(entryPath) &&
      entryPath.length === requestedEntryPath.length &&
      entryPath.every((segment, index) => segment === requestedEntryPath[index])
    );
  });

const kindMatches = (
  node: ApplicationNode,
  kind: ApplicationFeatureSeed["kind"],
): boolean => {
  if (kind === "string" || kind === "node-id") return true;
  if (kind === "route")
    return (
      node.kind === "endpoint" &&
      node.observations.some(
        ({ properties }) => properties.endpoint_kind === "route",
      )
    );
  if (kind === "api")
    return (
      node.kind === "context-bridge-api" ||
      (node.kind === "javascript-expression" &&
        node.observations.some((o) => o.properties.step_kind === "exposure"))
    );
  if (kind === "channel") return node.kind === "ipc-channel";
  if (kind === "module") return isJavaScriptModuleUnit(node);
  return node.kind === "native-export";
};

const textMatches = (
  candidate: string,
  query: string,
  mode: "exact" | "contains",
  caseSensitive: boolean,
): boolean => {
  const normalized = normalizeFeatureSeedText(candidate, caseSensitive);
  return mode === "exact" ? normalized === query : normalized.includes(query);
};

interface MatchedField {
  readonly basis: ApplicationFeatureSeedMatch["basis"];
  readonly field: string;
}

const firstMatchingCandidate = (
  node: ApplicationNode,
  seedKind: ApplicationFeatureSeed["kind"],
  query: string,
  mode: "exact" | "contains",
  caseSensitive: boolean,
): MatchedField | undefined => {
  if (seedKind === "node-id")
    return textMatches(node.node_id, query, mode, caseSensitive)
      ? { basis: "node-id", field: "node_id" }
      : undefined;
  if (seedKind === "route")
    return firstMatchingRouteField(node, query, mode, caseSensitive);
  const identityMatch = firstMatchingIdentityField(
    node,
    seedKind,
    query,
    mode,
    caseSensitive,
  );
  if (identityMatch !== undefined) return identityMatch;
  for (let index = 0; index < node.observations.length; index += 1) {
    const observation = node.observations[index]!;
    if (
      observation.label !== null &&
      textMatches(observation.label, query, mode, caseSensitive)
    )
      return { basis: "label", field: `observations[${String(index)}].label` };
    if (
      (seedKind === "string" || seedKind === "module") &&
      observation.source_map_reference !== null &&
      observation.source_map_reference.resolution.kind !== "unresolved" &&
      textMatches(
        observation.source_map_reference.resolution.path,
        query,
        mode,
        caseSensitive,
      )
    )
      return {
        basis: "property",
        field: `observations[${String(index)}].source_map_reference.resolution.path`,
      };
    const propertyMatch = firstMatchingPropertyField(
      observation.properties,
      `observations[${String(index)}].properties`,
      seedKind,
      query,
      mode,
      caseSensitive,
    );
    if (propertyMatch !== undefined)
      return { basis: "property", field: propertyMatch };
  }
  return undefined;
};

const firstMatchingRouteField = (
  node: ApplicationNode,
  query: string,
  mode: "exact" | "contains",
  caseSensitive: boolean,
): MatchedField | undefined => {
  for (let index = 0; index < node.observations.length; index += 1) {
    const { properties } = node.observations[index]!;
    for (const key of ["value", "path"] as const) {
      const value = properties[key];
      if (
        typeof value === "string" &&
        textMatches(value, query, mode, caseSensitive)
      )
        return {
          basis: "property",
          field: `observations[${String(index)}].properties.${key}`,
        };
    }
  }
  return undefined;
};

const firstMatchingIdentityField = (
  node: ApplicationNode,
  seedKind: "string" | TypedSeedKind,
  query: string,
  mode: "exact" | "contains",
  caseSensitive: boolean,
): MatchedField | undefined => {
  const { identity } = node;
  if (identity.strategy === "content-digest")
    return textMatches(identity.sha256, query, mode, caseSensitive)
      ? { basis: "identity", field: "identity" }
      : undefined;
  if (identity.strategy === "source-map-original") {
    if (seedKind !== "string" && seedKind !== "module") return undefined;
    if (textMatches(identity.original_source, query, mode, caseSensitive))
      return { basis: "identity", field: "identity.original_source" };
    if (
      identity.source_root !== null &&
      textMatches(identity.source_root, query, mode, caseSensitive)
    )
      return { basis: "identity", field: "identity.source_root" };
    return undefined;
  }
  if (identity.strategy === "canonical-path")
    return (seedKind === "string" || seedKind === "module") &&
      textMatches(identity.path, query, mode, caseSensitive)
      ? { basis: "identity", field: "identity.path" }
      : undefined;
  if (identity.strategy === "artifact-local-key")
    return seedKind !== "module" &&
      textMatches(identity.key, query, mode, caseSensitive)
      ? { basis: "identity", field: "identity.key" }
      : undefined;
  if (identity.strategy === "runtime-instance")
    return seedKind === "string" &&
      textMatches(identity.runtime_key, query, mode, caseSensitive)
      ? { basis: "identity", field: "identity.runtime_key" }
      : undefined;
  return undefined;
};

interface PropertyFrame {
  readonly current: JsonValue;
  readonly path: string;
  readonly inMemberArray: boolean;
}

const firstMatchingPropertyField = (
  value: Readonly<Record<string, JsonValue>>,
  prefix: string,
  seedKind: "string" | TypedSeedKind,
  query: string,
  mode: "exact" | "contains",
  caseSensitive: boolean,
): string | undefined => {
  const pending: PropertyFrame[] = [
    { current: value, path: prefix, inMemberArray: false },
  ];
  const scalarPatterns =
    seedKind === "string" ? null : SCALAR_PATTERNS[seedKind];
  const memberPatterns =
    seedKind === "string" ? null : MEMBER_PATTERNS[seedKind];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) continue;
    const { current, path, inMemberArray } = next;
    if (typeof current === "string") {
      if (textMatches(current, query, mode, caseSensitive)) return path;
      continue;
    }
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const item = current[index];
        if (item === null || item === undefined) continue;
        if (typeof item === "string") {
          if (seedKind === "string" || inMemberArray)
            pending.push({
              current: item,
              path: `${path}[${String(index)}]`,
              inMemberArray,
            });
          continue;
        }
        if (typeof item === "object")
          pending.push({
            current: item,
            path: `${path}[${String(index)}]`,
            inMemberArray,
          });
      }
      continue;
    }
    if (current !== null && typeof current === "object") {
      const keys = Object.keys(current);
      if (keys.length > 1) keys.sort(compareUnicodeCodePoints);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!;
        const child = current[key];
        if (child === null || child === undefined) continue;
        if (typeof child === "string") {
          if (scalarPatterns === null || keyMatchesAny(key, scalarPatterns))
            pending.push({
              current: child,
              path: `${path}.${key}`,
              inMemberArray: false,
            });
          continue;
        }
        if (Array.isArray(child)) {
          if (child.length === 0) continue;
          pending.push({
            current: child,
            path: `${path}.${key}`,
            inMemberArray:
              memberPatterns !== null && keyMatchesAny(key, memberPatterns),
          });
          continue;
        }
        if (typeof child === "object")
          pending.push({
            current: child,
            path: `${path}.${key}`,
            inMemberArray: false,
          });
      }
    }
  }
  return undefined;
};

/** Normalize literal matching identically across application and semantic labels. */
export const normalizeFeatureSeedText = (
  value: string,
  caseSensitive: boolean,
): string => {
  let hasUpper = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) {
      const normalizedValue = value.normalize(caseSensitive ? "NFC" : "NFKC");
      return caseSensitive
        ? normalizedValue
        : normalizedValue.toLocaleLowerCase("en-US");
    }
    if (code >= 65 && code <= 90) hasUpper = true;
  }
  return caseSensitive || !hasUpper ? value : value.toLowerCase();
};
