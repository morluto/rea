import { selectViewRows } from "./selectViewRows.js";
import { z } from "zod";
import { canonicalJson } from "../comparisonSemantics.js";
import { isImmutableJsonSnapshot } from "../immutableJson.js";
import {
  applicationNodeSchema,
  applicationNodeObservationSchema,
  type ApplicationNode,
} from "../javascript/javascriptApplicationGraphSchemas.js";

const propertyKeySchema =
  applicationNodeObservationSchema.shape.properties.keyType;

const propertyScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/** Exact selection over retained locations, node kinds and property values. */
const javascriptFactsWhereSchema = z
  .strictObject({
    paths: z
      .array(z.string())
      .optional()
      .describe(
        "Exact Evidence artifact-path or source-range source strings. Omitted includes unknown locations; [] matches none. No filesystem lookup or path normalization.",
      ),
    kinds: z.array(applicationNodeSchema.shape.kind).optional(),
    properties: z
      .array(
        z.strictObject({
          key: propertyKeySchema,
          values: z.array(propertyScalarSchema),
        }),
      )
      .optional()
      .describe(
        'Exact retained property values, e.g. [{key: "operation", values: ["send"]}]. An observation matches when every listed key is retained with one of its JSON scalar values; a missing key or non-scalar value never matches, and values [] matches none.',
      ),
  })
  .default({});

/** A homogeneous batch over exact retained observation locations and node kinds. */
export const javascriptFactsViewRequestSchema = z.strictObject({
  kind: z.literal("javascript-facts"),
  where: javascriptFactsWhereSchema,
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

/** Distinct retained property-value combinations, counted without materializing rows. */
export const javascriptFactGroupsViewRequestSchema = z.strictObject({
  kind: z.literal("javascript-fact-groups"),
  where: javascriptFactsWhereSchema,
  group_by: z
    .array(propertyKeySchema)
    .min(1)
    .describe(
      'Exact retained property names whose value combinations form groups, e.g. ["operation", "channel"]. A missing key is omitted from the group, distinct from retained null. Rows are ordered by the canonical JSON of their values. When every grouped value is a present JSON scalar, read its observations with javascript-facts and the same where plus where.properties; array, object and missing values cannot be selected that way.',
    ),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(256),
});

/** One distinct combination; rows are ordered by the canonical JSON of their group_by values. */
export const javascriptFactGroupRowSchema = z.strictObject({
  properties: applicationNodeObservationSchema.shape.properties,
  observation_count: z.int().positive(),
  node_count: z.int().positive(),
});

type FactRequest = z.infer<typeof javascriptFactsViewRequestSchema>;
type FactGroupsRequest = z.infer<typeof javascriptFactGroupsViewRequestSchema>;
type FactRow = z.infer<typeof javascriptFactRowSchema>;
type FactGroupRow = z.infer<typeof javascriptFactGroupRowSchema>;
type FactWhere = FactRequest["where"];

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

const lowerBound = (bucket: readonly number[], target: number): number => {
  let lo = 0;
  let hi = bucket.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bucket[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const seekBucketOffsets = (
  buckets: readonly (readonly number[])[],
  offset: number,
): { readonly cursors: Uint32Array; readonly skipped: number } => {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const bucket of buckets) {
    if (bucket.length === 0) continue;
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    if (first < lo) lo = first;
    if (last > hi) hi = last;
  }
  const cursors = new Uint32Array(buckets.length);
  if (lo > hi) return { cursors, skipped: 0 };
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo + 1) / 2);
    let countLess = 0;
    for (const bucket of buckets) {
      countLess += lowerBound(bucket, mid);
      if (countLess > offset) break;
    }
    if (countLess <= offset) lo = mid;
    else hi = mid - 1;
  }
  let skipped = 0;
  for (let i = 0; i < buckets.length; i++) {
    const cursor = lowerBound(buckets[i]!, lo);
    cursors[i] = cursor;
    skipped += cursor;
  }
  return { cursors, skipped };
};

const selectMultiBucketPage = (
  buckets: readonly (readonly number[])[],
  offset: number,
  limit: number,
  total: number,
): readonly number[] => {
  if (offset >= total || limit <= 0) return [];
  const pageSize = Math.min(limit, total - offset);
  const bucketCount = buckets.length;
  const seekThreshold = Math.max(64, bucketCount * 8);
  const { cursors, skipped } =
    offset > seekThreshold
      ? seekBucketOffsets(buckets, offset)
      : { cursors: new Uint32Array(bucketCount), skipped: 0 };

  const heapBucket = new Uint32Array(bucketCount);
  const heapOrdinal = new Uint32Array(bucketCount);
  let heapSize = 0;
  for (let i = 0; i < bucketCount; i++) {
    const bucket = buckets[i]!;
    const cursor = cursors[i]!;
    if (cursor >= bucket.length) continue;
    heapBucket[heapSize] = i;
    heapOrdinal[heapSize] = bucket[cursor]!;
    heapSize += 1;
  }

  const siftDown = (start: number): void => {
    let idx = start;
    const bIdx = heapBucket[idx]!;
    const ord = heapOrdinal[idx]!;
    while (true) {
      const left = idx * 2 + 1;
      if (left >= heapSize) break;
      const right = left + 1;
      const smallestChild =
        right < heapSize && heapOrdinal[right]! < heapOrdinal[left]!
          ? right
          : left;
      if (ord <= heapOrdinal[smallestChild]!) break;
      heapBucket[idx] = heapBucket[smallestChild]!;
      heapOrdinal[idx] = heapOrdinal[smallestChild]!;
      idx = smallestChild;
    }
    heapBucket[idx] = bIdx;
    heapOrdinal[idx] = ord;
  };

  for (let i = (heapSize >>> 1) - 1; i >= 0; i--) siftDown(i);

  const popNextOrdinal = (): number | undefined => {
    if (heapSize === 0) return undefined;
    const ordinal = heapOrdinal[0]!;
    const bIdx = heapBucket[0]!;
    const bucket = buckets[bIdx]!;
    const nextCursor = cursors[bIdx]! + 1;
    cursors[bIdx] = nextCursor;
    if (nextCursor < bucket.length) {
      heapOrdinal[0] = bucket[nextCursor]!;
      siftDown(0);
    } else {
      heapSize -= 1;
      if (heapSize > 0) {
        heapBucket[0] = heapBucket[heapSize]!;
        heapOrdinal[0] = heapOrdinal[heapSize]!;
        siftDown(0);
      }
    }
    return ordinal;
  };

  for (let i = skipped; i < offset; i++) {
    if (popNextOrdinal() === undefined) break;
  }

  const page: number[] = [];
  while (page.length < pageSize) {
    const ordinal = popNextOrdinal();
    if (ordinal === undefined) break;
    page.push(ordinal);
  }
  return page;
};

const projectIndexedFacts = (
  index: FactsIndex,
  view: FactRequest,
  kinds: ReadonlySet<string> | null,
  paths: ReadonlySet<string> | null,
  keys: readonly string[],
): { readonly rows: FactRow[]; readonly total: number } => {
  const buckets = collectMatchingBuckets(index, kinds, paths);
  const project = (entry: FactEntry) =>
    buildFactRow(
      entry.node,
      entry.observation,
      keys,
      view.include_available_property_keys,
    );
  if (buckets === undefined)
    return selectViewRows(index.all, view, undefined, project);
  if (buckets.length === 0) return { rows: [], total: 0 };
  if (buckets.length === 1)
    return selectViewRows(buckets[0]!, view, undefined, (ordinal) =>
      project(index.all[ordinal]!),
    );
  let total = 0;
  for (const bucket of buckets) total += bucket.length;
  if (view.offset >= total || view.limit <= 0) return { rows: [], total };
  const ordinals = selectMultiBucketPage(
    buckets,
    view.offset,
    view.limit,
    total,
  );
  return {
    rows: ordinals.map((ordinal) => project(index.all[ordinal]!)),
    total,
  };
};

type PropertyFilter = readonly (readonly [string, ReadonlySet<unknown>])[];

/** Values are JSON scalars, so set membership is exact JSON equality. */
const propertyFilter = (where: FactWhere): PropertyFilter | null => {
  if (where.properties === undefined) return null;
  const byKey = new Map<string, ReadonlySet<unknown>>();
  for (const { key, values } of where.properties) {
    const listed = new Set<unknown>(values);
    const existing = byKey.get(key);
    // Repeated keys must all hold; intersect their allowed values.
    byKey.set(
      key,
      existing === undefined
        ? listed
        : new Set([...existing].filter((value) => listed.has(value))),
    );
  }
  return [...byKey];
};

const matchesProperties = (
  observation: ApplicationNode["observations"][number],
  filter: PropertyFilter,
): boolean =>
  filter.every(
    ([key, values]) =>
      Object.hasOwn(observation.properties, key) &&
      values.has(observation.properties[key]),
  );

/** Every observation matching the exact selection, in retained graph order. */
const forEachMatchingFact = (
  nodes: readonly ApplicationNode[],
  where: FactWhere,
  cacheOwner: object | undefined,
  visit: (entry: FactEntry) => void,
): void => {
  const paths = where.paths === undefined ? null : new Set(where.paths);
  const kinds = where.kinds === undefined ? null : new Set(where.kinds);
  const properties = propertyFilter(where);
  if (paths?.size === 0 || kinds?.size === 0) return;
  if (properties?.some(([, values]) => values.size === 0)) return;
  const accept = (entry: FactEntry) => {
    if (properties === null || matchesProperties(entry.observation, properties))
      visit(entry);
  };
  const index = getFactsIndex(nodes, cacheOwner);
  if (index !== undefined) {
    const buckets = collectMatchingBuckets(index, kinds, paths);
    if (buckets === undefined) {
      for (const entry of index.all) accept(entry);
      return;
    }
    const ordinals =
      buckets.length === 1
        ? buckets[0]!
        : buckets.flat().sort((left, right) => left - right);
    for (const ordinal of ordinals) accept(index.all[ordinal]!);
    return;
  }
  for (const node of nodes) {
    if (kinds !== null && !kinds.has(node.kind)) continue;
    for (const observation of node.observations) {
      if (paths !== null) {
        const path = observationPath(observation);
        if (path === null || !paths.has(path)) continue;
      }
      accept({ node, observation });
    }
  }
};

/** One scan, O(page) retained rows; never materialize a whole node or graph. */
export const projectJavaScriptFacts = (
  nodes: readonly ApplicationNode[],
  view: FactRequest,
  cacheOwner?: object,
): { readonly rows: FactRow[]; readonly total: number } => {
  const keys = [...new Set(view.property_keys)];
  if (view.where.properties !== undefined) {
    const rows: FactRow[] = [];
    let total = 0;
    forEachMatchingFact(nodes, view.where, cacheOwner, (entry) => {
      total += 1;
      if (total <= view.offset || rows.length >= view.limit) return;
      rows.push(
        buildFactRow(
          entry.node,
          entry.observation,
          keys,
          view.include_available_property_keys,
        ),
      );
    });
    return { rows, total };
  }
  const paths =
    view.where.paths === undefined ? null : new Set(view.where.paths);
  const kinds =
    view.where.kinds === undefined ? null : new Set(view.where.kinds);
  if (paths?.size === 0 || kinds?.size === 0) return { rows: [], total: 0 };
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

/** Count distinct selected property combinations over every matching observation. */
export const projectJavaScriptFactGroups = (
  nodes: readonly ApplicationNode[],
  view: FactGroupsRequest,
  cacheOwner?: object,
): { readonly rows: FactGroupRow[]; readonly total: number } => {
  const keys = [...new Set(view.group_by)];
  const groups = new Map<
    string,
    {
      readonly properties: FactGroupRow["properties"];
      observations: number;
      readonly nodes: Set<string>;
    }
  >();
  forEachMatchingFact(
    nodes,
    view.where,
    cacheOwner,
    ({ node, observation }) => {
      const properties = Object.fromEntries(
        keys.flatMap((key) =>
          Object.hasOwn(observation.properties, key)
            ? [[key, observation.properties[key]!] as const]
            : [],
        ),
      );
      // Key order follows group_by, so canonical JSON identifies the combination.
      const identity = canonicalJson(
        keys.map((key) =>
          Object.hasOwn(properties, key) ? [properties[key]] : [],
        ),
        "JavaScript fact group",
      );
      const existing = groups.get(identity);
      if (existing === undefined)
        groups.set(identity, {
          properties,
          observations: 1,
          nodes: new Set([node.node_id]),
        });
      else {
        existing.observations += 1;
        existing.nodes.add(node.node_id);
      }
    },
  );
  const rows = [...groups]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(view.offset, view.offset + view.limit)
    .map(([, group]) => ({
      properties: group.properties,
      observation_count: group.observations,
      node_count: group.nodes.size,
    }));
  return { rows, total: groups.size };
};
