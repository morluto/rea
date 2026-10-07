import { compareCodePoints } from "../canonicalOrdering.js";
import type { ApplicationNode } from "./javascriptApplicationGraph.js";
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

interface CandidateField {
  readonly basis: ApplicationFeatureSeedMatch["basis"];
  readonly field: string;
  /** Structural field path, retaining literal keys but omitting array indexes. */
  readonly selectionPath?: string;
  readonly value: string;
}

/** Locate every graph node matching a typed literal seed without regex execution. */
export const findApplicationFeatureSeeds = (
  nodes: readonly ApplicationNode[],
  seed: ApplicationFeatureSeed,
): ApplicationFeatureSeedMatch[] =>
  nodes
    .flatMap((node) => seedMatch(node, seed))
    .sort((left, right) =>
      compareCodePoints(
        `${left.node_id}\0${left.basis}\0${left.field}`,
        `${right.node_id}\0${right.basis}\0${right.field}`,
      ),
    );

const seedMatch = (
  node: ApplicationNode,
  seed: ApplicationFeatureSeed,
): ApplicationFeatureSeedMatch[] => {
  if (seed.kind === "node-id")
    return node.node_id === seed.value
      ? [
          {
            node_id: node.node_id,
            kind: node.kind,
            basis: "node-id",
            field: "node_id",
          },
        ]
      : [];
  if (!kindMatches(node, seed.kind)) return [];
  const mode = featureSeedMatchMode(seed);
  const query = normalized(seed.value, seed.case_sensitive);
  const match = candidateFields(node, seed.kind).find((candidate) => {
    const value = normalized(candidate.value, seed.case_sensitive);
    return mode === "exact" ? value === query : value.includes(query);
  });
  return match === undefined
    ? []
    : [
        {
          node_id: node.node_id,
          kind: node.kind,
          basis: match.basis,
          field: match.field,
        },
      ];
};

const kindMatches = (
  node: ApplicationNode,
  kind: Exclude<ApplicationFeatureSeed["kind"], "node-id">,
): boolean => {
  if (kind === "string") return true;
  if (kind === "route")
    return (
      node.kind === "endpoint" &&
      node.observations.some(
        ({ properties }) => properties.endpoint_kind === "route",
      )
    );
  if (kind === "api") return node.kind === "context-bridge-api";
  if (kind === "channel") return node.kind === "ipc-channel";
  if (kind === "module")
    return ["javascript-asset", "javascript-module", "source-module"].includes(
      node.kind,
    );
  return node.kind === "native-export";
};

const candidateFields = (
  node: ApplicationNode,
  seedKind: Exclude<ApplicationFeatureSeed["kind"], "node-id">,
): CandidateField[] => {
  const fields: CandidateField[] = [
    ...identityFields(node),
    ...node.observations.flatMap((observation, index) => [
      ...(observation.label === null
        ? []
        : [
            {
              basis: "label" as const,
              field: `observations[${String(index)}].label`,
              value: observation.label,
            },
          ]),
      ...propertyFields(
        observation.properties,
        `observations[${String(index)}].properties`,
      ),
    ]),
  ];
  if (seedKind === "string") return fields;
  const names = relevantFields[seedKind];
  return fields.filter(({ field, selectionPath = field }) =>
    names.some((name) => {
      const path = memberFieldSuffixes.has(name) ? selectionPath : field;
      return path === "identity" || path.endsWith(name);
    }),
  );
};

const memberFieldSuffixes = new Set([
  ".members",
  ".methods",
  ".exports",
  ".requested_members",
]);

const relevantFields = {
  route: [".label", ".value", ".path"],
  api: [".label", ".api_name", ".api_key", ".key", ".methods", ".members"],
  channel: [".label", ".channel", ".key"],
  module: [
    ".label",
    ".module_key",
    ".path",
    ".source",
    ".original_source",
    ".exports",
  ],
  "native-export": [".label", ".key", ".requested_members", ".members"],
} as const;

const identityFields = (node: ApplicationNode): CandidateField[] => {
  const identity = node.identity;
  if (identity.strategy === "content-digest")
    return [{ basis: "identity", field: "identity", value: identity.sha256 }];
  if (identity.strategy === "source-map-original")
    return [
      {
        basis: "identity",
        field: "identity.original_source",
        value: identity.original_source,
      },
    ];
  if (identity.strategy === "canonical-path")
    return [
      { basis: "identity", field: "identity.path", value: identity.path },
    ];
  if (identity.strategy === "artifact-local-key")
    return [{ basis: "identity", field: "identity.key", value: identity.key }];
  if (identity.strategy === "runtime-instance")
    return [
      {
        basis: "identity",
        field: "identity.runtime_key",
        value: identity.runtime_key,
      },
    ];
  return [];
};

const propertyFields = (
  value: Readonly<Record<string, JsonValue>>,
  prefix: string,
): CandidateField[] => {
  const output: CandidateField[] = [];
  const pending: {
    readonly current: JsonValue;
    readonly path: string;
    readonly selectionPath: string;
  }[] = [{ current: value, path: prefix, selectionPath: prefix }];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) continue;
    const { current, path, selectionPath } = next;
    if (typeof current === "string") {
      output.push({
        basis: "property",
        field: path,
        selectionPath,
        value: current,
      });
      continue;
    }
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const item = current[index];
        if (item !== undefined)
          pending.push({
            current: item,
            path: `${path}[${String(index)}]`,
            selectionPath,
          });
      }
      continue;
    }
    if (current !== null && typeof current === "object") {
      for (const key of Object.keys(current).sort(compareCodePoints).reverse())
        pending.push({
          current: current[key] ?? null,
          path: `${path}.${key}`,
          selectionPath: `${selectionPath}.${key}`,
        });
    }
  }
  return output;
};

const normalized = (value: string, caseSensitive: boolean): string => {
  const normalizedValue = value.normalize("NFKC");
  return caseSensitive
    ? normalizedValue
    : normalizedValue.toLocaleLowerCase("en-US");
};
