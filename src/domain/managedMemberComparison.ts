import { z } from "zod";

import { evidenceSchema } from "./evidence.js";
import {
  cliMetadataGuidSchema,
  type ManagedMemberInspection,
} from "./managedArtifact.js";
import { assessKnownPageCoverage } from "./knownPageCoverage.js";
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
  keyMembers,
  sha256,
} from "./managedMemberComparisonMatch.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const tokenSchema = z.string().regex(/^0x[0-9a-f]{8}$/u);
const boundedTextSchema = z.string().min(1).max(4_096);

const comparisonLimitsSchema = z.strictObject({
  max_method_matches: z.number().int().min(1).max(50_000).default(10_000),
  max_field_matches: z.number().int().min(0).max(50_000).default(5_000),
  max_candidates: z.number().int().min(1).max(500).default(50),
});

/** Two authenticated managed member observations and deterministic bounds. */
export const compareManagedMembersInputSchema = z
  .strictObject({
    left: evidenceSchema,
    right: evidenceSchema,
    limits: comparisonLimitsSchema.default({
      max_method_matches: 10_000,
      max_field_matches: 5_000,
      max_candidates: 50,
    }),
    unknown_registry_approved: z.literal(true).optional(),
  })
  .superRefine((input, context) => {
    if (input.left.evidence_id === input.right.evidence_id)
      context.addIssue({
        code: "custom",
        path: ["right"],
        message: "Managed member Evidence must be distinct",
      });
  });

const matchBasisSchema = z.enum([
  "exact-il-signature",
  "structural-method-shape",
  "field-signature",
  "none",
]);

const matchStatusSchema = z.enum(["matched", "unmatched", "ambiguous"]);
const itemStatusSchema = z.enum([
  "unchanged",
  "changed",
  "added",
  "removed",
  "unknown",
]);

const memberIdentitySchema = z.strictObject({
  token: tokenSchema,
  declaring_type: z.string().nullable(),
  name: z.string(),
  signature_sha256: digestSchema,
  normalized_il_sha256: digestSchema.nullable(),
});

const methodComparisonItemSchema = z.strictObject({
  item_id: z.string().regex(/^mmc_method_[a-f0-9]{64}$/u),
  status: itemStatusSchema,
  left: memberIdentitySchema.nullable(),
  right: memberIdentitySchema.nullable(),
  match: z.strictObject({
    status: matchStatusSchema,
    basis: matchBasisSchema,
    confidence: z.enum(["exact", "high", "unknown"]),
    candidate_left_tokens: z.array(tokenSchema).max(500),
    candidate_right_tokens: z.array(tokenSchema).max(500),
  }),
  dimensions: z
    .array(
      z.enum([
        "signature",
        "cil",
        "opcode-shape",
        "call-shape",
        "field-shape",
        "exception-shape",
        "availability",
      ]),
    )
    .max(7),
  evidence_links: z.array(evidenceIdSchema).length(2),
  limitations: z.array(boundedTextSchema).max(100),
});

const fieldComparisonItemSchema = z.strictObject({
  item_id: z.string().regex(/^mmc_field_[a-f0-9]{64}$/u),
  status: itemStatusSchema,
  left: memberIdentitySchema.omit({ normalized_il_sha256: true }).nullable(),
  right: memberIdentitySchema.omit({ normalized_il_sha256: true }).nullable(),
  match: z.strictObject({
    status: matchStatusSchema,
    basis: matchBasisSchema,
    confidence: z.enum(["exact", "high", "unknown"]),
    candidate_left_tokens: z.array(tokenSchema).max(500),
    candidate_right_tokens: z.array(tokenSchema).max(500),
  }),
  evidence_links: z.array(evidenceIdSchema).length(2),
  limitations: z.array(boundedTextSchema).max(100),
});

/** Obfuscation-resistant, execution-free managed member comparison. */
export const managedMemberComparisonResultSchema = z.strictObject({
  schema_version: z.literal(1),
  comparison_id: z.string().regex(/^mmc_[a-f0-9]{64}$/u),
  algorithm: z.strictObject({
    name: z.literal("rea-managed-member-comparison"),
    version: z.literal(1),
    token_identity: z.literal("build-local"),
    name_matching: z.literal("not-used"),
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
    structural_method_shape: z.number().int().min(0),
    field_signature: z.number().int().min(0),
    ambiguous: z.number().int().min(0),
    unmatched: z.number().int().min(0),
  }),
  methods: z.array(methodComparisonItemSchema).max(50_000),
  fields: z.array(fieldComparisonItemSchema).max(50_000),
  coverage: z.strictObject({
    status: z.enum(["complete-within-inputs", "partial", "truncated"]),
    left_status: z.enum(["complete", "partial", "unavailable"]),
    right_status: z.enum(["complete", "partial", "unavailable"]),
    omitted_methods: z.number().int().min(0),
    omitted_fields: z.number().int().min(0),
    omitted_candidates: z.number().int().min(0),
  }),
  evidence_links: z.array(evidenceIdSchema).length(2),
  limitations: z.array(boundedTextSchema).max(1_000),
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

/** Compare two parsed managed member observations without name-based matching. */
export const compareManagedMembers = (
  left: ManagedMemberComparisonSide,
  right: ManagedMemberComparisonSide,
  limits: CompareManagedMembersInput["limits"],
): ManagedMemberComparisonResult => {
  const leftMethodPage = assessKnownPageCoverage(left.result.methods);
  const rightMethodPage = assessKnownPageCoverage(right.result.methods);
  const leftFieldPage = assessKnownPageCoverage(left.result.fields);
  const rightFieldPage = assessKnownPageCoverage(right.result.fields);
  const { methodMatches, fieldMatches } = keyMembers(
    left,
    right,
    limits.max_candidates,
  );
  const itemContext = {
    leftEvidenceId: left.evidenceId,
    rightEvidenceId: right.evidenceId,
    leftComplete: leftMethodPage.sourceComplete && leftFieldPage.sourceComplete,
    rightComplete:
      rightMethodPage.sourceComplete && rightFieldPage.sourceComplete,
    limits,
  };
  const methodItems = buildMethodItems(methodMatches, itemContext);
  const fieldItems = buildFieldItems(fieldMatches, itemContext);
  const allItems = [...methodItems.items, ...fieldItems.items];
  const summary = buildComparisonSummary(allItems);
  const matching = buildComparisonMatching(methodItems.items, fieldItems.items);
  const coverage = buildComparisonCoverage({
    left: left.result,
    right: right.result,
    leftMethodPage,
    rightMethodPage,
    leftFieldPage,
    rightFieldPage,
    omittedMethodItems: methodItems.omitted,
    omittedFieldItems: fieldItems.omitted,
    omittedCandidates:
      methodMatches.omittedCandidates + fieldMatches.omittedCandidates,
  });
  const limitations = comparisonLimitations(
    left.result,
    right.result,
    coverage.omitted_methods + coverage.omitted_fields,
    coverage.omitted_candidates,
  );
  const result = {
    schema_version: 1 as const,
    comparison_id: `mmc_${sha256({
      left: left.evidenceId,
      right: right.evidenceId,
      methods: [...methodItems.items],
      fields: [...fieldItems.items],
      limits,
    })}`,
    algorithm: {
      name: "rea-managed-member-comparison" as const,
      version: 1 as const,
      token_identity: "build-local" as const,
      name_matching: "not-used" as const,
    },
    left: sideManifest(left),
    right: sideManifest(right),
    summary,
    matching,
    methods: methodItems.items,
    fields: fieldItems.items,
    coverage,
    evidence_links: [left.evidenceId, right.evidenceId],
    limitations,
  } satisfies ManagedMemberComparisonResult;
  return managedMemberComparisonResultSchema.parse(result);
};

export { parseManagedMemberEvidence } from "./managedMemberComparisonMatch.js";
