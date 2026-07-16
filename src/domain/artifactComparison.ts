import canonicalize from "canonicalize";
import { z } from "zod";

import {
  type ArtifactInventoryResult,
  type ArtifactNode,
  type ArtifactOccurrence,
} from "./artifactGraph.js";
import {
  parseArtifactInventoryEvidence,
  type InventorySet,
} from "./artifactInventoryEvidence.js";

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const comparisonStatusSchema = z.enum([
  "unchanged",
  "added",
  "removed",
  "changed",
  "truncated",
  "unknown",
  "contradiction",
]);
const changeKindSchema = z.enum([
  "added",
  "removed",
  "changed",
  "unknown",
  "contradiction",
]);
const comparisonDimensionSchema = z.enum([
  "content",
  "kind",
  "format",
  "size",
  "executable",
  "relations",
  "metadata",
  "availability",
  "integrity",
]);

/** Strict Evidence-backed input for deterministic artifact comparison. */
export const artifactComparisonInputSchema = z.strictObject({
  left_evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
  right_evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
  unknown_registry_approved: z
    .literal(true)
    .optional()
    .describe("Explicit approval to record incomplete or differing evidence"),
});

/** One path-classified artifact change with citations to both observations. */
const artifactChangeSchema = z.object({
  classification: changeKindSchema,
  logical_path: z.string().min(1).max(4_096),
  dimensions: z.array(comparisonDimensionSchema).min(1).max(8),
  left_occurrence_id: z
    .string()
    .regex(/^occ_[a-f0-9]{64}$/u)
    .nullable(),
  right_occurrence_id: z
    .string()
    .regex(/^occ_[a-f0-9]{64}$/u)
    .nullable(),
  left_artifact_id: z
    .string()
    .regex(/^art_[a-f0-9]{64}$/u)
    .nullable(),
  right_artifact_id: z
    .string()
    .regex(/^art_[a-f0-9]{64}$/u)
    .nullable(),
  evidence_links: z.array(evidenceIdSchema).min(2).max(200),
});

/** Bounded deterministic artifact comparison with an independently paged delta. */
export const artifactComparisonResultSchema = z.object({
  status: comparisonStatusSchema,
  left_manifest_id: z.string().regex(/^agm_[a-f0-9]{64}$/u),
  right_manifest_id: z.string().regex(/^agm_[a-f0-9]{64}$/u),
  summary: z.object({
    unchanged: z.number().int().min(0),
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
    changed: z.number().int().min(0),
    unknown: z.number().int().min(0),
    contradiction: z.number().int().min(0).default(0),
  }),
  changes: z.object({
    items: z.array(artifactChangeSchema).max(500),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(500),
    total: z.number().int().min(0),
    next_offset: z.number().int().min(0).nullable(),
  }),
  limitations: z.array(z.string()),
});

export type ArtifactComparisonResult = z.infer<
  typeof artifactComparisonResultSchema
>;
type ArtifactChange = z.infer<typeof artifactChangeSchema>;

/** Compare complete inventory pages without treating missing evidence as equality. */
export const compareArtifacts = (
  leftEvidence: unknown,
  rightEvidence: unknown,
  offset: number,
  limit: number,
): ArtifactComparisonResult => {
  const left = parseArtifactInventoryEvidence(leftEvidence);
  const right = parseArtifactInventoryEvidence(rightEvidence);
  const leftComplete = left.inventory.complete;
  const rightComplete = right.inventory.complete;
  const leftCovered =
    leftComplete && !hasCoverageLimitation(left.inventory.limitations);
  const rightCovered =
    rightComplete && !hasCoverageLimitation(right.inventory.limitations);
  const limitations = [
    ...left.inventory.limitations.map((item) => `Left: ${item}`),
    ...right.inventory.limitations.map((item) => `Right: ${item}`),
    ...(leftComplete ? [] : ["Left artifact inventory is incomplete."]),
    ...(rightComplete ? [] : ["Right artifact inventory is incomplete."]),
  ];
  const changes = compareOccurrences(
    left.inventory,
    right.inventory,
    [
      ...left.evidence.map(({ evidence_id: id }) => id),
      ...right.evidence.map(({ evidence_id: id }) => id),
    ],
    leftCovered && rightCovered,
  );
  const summary = summarize(
    left.inventory,
    right.inventory,
    changes,
    leftCovered && rightCovered,
  );
  const page = changes.slice(offset, offset + limit);
  return artifactComparisonResultSchema.parse({
    status:
      !leftComplete || !rightComplete
        ? "truncated"
        : changes.some(
              ({ classification }) => classification === "contradiction",
            )
          ? "contradiction"
          : !leftCovered || !rightCovered
            ? "unknown"
            : changes.some(({ classification }) => classification === "unknown")
              ? "unknown"
              : changes.length === 0
                ? "unchanged"
                : "changed",
    left_manifest_id: left.inventory.manifest.manifest_id,
    right_manifest_id: right.inventory.manifest.manifest_id,
    summary,
    changes: {
      items: page,
      offset,
      limit,
      total: changes.length,
      next_offset:
        offset + page.length < changes.length ? offset + page.length : null,
    },
    limitations: [...new Set(limitations)].sort((a, b) => a.localeCompare(b)),
  });
};

const compareOccurrences = (
  left: InventorySet,
  right: InventorySet,
  evidenceLinks: readonly string[],
  complete: boolean,
): ArtifactChange[] => {
  const leftByPath = new Map(
    left.occurrences.map((item) => [item.logical_path, item]),
  );
  const rightByPath = new Map(
    right.occurrences.map((item) => [item.logical_path, item]),
  );
  const leftNodes = new Map(left.nodes.map((item) => [item.artifact_id, item]));
  const rightNodes = new Map(
    right.nodes.map((item) => [item.artifact_id, item]),
  );
  const leftRelations = relationsByPath(left);
  const rightRelations = relationsByPath(right);
  const paths = [
    ...new Set([...leftByPath.keys(), ...rightByPath.keys()]),
  ].sort((a, b) => a.localeCompare(b, "en"));
  const output: ArtifactChange[] = [];
  for (const path of paths) {
    const leftOccurrence = leftByPath.get(path);
    const rightOccurrence = rightByPath.get(path);
    const change = classifyPath({
      path,
      leftOccurrence,
      rightOccurrence,
      leftNode: nodeFor(leftOccurrence, leftNodes),
      rightNode: nodeFor(rightOccurrence, rightNodes),
      leftRelations: leftRelations.get(path) ?? [],
      rightRelations: rightRelations.get(path) ?? [],
      complete,
      evidenceLinks,
    });
    if (change !== null) output.push(change);
  }
  return output;
};

const classifyPath = (input: {
  readonly path: string;
  readonly leftOccurrence: ArtifactOccurrence | undefined;
  readonly rightOccurrence: ArtifactOccurrence | undefined;
  readonly leftNode: ArtifactNode | undefined;
  readonly rightNode: ArtifactNode | undefined;
  readonly leftRelations: readonly RelationProjection[];
  readonly rightRelations: readonly RelationProjection[];
  readonly complete: boolean;
  readonly evidenceLinks: readonly string[];
}): ArtifactChange | null => {
  const base = {
    logical_path: input.path,
    left_occurrence_id: input.leftOccurrence?.occurrence_id ?? null,
    right_occurrence_id: input.rightOccurrence?.occurrence_id ?? null,
    left_artifact_id: input.leftOccurrence?.artifact_id ?? null,
    right_artifact_id: input.rightOccurrence?.artifact_id ?? null,
    evidence_links: [...input.evidenceLinks],
  };
  if (input.leftOccurrence === undefined)
    return {
      ...base,
      classification: input.complete ? "added" : "unknown",
      dimensions: [input.complete ? "content" : "availability"],
    };
  if (input.rightOccurrence === undefined)
    return {
      ...base,
      classification: input.complete ? "removed" : "unknown",
      dimensions: [input.complete ? "content" : "availability"],
    };
  if (
    input.leftOccurrence.hash_status === "mismatched" ||
    input.rightOccurrence.hash_status === "mismatched"
  )
    return {
      ...base,
      classification: "contradiction",
      dimensions: ["integrity"],
    };
  if (
    input.leftOccurrence.hash_status !== "verified" ||
    input.rightOccurrence.hash_status !== "verified" ||
    input.leftNode === undefined ||
    input.rightNode === undefined
  )
    return { ...base, classification: "unknown", dimensions: ["availability"] };
  const dimensions = changedDimensions(input);
  return dimensions.length === 0
    ? null
    : { ...base, classification: "changed", dimensions };
};

const changedDimensions = (input: {
  readonly leftNode: ArtifactNode | undefined;
  readonly rightNode: ArtifactNode | undefined;
  readonly leftOccurrence: ArtifactOccurrence | undefined;
  readonly rightOccurrence: ArtifactOccurrence | undefined;
  readonly leftRelations: readonly RelationProjection[];
  readonly rightRelations: readonly RelationProjection[];
}): z.infer<typeof comparisonDimensionSchema>[] => {
  const left = input.leftNode;
  const right = input.rightNode;
  if (left === undefined || right === undefined) return ["availability"];
  const checks: readonly [
    z.infer<typeof comparisonDimensionSchema>,
    boolean,
  ][] = [
    ["content", left.sha256 !== right.sha256],
    ["kind", left.kind !== right.kind],
    ["format", left.format !== right.format],
    ["size", left.size !== right.size],
    [
      "executable",
      input.leftOccurrence?.executable !== input.rightOccurrence?.executable,
    ],
    [
      "relations",
      JSON.stringify(input.leftRelations) !==
        JSON.stringify(input.rightRelations),
    ],
    ["metadata", metadataChanged(input, left, right)],
  ];
  return checks
    .filter(([, changed]) => changed)
    .map(([dimension]) => dimension);
};

const metadataChanged = (
  input: {
    readonly leftOccurrence: ArtifactOccurrence | undefined;
    readonly rightOccurrence: ArtifactOccurrence | undefined;
  },
  left: ArtifactNode,
  right: ArtifactNode,
): boolean =>
  left.media_type !== right.media_type ||
  left.architecture !== right.architecture ||
  left.executable !== right.executable ||
  left.content_state !== right.content_state ||
  input.leftOccurrence?.entry_kind !== input.rightOccurrence?.entry_kind ||
  input.leftOccurrence?.encrypted !== input.rightOccurrence?.encrypted ||
  JSON.stringify(left.limitations) !== JSON.stringify(right.limitations) ||
  JSON.stringify(input.leftOccurrence?.limitations) !==
    JSON.stringify(input.rightOccurrence?.limitations);

const canonicalJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError(
      "Artifact comparison could not canonicalize graph data",
    );
  return encoded;
};

const nodeFor = (
  occurrence: ArtifactOccurrence | undefined,
  nodes: ReadonlyMap<string, ArtifactNode>,
): ArtifactNode | undefined =>
  occurrence?.artifact_id === null || occurrence?.artifact_id === undefined
    ? undefined
    : nodes.get(occurrence.artifact_id);

const relationsByPath = (
  inventory: InventorySet,
): ReadonlyMap<string, readonly RelationProjection[]> => {
  const output = new Map<string, RelationProjection[]>();
  const occurrences = new Map(
    inventory.occurrences.map((item) => [item.occurrence_id, item]),
  );
  for (const edge of inventory.edges) {
    const path = edge.logical_path ?? ".";
    const values = output.get(path);
    const occurrence = occurrences.get(edge.occurrence_id);
    const projection: RelationProjection = {
      parent_logical_path:
        occurrence?.parent_occurrence_id === null ||
        occurrence?.parent_occurrence_id === undefined
          ? null
          : (occurrences.get(occurrence.parent_occurrence_id)?.logical_path ??
            null),
      child_artifact_id: edge.child_artifact_id,
      relation: edge.relation,
      logical_path: edge.logical_path,
      producer: edge.producer,
    };
    if (values === undefined) output.set(path, [projection]);
    else values.push(projection);
  }
  for (const values of output.values())
    values.sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
  return output;
};

interface RelationProjection {
  /** Logical parent is stable across graph-root ID changes. */
  readonly parent_logical_path: string | null;
  readonly child_artifact_id: string;
  readonly relation: ArtifactInventoryResult["edges"]["items"][number]["relation"];
  readonly logical_path: string | null;
  /** Producer is semantic provenance; edge ordinal is presentation order. */
  readonly producer: ArtifactInventoryResult["edges"]["items"][number]["producer"];
}

const summarize = (
  left: InventorySet,
  right: InventorySet,
  changes: readonly ArtifactChange[],
  covered: boolean,
) => {
  const counts = {
    added: 0,
    removed: 0,
    changed: 0,
    unknown: 0,
    contradiction: 0,
  };
  for (const change of changes) counts[change.classification] += 1;
  return {
    unchanged: covered
      ? Math.max(
          0,
          Math.min(left.occurrences.length, right.occurrences.length) -
            counts.changed -
            counts.contradiction -
            counts.unknown,
        )
      : 0,
    ...counts,
    unknown: covered
      ? counts.unknown
      : Math.max(
          counts.unknown,
          Math.max(
            left.manifest.occurrence_count,
            right.manifest.occurrence_count,
          ) -
            counts.added -
            counts.removed -
            counts.changed -
            counts.contradiction,
        ),
  };
};

const hasCoverageLimitation = (limitations: readonly string[]): boolean =>
  limitations.some(
    (limitation) =>
      !/integrity contradiction\(s\) were recorded/u.test(limitation),
  );
