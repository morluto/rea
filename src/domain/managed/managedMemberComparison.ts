import { z } from "zod";

import { digestCanonicalValue } from "../canonicalDigest.js";
import { emptyArraySchema } from "../emptyArraySchema.js";
import { evidenceInputSchema } from "../evidenceReference.js";
import {
  managedInspectionStateSchema,
  cliMetadataGuidSchema,
  managedMetadataStatusSchema,
  managedMetadataTokenSchema,
  managedMemberInspectionSchema,
  type ManagedMemberInspection,
} from "./managedArtifact.js";
import {
  buildComparisonCoverage,
  hasCompleteMethodRows,
  managedComparisonScope,
  buildComparisonMatching,
  buildComparisonSummary,
  comparisonLimitations,
  sideManifest,
} from "./managedMemberComparisonCoverage.js";
import {
  buildFieldItems,
  buildMethodItems,
} from "./managedMemberComparisonItems.js";
import { keyMembers } from "./managedMemberComparisonMatch.js";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { nonEmptyTextSchema } from "../textSchemas.js";
import {
  managedFieldLayoutReader,
  managedFieldLayoutSchema,
} from "./managedFieldLayout.js";

const evidenceIdSchema = prefixedDigestSchema("ev");

const memberComparisonShape = <Source extends z.ZodType>(source: Source) => ({
  left: source,
  right: source,
});

const distinctMemberSources = (
  input: {
    readonly left: { readonly evidence_id: string };
    readonly right: { readonly evidence_id: string };
  },
  context: z.RefinementCtx,
): void => {
  if (
    typeof input.left?.evidence_id === "string" &&
    input.left.evidence_id === input.right?.evidence_id
  )
    context.addIssue({
      code: "custom",
      path: ["right"],
      message: "Managed member Evidence must be distinct",
    });
};

/** Public member comparison selects records inline or by exact retained identity. */
export const compareManagedMembersRequestSchema = z
  .strictObject(memberComparisonShape(evidenceInputSchema))
  .superRefine(distinctMemberSources);

const concreteMatchBasisSchema = z.enum([
  "exact-il-signature",
  "exact-signature",
  "structural-method-shape",
  "field-signature",
]);
const candidateTokensSchema = z.array(managedMetadataTokenSchema).min(1);
const matchedComparisonSchema = z.strictObject({
  status: z.literal("matched"),
  basis: concreteMatchBasisSchema,
  confidence: z.enum(["exact", "high"]),
  candidate_left_tokens: emptyArraySchema,
  candidate_right_tokens: emptyArraySchema,
});
const unmatchedComparisonSchema = z.strictObject({
  status: z.literal("unmatched"),
  basis: z.literal("none"),
  confidence: z.literal("unknown"),
  candidate_left_tokens: emptyArraySchema,
  candidate_right_tokens: emptyArraySchema,
});
const ambiguousComparisonSchema = z.strictObject({
  status: z.literal("ambiguous"),
  basis: concreteMatchBasisSchema,
  confidence: z.literal("unknown"),
  candidate_left_tokens: candidateTokensSchema,
  candidate_right_tokens: candidateTokensSchema,
});
const memberIdentitySchema = z.strictObject({
  token: managedMetadataTokenSchema,
  declaring_type: z.string().nullable(),
  name: z.string(),
  signature_sha256: digestSchema,
  normalized_il_sha256: digestSchema.nullable(),
});

const comparisonItemSchema = <
  Identity extends z.ZodType,
  Base extends Record<string, z.ZodType>,
>(
  base: Base,
  identity: Identity,
) =>
  z.union([
    z.strictObject({
      ...base,
      status: z.enum(["unchanged", "changed", "unknown"]),
      left: identity,
      right: identity,
      match: matchedComparisonSchema,
    }),
    z.strictObject({
      ...base,
      status: z.enum(["removed", "unknown"]),
      left: identity,
      right: z.null(),
      match: unmatchedComparisonSchema,
    }),
    z.strictObject({
      ...base,
      status: z.enum(["added", "unknown"]),
      left: z.null(),
      right: identity,
      match: unmatchedComparisonSchema,
    }),
    z.strictObject({
      ...base,
      status: z.literal("unknown"),
      left: z.null(),
      right: z.null(),
      match: ambiguousComparisonSchema,
    }),
  ]);

/** Stable codes for why one comparison item's facts stayed limited. */
export const MANAGED_MEMBER_COMPARISON_LIMITATION_CODES = [
  "declaring-type-name-not-resolved",
  "counterpart-declaring-type-name-not-resolved",
  "unknown-within-incomplete-metadata",
  "signature-not-decoded",
  "counterpart-signature-not-decoded",
  "signature-not-resolved",
  "counterpart-signature-not-resolved",
  "signature-malformed",
  "ambiguous-signature",
  "ambiguous-il-signature",
  "ambiguous-method-shape",
  "local-signature-unknown",
  "local-signature-bytes-changed",
  "body-unavailable",
  "call-target-unavailable",
  "field-target-unavailable",
  "catch-type-unavailable",
  "layout-declarations-unavailable",
] as const;

/** One reason a comparison item's facts stayed limited, with its explanation. */
const comparisonItemLimitationSchema = z.strictObject({
  code: z.enum(MANAGED_MEMBER_COMPARISON_LIMITATION_CODES),
  side: z
    .enum(["left", "right"])
    .optional()
    .describe(
      "The inventory this limitation concerns when it is the other side's, such as an incomplete or ambiguous counterpart inventory.",
    ),
  message: nonEmptyTextSchema,
});

const comparisonItemContextShape = {
  evidence_links: z.array(evidenceIdSchema).length(2),
  limitations: z.array(comparisonItemLimitationSchema),
};

const methodComparisonItemSchema = comparisonItemSchema(
  {
    ...comparisonItemContextShape,
    item_id: prefixedDigestSchema("mmc_method"),
    dimensions: z.array(
      z.enum([
        "metadata",
        "signature",
        "cil",
        "opcode-shape",
        "call-shape",
        "call-target",
        "field-shape",
        "field-target",
        "exception-shape",
        "exception-target",
        "availability",
        "body-coverage",
      ]),
    ),
  },
  memberIdentitySchema,
);

const fieldComparisonItemSchema = comparisonItemSchema(
  {
    ...comparisonItemContextShape,
    item_id: prefixedDigestSchema("mmc_field"),
  },
  memberIdentitySchema
    .omit({ normalized_il_sha256: true })
    .extend({ layout: managedFieldLayoutSchema.exactOptional() }),
);

const comparisonSideSchema = z.strictObject({
  evidence_id: evidenceIdSchema,
  artifact_sha256: digestSchema,
  mvid: cliMetadataGuidSchema.nullable(),
  module_name: z.string().nullable(),
  metadata_status: managedMetadataStatusSchema,
  methods_total: z.int().min(0),
  fields_total: z.int().min(0),
  resource_limits: z
    .array(
      managedMemberInspectionSchema.shape.coverage.shape.issues.element.extend({
        code: z.literal("resource-limit"),
      }),
    )
    .describe(
      "Resource-limit diagnostics reported by this source; an empty array means none were reported.",
    ),
});

/** Obfuscation-resistant, execution-free managed member comparison. */
export const managedMemberComparisonResultSchema = z.strictObject({
  comparison_id: prefixedDigestSchema("mmc"),
  algorithm: z.strictObject({
    name: z.literal("rea-managed-member-comparison"),
    token_identity: z.literal("build-local"),
    name_matching: z.literal("exact-signature-fallback"),
  }),
  left: comparisonSideSchema,
  right: comparisonSideSchema,
  summary: z.strictObject({
    unchanged: z.int().min(0),
    changed: z.int().min(0),
    added: z.int().min(0),
    removed: z.int().min(0),
    unknown: z.int().min(0),
  }),
  matching: z.strictObject({
    exact_il_signature: z.int().min(0),
    exact_signature: z.int().min(0),
    structural_method_shape: z.int().min(0),
    field_signature: z.int().min(0),
    ambiguous: z.int().min(0),
    unmatched: z.int().min(0),
  }),
  methods: z.array(methodComparisonItemSchema),
  fields: z.array(fieldComparisonItemSchema),
  coverage: z.strictObject({
    status: z
      .enum(["complete-within-inputs", "partial", "unknown"])
      .describe(
        "complete-within-inputs only when both observations are complete over the same selected scope and method rows; unknown when a side is unavailable or the selected scope agreement cannot be established.",
      ),
    left_status: managedInspectionStateSchema,
    right_status: managedInspectionStateSchema,
  }),
  evidence_links: z.array(evidenceIdSchema).length(2),
  limitations: z.array(nonEmptyTextSchema),
});

export type ManagedMemberComparisonResult = z.infer<
  typeof managedMemberComparisonResultSchema
>;

/** One authenticated side of a managed member comparison. */
export interface ManagedMemberComparisonSide {
  readonly evidenceId: string;
  readonly result: ManagedMemberInspection;
}

const callEdgesByCaller = (
  result: ManagedMemberInspection,
): ReadonlyMap<
  string,
  readonly ManagedMemberInspection["call_edges"][number][]
> => {
  const edges = new Map<
    string,
    ManagedMemberInspection["call_edges"][number][]
  >();
  for (const edge of result.call_edges) {
    const callerEdges = edges.get(edge.caller_token);
    if (callerEdges === undefined) edges.set(edge.caller_token, [edge]);
    else callerEdges.push(edge);
  }
  return edges;
};

const fieldAccessesByCaller = (
  result: ManagedMemberInspection,
  emptyFieldTokens: ReadonlySet<string>,
): ReadonlyMap<
  string,
  readonly ManagedMemberInspection["field_accesses"][number][]
> => {
  const accesses = new Map<
    string,
    ManagedMemberInspection["field_accesses"][number][]
  >();
  for (const access of result.field_accesses) {
    const observed =
      emptyFieldTokens.has(access.field_token) &&
      access.target_identity_sha256 !== null
        ? { ...access, target_identity_sha256: null }
        : access;
    const callerAccesses = accesses.get(access.method_token);
    if (callerAccesses === undefined)
      accesses.set(access.method_token, [observed]);
    else callerAccesses.push(observed);
  }
  return accesses;
};

/** Compare managed members with constrained exact and structural identities. */
export const compareManagedMembers = (
  left: ManagedMemberComparisonSide,
  right: ManagedMemberComparisonSide,
): ManagedMemberComparisonResult => {
  const scope = managedComparisonScope(left.result, right.result);
  const { methodMatches, fieldMatches } = keyMembers(left, right, scope);
  const itemContext = {
    leftEvidenceId: left.evidenceId,
    rightEvidenceId: right.evidenceId,
    leftComplete: scope.left.metadataComplete,
    rightComplete: scope.right.metadataComplete,
    leftMethodsComplete:
      scope.left.metadataComplete && hasCompleteMethodRows(left.result),
    rightMethodsComplete:
      scope.right.metadataComplete && hasCompleteMethodRows(right.result),
    scope,
    sameArtifact: left.result.artifact.sha256 === right.result.artifact.sha256,
    leftAssembly: left.result.assembly,
    rightAssembly: right.result.assembly,
    leftFieldLayout: managedFieldLayoutReader(left.result),
    rightFieldLayout: managedFieldLayoutReader(right.result),
    leftCallEdgesByCaller: callEdgesByCaller(left.result),
    rightCallEdgesByCaller: callEdgesByCaller(right.result),
    leftFieldAccessesByCaller: fieldAccessesByCaller(
      left.result,
      scope.left.emptyFieldTokens,
    ),
    rightFieldAccessesByCaller: fieldAccessesByCaller(
      right.result,
      scope.right.emptyFieldTokens,
    ),
  };
  const methodItems = buildMethodItems(methodMatches, itemContext);
  const fieldItems = buildFieldItems(fieldMatches, itemContext);
  const allItems = [...methodItems, ...fieldItems];
  const summary = buildComparisonSummary(allItems);
  const matching = buildComparisonMatching(methodItems, fieldItems);
  const coverage = buildComparisonCoverage({
    left: left.result,
    right: right.result,
    scope,
  });
  const limitations = comparisonLimitations(left.result, right.result, scope);
  const result = {
    comparison_id: `mmc_${digestCanonicalValue(
      {
        left: left.evidenceId,
        right: right.evidenceId,
        methods: [...methodItems],
        fields: [...fieldItems],
      },
      "Managed comparison",
    )}`,
    algorithm: {
      name: "rea-managed-member-comparison" as const,
      token_identity: "build-local" as const,
      name_matching: "exact-signature-fallback" as const,
    },
    left: sideManifest(left),
    right: sideManifest(right),
    summary,
    matching,
    methods: methodItems,
    fields: fieldItems,
    coverage,
    evidence_links: [left.evidenceId, right.evidenceId],
    limitations,
  } satisfies ManagedMemberComparisonResult;
  return managedMemberComparisonResultSchema.parse(result);
};
