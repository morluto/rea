import { z } from "zod";

import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import type {
  ArtifactInventoryCoverage,
  ArtifactNode,
} from "./artifactGraph.js";
import { evidenceSchema, type Evidence } from "./evidence.js";
import { prefixedDigestSchema } from "./digests.js";
import {
  declaresCompleteInventory,
  parseArtifactInventoryEvidence,
  type InventorySet,
} from "./artifactInventoryEvidence.js";
import {
  DEFAULT_MEMBER_INDEX_JSON_BYTES,
  MAX_EXAMINED_NODES,
  buildMemberIndex,
  memberIndexRowSchema,
} from "./artifactFamilyClusteringIndex.js";

/** Caller-selected maximum members; a real allocation bound for retained inventories. */
export const ARTIFACT_FAMILY_MEMBER_LIMIT = 64;
/** A member counts as shared only from two members upward. */
const MINIMUM_SHARED_MEMBERS = 2;

/**
 * The only family tier that can exist: the inventory graph digest commits to
 * the root node's own content digest, so an identical graph implies identical
 * root bytes. A re-packed container with identical members therefore has no
 * family; its relationship is reported through the shared member index.
 */
const familyTierSchema = z.literal("root-sha256");
const clusterStatusSchema = z.enum(["partitioned", "partial", "unknown"]);
const unknownReasonSchema = z.enum([
  "incomplete-inventory",
  "incomparable-coverage-scope",
  "contradictory-integrity",
]);

const evidenceIdSchema = prefixedDigestSchema("ev");

/** One labelled inventory observation supplied by the caller: inline Evidence or retained reference. */
export const artifactFamilyMemberSchema = z.union([
  z.strictObject({
    label: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Caller label for this member, reported verbatim; it is never parsed as identity.",
      ),
    evidence: z
      .union([evidenceSchema, evidenceIdSchema])
      .describe(
        "Authenticated artifact inventory Evidence, inspect_analysis_view summary, or retained Evidence ID.",
      ),
  }),
  z.strictObject({
    label: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Caller label for this member, reported verbatim; it is never parsed as identity.",
      ),
    evidence_id: evidenceIdSchema.describe(
      "Retained artifact inventory Evidence ID in this session.",
    ),
  }),
]);

/** Strict input boundary for deterministic artifact family clustering. */
export const artifactFamilyClusteringInputSchema = z.strictObject({
  members: z
    .array(artifactFamilyMemberSchema)
    .min(2)
    .max(ARTIFACT_FAMILY_MEMBER_LIMIT)
    .describe(
      "Two or more authenticated artifact inventory Evidence records or retained Evidence references.",
    ),
  shared_member_minimum: z
    .number()
    .int()
    .min(MINIMUM_SHARED_MEMBERS)
    .max(ARTIFACT_FAMILY_MEMBER_LIMIT)
    .optional()
    .describe(
      "How many members a graph member must appear in to count as shared; omitted means every member.",
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("First family row."),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .default(100)
    .describe(
      "Maximum family rows returned; the member index is never paged away.",
    ),
});

const memberRowSchema = z.strictObject({
  label: z.string(),
  evidence_id: z.string(),
  root_sha256: z.string().nullable(),
  manifest_id: z.string().nullable(),
  coverage_status: z.string(),
  coverage_scope: z.string(),
});

const unknownMemberRowSchema = memberRowSchema.extend({
  reason: unknownReasonSchema,
});

const familySchema = z.strictObject({
  family_id: z.string(),
  tier: familyTierSchema.nullable(),
  basis: z.string(),
  members: z.array(memberRowSchema),
  unknown_members: z.array(unknownMemberRowSchema),
});

/** Deterministic Evidence-backed partition of two or more artifact inventories. */
export const artifactFamilyClusteringResultSchema = z.strictObject({
  status: clusterStatusSchema,
  summary: z.strictObject({
    members_examined: z.number().int().positive(),
    families: z.number().int().nonnegative(),
    families_returned: z.number().int().nonnegative(),
    shared_member_groups: z.number().int().nonnegative(),
    partially_shared_member_groups: z.number().int().nonnegative(),
    unique_members: z.number().int().nonnegative(),
    members_without_family: z.number().int().nonnegative(),
    members_with_complete_inventory: z.number().int().nonnegative(),
    members_with_unknown_inventory: z.number().int().nonnegative(),
    members_outside_member_scope: z.number().int().nonnegative(),
    members_without_byte_root_digest: z.number().int().nonnegative(),
  }),
  families: z.array(familySchema),
  shared_members: z.array(memberIndexRowSchema),
  partially_shared_members: z.array(memberIndexRowSchema),
  unique_members: z.array(memberIndexRowSchema),
  coverage: z.strictObject({
    members_examined: z.number().int().positive(),
    members_with_complete_inventory: z.number().int().nonnegative(),
    members_with_unknown_inventory: z.number().int().nonnegative(),
    /**
     * Members with complete inventories whose declared coverage scope is not the
     * clustered scope; with no strict majority no scope is settled, so every
     * complete member counts. Incomplete members are counted by
     * `members_with_unknown_inventory` and keep their own scope in their row.
     */
    members_outside_member_scope: z.number().int().nonnegative(),
    /**
     * Complete members whose root digest is derived from their graph, not root
     * bytes. Counted over every complete inventory the call read, whether or
     * not a scope settled, so an unmeasured count never publishes as zero.
     */
    members_without_byte_root_digest: z.number().int().nonnegative(),
    /** Graph nodes in those complete members, whether or not rows were built. */
    nodes_examined: z.number().int().nonnegative(),
    /** Directory nodes, whose identity is graph-derived, left out of the index. */
    nodes_without_byte_identity: z.number().int().nonnegative(),
    shared_member_minimum: z.number().int().positive(),
    member_scope: z.string().nullable(),
    member_index_withheld: z.boolean(),
    /** First family row of the returned page; the member index is never paged. */
    families_offset: z.number().int().nonnegative(),
    families_limit: z.number().int().positive(),
  }),
  limitations: z.array(z.string()),
});

export type ArtifactFamilyClusteringResult = z.infer<
  typeof artifactFamilyClusteringResultSchema
>;

type UnknownReason = z.infer<typeof unknownReasonSchema>;
type MemberRow = z.infer<typeof memberRowSchema>;
interface MemberInventory {
  /** Position in the caller's array: repeated labels still count as members. */
  readonly index: number;
  readonly label: string;
  readonly evidenceId: string;
  readonly inventory: InventorySet;
}

interface ComparableScope {
  readonly clustered: readonly (MemberInventory & {
    readonly reason: UnknownReason | null;
  })[];
  readonly scopes: readonly ArtifactInventoryCoverage["scope"][];
  readonly majorityScope: ArtifactInventoryCoverage["scope"] | null;
}

const orderedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareUnicodeCodePoints);

const fixedLimitations = [
  "Content identity is measured; authorship, provenance and licensing are not.",
  "Identical content does not establish identical runtime behaviour or shared source.",
  "Members are comparable only through the inspection parameters each Evidence declares.",
  "A member absent from a family is described as unplaced with its reason, never as different.",
  "A re-packed container with identical members has no shared root digest, so it has no family; that relationship appears only in shared_members or partially_shared_members.",
  "A member whose root digest no other member shares has no family; it is counted in members_without_family and is not evidence of difference from any other member.",
] as const;

/**
 * The first declaration that prevents a comparable placement, if any. Both a
 * missing graph member and a producer that declares incomplete child coverage
 * leave the inventory incomparable, so both are reported the same way rather
 * than leaving the member out of every row.
 */
const placementBlocker = (input: {
  readonly inventory: InventorySet;
}): UnknownReason | null => {
  if (input.inventory.integrityContradictions.length > 0)
    return "contradictory-integrity";
  if (!declaresCompleteInventory(input.inventory))
    return "incomplete-inventory";
  return null;
};

const memberRow = (
  member: MemberInventory & { readonly reason?: UnknownReason },
): MemberRow => ({
  label: member.label,
  evidence_id: member.evidenceId,
  root_sha256: member.inventory.manifest.root_sha256,
  manifest_id: member.inventory.manifest.manifest_id,
  coverage_status: member.inventory.coverage.status,
  coverage_scope: member.inventory.coverage.scope,
});

const rootNodeOf = (inventory: InventorySet): ArtifactNode | undefined =>
  inventory.nodes.find(
    (node) => node.artifact_id === inventory.manifest.root_artifact_id,
  );

/**
 * Whether the producer digest commits to the root's own bytes. A directory root
 * has no content of its own, so its digest is derived from member names and
 * child identities instead; entries whose content was not read, such as symlink
 * targets, are not committed, so such a digest cannot support a byte-identity
 * claim even between identically named trees. Both producer facts are checked:
 * the manifest's declared root format and the root node's own format, so a
 * disagreement between them stays unresolved rather than aligned.
 */
const hasByteRootDigest = (member: MemberInventory): boolean => {
  const root = rootNodeOf(member.inventory);
  return (
    root !== undefined &&
    root.format !== "directory" &&
    member.inventory.manifest.root_format !== "directory"
  );
};

/** Count repeated values, retaining only the values that repeat. */
const repeatedValues = (
  values: readonly string[],
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
};

/** Parse every member once and record what blocks a comparable placement. */
const parseMembers = (
  members: readonly { readonly label: string; readonly evidence: Evidence }[],
): readonly (MemberInventory & { readonly reason: UnknownReason | null })[] =>
  members.map((member, index) => {
    const { inventory } = parseArtifactInventoryEvidence(member.evidence);
    return {
      index,
      label: member.label,
      evidenceId: member.evidence.evidence_id,
      inventory,
      reason: placementBlocker({ inventory }),
    };
  });

/**
 * Settle the one inventory scope a call may cluster over. Only a strict
 * majority defines it: a tie would otherwise let code-point order decide which
 * member is the outlier.
 */
const comparableScope = (
  parsed: readonly (MemberInventory & {
    readonly reason: UnknownReason | null;
  })[],
): ComparableScope => {
  const scopes: readonly ArtifactInventoryCoverage["scope"][] = [
    ...new Set(parsed.map((entry) => entry.inventory.coverage.scope)),
  ].sort(compareUnicodeCodePoints);
  const counts = repeatedValues(
    parsed.map((entry) => entry.inventory.coverage.scope),
  );
  const ranked = [...scopes].sort(
    (left, right) =>
      (counts.get(right) ?? 0) - (counts.get(left) ?? 0) ||
      compareUnicodeCodePoints(left, right),
  );
  const majorityScope =
    scopes.length <= 1
      ? (scopes[0] ?? null)
      : (counts.get(ranked[0]!) ?? 0) > parsed.length / 2
        ? ranked[0]!
        : null;
  return {
    scopes,
    majorityScope,
    clustered: parsed.map((entry) =>
      majorityScope !== null && entry.inventory.coverage.scope === majorityScope
        ? entry
        : {
            ...entry,
            reason: entry.reason ?? ("incomparable-coverage-scope" as const),
          },
    ),
  };
};

/** Build the family rows and the single unplaced row set. */
const buildFamilies = (
  complete: readonly MemberInventory[],
  unplaced: readonly (MemberRow & { readonly reason: UnknownReason })[],
): ArtifactFamilyClusteringResult["families"] => {
  const families: ArtifactFamilyClusteringResult["families"] = [
    ...complete
      .map((entry) => entry.inventory.manifest.root_sha256)
      .reduce((counts, digest) => {
        counts.set(digest, (counts.get(digest) ?? 0) + 1);
        return counts;
      }, new Map<string, number>())
      .entries(),
  ]
    .filter(([, count]) => count > 1)
    .map(([digest]) => digest)
    .sort(compareUnicodeCodePoints)
    .map((digest) => ({
      // The id is advertised identity, so it carries the complete digest:
      // two distinct roots may share a 16-hex prefix and must stay apart.
      family_id: `root-${digest}`,
      tier: "root-sha256" as const,
      basis:
        "Identical root content digest; these members are byte-identical at the inspected root.",
      members: complete
        .filter((entry) => entry.inventory.manifest.root_sha256 === digest)
        .map(memberRow)
        .sort(
          (left, right) =>
            compareUnicodeCodePoints(left.label, right.label) ||
            compareUnicodeCodePoints(left.evidence_id, right.evidence_id),
        ),
      unknown_members: [] as z.infer<typeof unknownMemberRowSchema>[],
    }));
  if (unplaced.length > 0)
    families.push({
      family_id: "unplaced",
      tier: null,
      basis:
        "Members with no comparable placement; each row carries its own reason and no family claim.",
      members: [],
      unknown_members: [...unplaced].sort(
        (left, right) =>
          compareUnicodeCodePoints(left.label, right.label) ||
          compareUnicodeCodePoints(left.evidence_id, right.evidence_id),
      ),
    });
  return families;
};

const statusFor = (input: {
  readonly compared: number;
  readonly examined: number;
}): z.infer<typeof clusterStatusSchema> =>
  input.compared === 0
    ? "unknown"
    : input.compared === input.examined
      ? "partitioned"
      : "partial";

/** Every limitation this result must state: fixed rules plus this call's facts. */
const clusteringLimitations = (input: {
  readonly parsed: readonly (MemberInventory & {
    readonly reason: UnknownReason | null;
  })[];
  readonly scopes: readonly ArtifactInventoryCoverage["scope"][];
  readonly majorityScope: ArtifactInventoryCoverage["scope"] | null;
  readonly memberCount: number;
  readonly sharedMemberMinimum: number;
  readonly withoutByteRootDigest: number;
  readonly nodesWithoutByteIdentity: number;
  readonly withheldBy: "node-count" | "serialized-size" | null;
  readonly indexBudgetBytes: number;
}): string[] =>
  orderedUnique([
    ...fixedLimitations,
    ...input.parsed.flatMap((entry) =>
      entry.inventory.limitations.map((item) => `${entry.label}: ${item}`),
    ),
    ...(input.scopes.length > 1
      ? [
          input.majorityScope === null
            ? `Members declare different inventory coverage scopes (${input.scopes.join(", ")}) with no strict majority; nothing was clustered and no member is described as different.`
            : `Members declare different inventory coverage scopes (${input.scopes.join(", ")}); only ${input.majorityScope} members were clustered.`,
        ]
      : []),
    ...(input.withoutByteRootDigest === 0
      ? []
      : [
          `${input.withoutByteRootDigest} of ${input.memberCount} members have a root digest derived from their inventory graph rather than the root's own bytes; that digest cannot support a byte-identity claim, so none of them is ever placed in a root-sha256 family.`,
        ]),
    ...(input.nodesWithoutByteIdentity === 0
      ? []
      : [
          `${input.nodesWithoutByteIdentity} directory nodes are excluded from the member index: their identity covers member names and child identities, not bytes, so it cannot support a shared or unique content claim.`,
        ]),
    ...(input.withheldBy === "node-count"
      ? [
          `Examined graph nodes exceeded the ${MAX_EXAMINED_NODES} node budget; the shared and unique member index is withheld rather than reported partially.`,
        ]
      : input.withheldBy === "serialized-size"
        ? [
            `The serialized member index would exceed the ${input.indexBudgetBytes} byte budget; the shared and unique member index is withheld rather than reported partially. The complete inventory Evidence stays retained, so it remains readable through the retained-Evidence views and CLI JSON output.`,
          ]
        : []),
    ...(input.sharedMemberMinimum > input.memberCount
      ? []
      : [
          `A member counts as shared only when it appears in at least ${input.sharedMemberMinimum} of ${input.memberCount} members; members below that threshold are reported separately as partially shared, never dropped.`,
        ]),
    "Exhausting the returned page is not complete capture; every family remains addressable by paging.",
  ]);

/** Partition authenticated inventories into families and a shared/unique member index. */
export const clusterArtifactFamilies = (
  members: readonly { readonly label: string; readonly evidence: Evidence }[],
  options: {
    readonly sharedMemberMinimum?: number;
    /** Serialized JSON budget for the member index; defaults to the domain bound. */
    readonly indexBudgetBytes?: number;
    readonly offset: number;
    readonly limit: number;
  },
): ArtifactFamilyClusteringResult => {
  const minimum = options.sharedMemberMinimum ?? members.length;
  const indexBudgetBytes =
    options.indexBudgetBytes ?? DEFAULT_MEMBER_INDEX_JSON_BYTES;
  const parsed = parseMembers(members);
  const { clustered, scopes, majorityScope } = comparableScope(parsed);
  const placed = clustered.filter((entry) => entry.reason === null);
  // Family placement and the member index need one settled scope, and `placed`
  // is exactly the members that have one: a tie leaves every member unplaced.
  const complete = placed;
  // Omissions are a separate axis from scope. Whether a root digest covers the
  // root's own bytes, and whether a node's identity is graph-derived, are facts
  // about every complete inventory this call read; counting them over the
  // settled scope instead publishes exact-looking zeros whenever a tie settles
  // no scope, so the producer-complete set carries that accounting while family
  // and index claims stay scope-gated.
  const counted = parsed.filter((entry) =>
    declaresCompleteInventory(entry.inventory),
  );
  const unplaced = clustered
    .filter(
      (entry): entry is MemberInventory & { readonly reason: UnknownReason } =>
        entry.reason !== null,
    )
    .map((entry) => ({ ...memberRow(entry), reason: entry.reason }));
  // Only a producer digest of the root's own bytes can support a byte-identity
  // claim; the rest stay indexed and counted instead of being called identical.
  const familyEligible = complete.filter(hasByteRootDigest);
  const withoutByteRootDigest =
    counted.length - counted.filter(hasByteRootDigest).length;
  const families = buildFamilies(familyEligible, unplaced);

  const index = buildMemberIndex({
    complete,
    counted,
    minimum,
    scope: majorityScope,
    budgetBytes: indexBudgetBytes,
  });
  const limitations = clusteringLimitations({
    parsed,
    scopes,
    majorityScope,
    memberCount: members.length,
    sharedMemberMinimum: minimum,
    withoutByteRootDigest,
    nodesWithoutByteIdentity: index.nodesWithoutByteIdentity,
    withheldBy: index.withheldBy,
    indexBudgetBytes,
  });

  const placedMembers = families.reduce(
    (total, family) => total + family.members.length,
    0,
  );
  const compared = clustered.filter((entry) => entry.reason === null).length;
  const page = families.slice(options.offset, options.offset + options.limit);
  // Completeness and scope are separate facts: a member can declare a complete
  // inventory and still sit outside the scope a call could cluster over.
  const completeInventories = parsed.filter((entry) =>
    declaresCompleteInventory(entry.inventory),
  ).length;
  // Counted on the scope axis only, and only for members whose own inventory is
  // complete: an incomplete member is already explained by the unknown-inventory
  // count, and its declared scope stays visible in its own row. With no strict
  // majority no scope is settled, so every complete member is outside it.
  const outsideMemberScope = parsed.filter(
    (entry) =>
      declaresCompleteInventory(entry.inventory) &&
      entry.inventory.coverage.scope !== majorityScope,
  ).length;
  return {
    status: statusFor({ compared, examined: members.length }),
    summary: {
      members_examined: members.length,
      families: families.length,
      families_returned: page.length,
      shared_member_groups: index.shared.length,
      partially_shared_member_groups: index.partiallyShared.length,
      unique_members: index.unique.length,
      members_without_family: compared - placedMembers,
      members_with_complete_inventory: completeInventories,
      members_with_unknown_inventory: members.length - completeInventories,
      members_outside_member_scope: outsideMemberScope,
      members_without_byte_root_digest: withoutByteRootDigest,
    },
    families: page,
    shared_members: index.shared,
    partially_shared_members: index.partiallyShared,
    unique_members: index.unique,
    coverage: {
      members_examined: members.length,
      members_with_complete_inventory: completeInventories,
      members_with_unknown_inventory: members.length - completeInventories,
      members_outside_member_scope: outsideMemberScope,
      members_without_byte_root_digest: withoutByteRootDigest,
      nodes_examined: index.nodesExamined,
      nodes_without_byte_identity: index.nodesWithoutByteIdentity,
      shared_member_minimum: minimum,
      member_scope: majorityScope,
      member_index_withheld: index.withheld,
      families_offset: options.offset,
      families_limit: options.limit,
    },
    limitations,
  };
};

/**
 * Withhold a computed member index without deriving it again. A caller that
 * measured this result against its own transport has every family and every
 * coverage fact it can still ship, and dropping the rows here is the whole
 * change: re-clustering with a smaller index budget would reparse and revalidate
 * every nested inventory, recompute its graph commitments and rebuild the
 * examined-node map only to discard the rows it produced. The index is withheld
 * as a whole, so the rows and their group counts go together, and the caller
 * states the reason it measured in `limitations`.
 */
export const withholdArtifactFamilyClusteringIndex = (
  result: ArtifactFamilyClusteringResult,
): ArtifactFamilyClusteringResult => ({
  ...result,
  summary: {
    ...result.summary,
    shared_member_groups: 0,
    partially_shared_member_groups: 0,
    unique_members: 0,
  },
  shared_members: [],
  partially_shared_members: [],
  unique_members: [],
  coverage: { ...result.coverage, member_index_withheld: true },
});
