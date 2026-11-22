import { z } from "zod";
import { isImmutableJsonSnapshot } from "../immutableJson.js";
import {
  applicationNodeSchema,
  applicationNodeObservationSchema,
  type ApplicationNode,
} from "../javascript/javascriptApplicationGraphSchemas.js";

const propertyKeySchema =
  applicationNodeObservationSchema.shape.properties.keyType;

/** A homogeneous batch over exact retained observation locations and node kinds. */
export const javascriptFactsViewRequestSchema = z.strictObject({
  kind: z.literal("javascript-facts"),
  where: z
    .strictObject({
      paths: z
        .array(z.string())
        .optional()
        .describe(
          "Exact Evidence artifact-path or source-range source strings. Omitted includes unknown locations; [] matches none. No filesystem lookup or path normalization.",
        ),
      kinds: z.array(applicationNodeSchema.shape.kind).optional(),
    })
    .default({}),
  property_keys: z
    .array(propertyKeySchema)
    .describe(
      "Exact retained observation-property names to read; [] requests identities/provenance only. Missing properties remain omitted, distinct from retained null. No cross-observation merging or inferred values.",
    ),
  include_available_property_keys: z
    .boolean()
    .default(false)
    .describe(
      "Opt into original property names for each returned observation, without unselected values. Use with property_keys: [] to discover fields before reading them.",
    ),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
});

/** Original identities and provenance, with only caller-selected properties. */
export const javascriptFactRowSchema = applicationNodeSchema
  .pick({ node_id: true, kind: true, identity: true })
  .extend(
    applicationNodeObservationSchema.pick({
      observation_id: true,
      source_map_reference: true,
      properties: true,
      evidence: true,
    }).shape,
  )
  .extend({
    available_property_keys: z.array(propertyKeySchema).exactOptional(),
  });

type FactRequest = z.infer<typeof javascriptFactsViewRequestSchema>;
type FactRow = z.infer<typeof javascriptFactRowSchema>;

const observationPath = (
  observation: ApplicationNode["observations"][number],
): string | null => {
  const { location } = observation.evidence;
  if (!location.available) return null;
  if (location.value.kind === "artifact-path") return location.value.path;
  if (location.value.kind === "source-range") return location.value.source;
  return null;
};

interface FactEntry {
  readonly node: ApplicationNode;
  readonly observation: ApplicationNode["observations"][number];
}

interface FactsIndex {
  readonly all: readonly FactEntry[];
  readonly byKind: ReadonlyMap<string, readonly number[]>;
  readonly byPath: ReadonlyMap<string, readonly number[]>;
  readonly byKindAndPath: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly number[]>
  >;
}

const factsIndexes = new WeakMap<
  object,
  { readonly nodes: readonly ApplicationNode[]; readonly index: FactsIndex }
>();

const pushIndex = (
  map: Map<string, number[]>,
  key: string,
  ordinal: number,
): void => {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [ordinal]);
  else existing.push(ordinal);
};

const buildFactsIndex = (nodes: readonly ApplicationNode[]): FactsIndex => {
  const all: FactEntry[] = [];
  const byKind = new Map<string, number[]>();
  const byPath = new Map<string, number[]>();
  const byKindAndPath = new Map<string, Map<string, number[]>>();
  for (const node of nodes) {
    let kindPaths = byKindAndPath.get(node.kind);
    for (const observation of node.observations) {
      const ordinal = all.length;
      all.push({ node, observation });
      pushIndex(byKind, node.kind, ordinal);
      const path = observationPath(observation);
      if (path !== null) {
        pushIndex(byPath, path, ordinal);
        if (kindPaths === undefined) {
          kindPaths = new Map();
          byKindAndPath.set(node.kind, kindPaths);
        }
        pushIndex(kindPaths, path, ordinal);
      }
    }
  }
  return { all, byKind, byPath, byKindAndPath };
};

const getFactsIndex = (
  nodes: readonly ApplicationNode[],
  cacheOwner: object | undefined,
): FactsIndex | undefined => {
  if (
    cacheOwner === undefined ||
    !isImmutableJsonSnapshot(cacheOwner) ||
    !Object.isFrozen(nodes)
  )
    return undefined;
  const cached = factsIndexes.get(cacheOwner);
  if (cached !== undefined && cached.nodes === nodes) return cached.index;
  const index = buildFactsIndex(nodes);
  factsIndexes.set(cacheOwner, { nodes, index });
  return index;
};

const buildFactRow = (
  node: ApplicationNode,
  observation: ApplicationNode["observations"][number],
  keys: readonly string[],
  includeAvailablePropertyKeys: boolean,
): FactRow => ({
  node_id: node.node_id,
  kind: node.kind,
  identity: node.identity,
  observation_id: observation.observation_id,
  source_map_reference: observation.source_map_reference,
  ...(includeAvailablePropertyKeys
    ? {
        available_property_keys: Object.keys(observation.properties).sort(),
      }
    : {}),
  properties: Object.fromEntries(
    keys.flatMap((key) => {
      const value = observation.properties[key];
      return value !== undefined && Object.hasOwn(observation.properties, key)
        ? [[key, value] as const]
        : [];
    }),
  ),
  evidence: observation.evidence,
});

const collectMatchingBuckets = (
  index: FactsIndex,
  kinds: ReadonlySet<string> | null,
  paths: ReadonlySet<string> | null,
): readonly (readonly number[])[] | undefined => {
  if (kinds === null && paths === null) return undefined;
  const buckets: (readonly number[])[] = [];
  if (kinds !== null && paths !== null) {
    for (const kind of kinds) {
      const byPath = index.byKindAndPath.get(kind);
      if (byPath === undefined) continue;
      for (const path of paths) {
        const bucket = byPath.get(path);
        if (bucket !== undefined) buckets.push(bucket);
      }
    }
    return buckets;
  }
  if (kinds !== null) {
    for (const kind of kinds) {
      const bucket = index.byKind.get(kind);
      if (bucket !== undefined) buckets.push(bucket);
    }
    return buckets;
  }
  for (const path of paths!) {
    const bucket = index.byPath.get(path);
    if (bucket !== undefined) buckets.push(bucket);
  }
  return buckets;
};

const projectIndexedFacts = (
  index: FactsIndex,
  view: FactRequest,
  kinds: ReadonlySet<string> | null,
  paths: ReadonlySet<string> | null,
  keys: readonly string[],
): { readonly rows: FactRow[]; readonly total: number } => {
  const buckets = collectMatchingBuckets(index, kinds, paths);
  if (buckets === undefined) {
    const total = index.all.length;
    const end = Math.min(total, view.offset + view.limit);
    const rows: FactRow[] = [];
    for (let i = view.offset; i < end; i++) {
      const entry = index.all[i]!;
      rows.push(
        buildFactRow(
          entry.node,
          entry.observation,
          keys,
          view.include_available_property_keys,
        ),
      );
    }
    return { rows, total };
  }
  if (buckets.length === 0) return { rows: [], total: 0 };
  if (buckets.length === 1) {
    const bucket = buckets[0]!;
    const total = bucket.length;
    const end = Math.min(total, view.offset + view.limit);
    const rows: FactRow[] = [];
    for (let i = view.offset; i < end; i++) {
      const entry = index.all[bucket[i]!]!;
      rows.push(
        buildFactRow(
          entry.node,
          entry.observation,
          keys,
          view.include_available_property_keys,
        ),
      );
    }
    return { rows, total };
  }
  let total = 0;
  for (const bucket of buckets) total += bucket.length;
  if (view.offset >= total) return { rows: [], total };
  const merged = new Uint32Array(total);
  let writeOffset = 0;
  for (const bucket of buckets) {
    merged.set(bucket, writeOffset);
    writeOffset += bucket.length;
  }
  merged.sort();
  const end = Math.min(total, view.offset + view.limit);
  const rows: FactRow[] = [];
  for (let i = view.offset; i < end; i++) {
    const entry = index.all[merged[i]!]!;
    rows.push(
      buildFactRow(
        entry.node,
        entry.observation,
        keys,
        view.include_available_property_keys,
      ),
    );
  }
  return { rows, total };
};

/** One scan, O(page) retained rows; never materialize a whole node or graph. */
export const projectJavaScriptFacts = (
  nodes: readonly ApplicationNode[],
  view: FactRequest,
  cacheOwner?: object,
): { readonly rows: FactRow[]; readonly total: number } => {
  const paths =
    view.where.paths === undefined ? null : new Set(view.where.paths);
  const kinds =
    view.where.kinds === undefined ? null : new Set(view.where.kinds);
  if (paths?.size === 0 || kinds?.size === 0) return { rows: [], total: 0 };
  const keys = [...new Set(view.property_keys)];
  const index = getFactsIndex(nodes, cacheOwner);
  if (index !== undefined)
    return projectIndexedFacts(index, view, kinds, paths, keys);
  const rows: FactRow[] = [];
  let total = 0;
  for (const node of nodes) {
    if (kinds !== null && !kinds.has(node.kind)) continue;
    for (const observation of node.observations) {
      if (paths !== null) {
        const path = observationPath(observation);
        if (path === null || !paths.has(path)) continue;
      }
      total += 1;
      if (total <= view.offset || rows.length >= view.limit) continue;
      rows.push(
        buildFactRow(
          node,
          observation,
          keys,
          view.include_available_property_keys,
        ),
      );
    }
  }
  return { rows, total };
};
