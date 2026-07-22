import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { compareCodePoints } from "./javascriptApplicationGraph.js";
import type {
  JavaScriptSemanticGraph,
  JavaScriptSemanticGraphNode,
} from "./javascriptSemanticGraph.js";
import type { JavaScriptSemanticQueryInput } from "./javascriptSemanticQuerySchemas.js";

/** Caller cursor that cannot identify a page of the current semantic query. */
export class JavaScriptSemanticQueryCursorError extends TypeError {}

/** Canonical JSON used by semantic query commitments and ordering. */
export const canonicalJavaScriptSemanticQueryJson = (
  value: unknown,
): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError(
      "JavaScript semantic query could not canonicalize data",
    );
  return encoded;
};

const digest = (value: unknown): string =>
  createHash("sha256")
    .update(canonicalJavaScriptSemanticQueryJson(value))
    .digest("hex");

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareCodePoints);

/** Derive the stable identity for one graph-bound query without its cursor. */
export const javaScriptSemanticQueryIdentifier = (
  graph: JavaScriptSemanticGraph,
  input: JavaScriptSemanticQueryInput,
): string => {
  const { cursor: _cursor, ...semantic } = input;
  return `jsrq_${digest({
    source_graph_id: graph.graph_id,
    ...semantic,
    allowed_relations:
      semantic.allowed_relations === undefined
        ? undefined
        : uniqueSorted(semantic.allowed_relations),
    expected:
      semantic.expected === null
        ? null
        : {
            ...semantic.expected,
            classes: uniqueSorted(semantic.expected.classes),
          },
  })}`;
};

/** Commit one deterministic relation-page offset to a query identity. */
export const createJavaScriptSemanticQueryCursor = (
  queryId: string,
  offset: number,
): string => `jsrqc_${String(offset)}_${digest({ query_id: queryId, offset })}`;

/** Parse a query-bound cursor and reject stale, malformed, or foreign values. */
export const parseJavaScriptSemanticQueryCursor = (
  cursor: string | null,
  queryId: string,
): number => {
  if (cursor === null) return 0;
  const match = /^jsrqc_([0-9]+)_([a-f0-9]{64})$/u.exec(cursor);
  const offsetText = match?.[1];
  const commitment = match?.[2];
  if (offsetText === undefined || commitment === undefined)
    throw new JavaScriptSemanticQueryCursorError(
      "Semantic query cursor is malformed",
    );
  const offset = Number(offsetText);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    commitment !== digest({ query_id: queryId, offset })
  )
    throw new JavaScriptSemanticQueryCursorError(
      "Semantic query cursor does not match this query",
    );
  return offset;
};

/** Resolve deterministic seed candidates without applying traversal limits. */
export const resolveJavaScriptSemanticQuerySeeds = (
  graph: JavaScriptSemanticGraph,
  input: JavaScriptSemanticQueryInput,
): string[] => {
  const fingerprintFunctions = new Set(
    input.seed.kind === "function"
      ? graph.fingerprints
          .filter(
            ({ fingerprint_sha256 }) =>
              input.seed.kind === "function" &&
              fingerprint_sha256 === input.seed.fingerprint_sha256,
          )
          .map(({ function_node_id }) => function_node_id)
      : [],
  );
  return graph.nodes
    .filter((node) => seedMatches(node, input, fingerprintFunctions))
    .map(({ node_id }) => node_id)
    .sort(compareCodePoints);
};

const seedMatches = (
  node: JavaScriptSemanticGraphNode,
  input: JavaScriptSemanticQueryInput,
  fingerprintFunctions: ReadonlySet<string>,
): boolean => {
  const seed = input.seed;
  if (seed.kind === "semantic-node") return node.node_id === seed.node_id;
  if (seed.kind === "application-node")
    return node.application_node_ids.includes(seed.node_id);
  if (seed.kind === "function") return fingerprintFunctions.has(node.node_id);
  if (seed.kind === "literal")
    return (
      node.kind === "literal" &&
      canonicalJavaScriptSemanticQueryJson(node.properties.value) ===
        canonicalJavaScriptSemanticQueryJson(seed.value)
    );
  if (seed.kind === "property")
    return node.kind === "property-slot" && node.properties.name === seed.name;
  if (seed.kind === "endpoint")
    return node.kind === "request" && node.properties.endpoint === seed.value;
  if (seed.kind === "event")
    return (
      ["event", "listener"].includes(node.kind) &&
      node.properties.event_name === seed.name
    );
  return node.kind === "boundary" && node.properties.field === seed.field;
};
