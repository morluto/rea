import { z } from "zod";

import { emptyArraySchema } from "./emptyArraySchema.js";
import { evidenceSchema } from "./evidence.js";
import {
  cliMetadataGuidSchema,
  type ManagedMemberInspection,
} from "./managedArtifact.js";
import {
  buildComparisonCoverage,
  buildComparisonMatching,
  buildComparisonSummary,
  comparisonLimitations,
  sideManifest,
} from "./managedMemberComparisonCoverage.js";
import {
  buildFieldItems,
  buildMethodItems,
} from "./managedMemberComparisonItems.js";
import { keyMembers, sha256 } from "./managedMemberComparisonMatch.js";
import { digestSchema } from "./../domain/digests.js";
import { prefixedDigestSchema } from "./../domain/digests.js";

const evidenceIdSchema = prefixedDigestSchema("ev");
const tokenSchema = z.string().regex(/^0x[0-9a-f]{8}$/u);
const boundedTextSchema = z.string().min(1);

/** Two authenticated managed member observations. */
export const compareManagedMembersInputSchema = z
  .strictObject({
    left: evidenceSchema,
    right: evidenceSchema,
  })
  .superRefine((input, context) => {
    if (input.left.evidence_id === input.right.evidence_id)
      context.addIssue({
        code: "custom",
        path: ["right"],
        message: "Managed member Evidence must be distinct",
      });
  });

const concreteMatchBasisSchema = z.enum([
  "exact-il-signature",
  "exact-signature",
  "structural-method-shape",
  "field-signature",
]);
const candidateTokensSchema = z.array(tokenSchema).min(1);
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
  token: tokenSchema,
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

const comparisonItemContextShape = {
  evidence_links: z.array(evidenceIdSchema).length(2),
  limitations: z.array(boundedTextSchema),
};

const methodComparisonItemSchema = comparisonItemSchema(
  {
    ...comparisonItemContextShape,
    item_id: prefixedDigestSchema("mmc_method"),
    dimensions: z.array(
      z.enum([
        "signature",
        "cil",
        "opcode-shape",
        "call-shape",
        "field-shape",
        "exception-shape",
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
  memberIdentitySchema.omit({ normalized_il_sha256: true }),
);

/** Obfuscation-resistant, execution-free managed member comparison. */
export const managedMemberComparisonResultSchema = z.strictObject({
  comparison_id: prefixedDigestSchema("mmc"),
  algorithm: z.strictObject({
    name: z.literal("rea-managed-member-comparison"),
    token_identity: z.literal("build-local"),
    name_matching: z.literal("exact-signature-fallback"),
  }),
  left: z.strictObject({
    evidence_id: evidenceIdSchema,
    artifact_sha256: digestSchema,
    mvid: cliMetadataGuidSchema.nullable(),
    module_name: z.string().nullable(),
    metadata_status: z.enum(["absent", "complete", "partial", "malformed"]),
    methods_total: z.number().int().min(0),
    fields_total: z.number().int().min(0),
  }),
  right: z.strictObject({
    evidence_id: evidenceIdSchema,
    artifact_sha256: digestSchema,
    mvid: cliMetadataGuidSchema.nullable(),
    module_name: z.string().nullable(),
    metadata_status: z.enum(["absent", "complete", "partial", "malformed"]),
    methods_total: z.number().int().min(0),
    fields_total: z.number().int().min(0),
  }),
  summary: z.strictObject({
    unchanged: z.number().int().min(0),
    changed: z.number().int().min(0),
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
    unknown: z.number().int().min(0),
  }),
  matching: z.strictObject({
    exact_il_signature: z.number().int().min(0),
    exact_signature: z.number().int().min(0),
    structural_method_shape: z.number().int().min(0),
    field_signature: z.number().int().min(0),
    ambiguous: z.number().int().min(0),
    unmatched: z.number().int().min(0),
  }),
  methods: z.array(methodComparisonItemSchema),
  fields: z.array(fieldComparisonItemSchema),
  coverage: z.strictObject({
    status: z.enum(["complete-within-inputs", "partial"]),
    left_status: z.enum(["complete", "partial", "unavailable"]),
    right_status: z.enum(["complete", "partial", "unavailable"]),
  }),
  evidence_links: z.array(evidenceIdSchema).length(2),
  limitations: z.array(boundedTextSchema),
});

export type CompareManagedMembersInput = z.infer<
  typeof compareManagedMembersInputSchema
>;
export type ManagedMemberComparisonResult = z.infer<
  typeof managedMemberComparisonResultSchema
>;

/** One authenticated side of a managed member comparison. */
export interface ManagedMemberComparisonSide {
  readonly evidenceId: string;
  readonly result: ManagedMemberInspection;
}

/** Compare managed members with constrained exact and structural identities. */
export const compareManagedMembers = (
  left: ManagedMemberComparisonSide,
  right: ManagedMemberComparisonSide,
): ManagedMemberComparisonResult => {
  const leftCoverage = {
    sourceComplete: left.result.coverage.state === "complete",
  };
  const rightCoverage = {
    sourceComplete: right.result.coverage.state === "complete",
  };
  const { methodMatches, fieldMatches } = keyMembers(left, right);
  const itemContext = {
    leftEvidenceId: left.evidenceId,
    rightEvidenceId: right.evidenceId,
    leftComplete: leftCoverage.sourceComplete,
    rightComplete: rightCoverage.sourceComplete,
  };
  const methodItems = buildMethodItems(methodMatches, itemContext);
  const fieldItems = buildFieldItems(fieldMatches, itemContext);
  const allItems = [...methodItems, ...fieldItems];
  const summary = buildComparisonSummary(allItems);
  const matching = buildComparisonMatching(methodItems, fieldItems);
  const coverage = buildComparisonCoverage({
    left: left.result,
    right: right.result,
  });
  const limitations = comparisonLimitations(left.result, right.result);
  const result = {
    comparison_id: `mmc_${sha256({
      left: left.evidenceId,
      right: right.evidenceId,
      methods: [...methodItems],
      fields: [...fieldItems],
    })}`,
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

export { parseManagedMemberEvidence } from "./managedMemberComparisonMatch.js";
