import { z } from "zod";

import { evidenceBundleSchema } from "./evidenceBundle.js";

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const unknownIdSchema = z.string().regex(/^unk_[a-f0-9]{64}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const claimIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,99}$/u);
const titleSchema = z.string().trim().min(1).max(500);
const verificationStatusSchema = z.enum(["pass", "fail", "unknown"]);
const commonClaim = {
  claim_id: claimIdSchema,
  title: titleSchema,
  comparison_evidence_id: evidenceIdSchema,
};

const behavioralClaimSchema = z.object({
  ...commonClaim,
  kind: z.literal("behavioral"),
  dimension: z.enum([
    "overall",
    "terminal",
    "interaction",
    "exit",
    "filesystem",
    "protocol",
    "process",
    "shim",
  ]),
});
const functionClaimSchema = z.object({
  ...commonClaim,
  kind: z.literal("structural-function"),
  dimension: z.enum([
    "overall",
    "identity",
    "pseudocode",
    "assembly",
    "comments",
    "calls",
    "references",
    "strings_names",
    "cfg",
  ]),
});
const artifactClaimSchema = z.object({
  ...commonClaim,
  kind: z.literal("structural-artifact"),
  dimension: z.literal("overall"),
});

const reconstructionClaimSchema = z.discriminatedUnion("kind", [
  behavioralClaimSchema,
  functionClaimSchema,
  artifactClaimSchema,
]);

/** Finite, typed behavioral and structural specification. */
export const reconstructionSpecificationSchema = z
  .object({
    schema_version: z.literal(1),
    name: z.string().trim().min(1).max(200),
    claims: z.array(reconstructionClaimSchema).min(1).max(100),
  })
  .superRefine((value, context) => {
    const ids = value.claims.map(({ claim_id: id }) => id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "Claim IDs must be unique" });
    const selectors = value.claims.map(
      ({ kind, comparison_evidence_id: id, dimension }) =>
        `${kind}:${id}:${dimension}`,
    );
    if (new Set(selectors).size !== selectors.length)
      context.addIssue({
        code: "custom",
        message: "Claim comparison selectors must be unique",
      });
  });

/** Bounded reconstruction-verification input. */
export const reconstructionVerificationInputSchema = z.object({
  specification: reconstructionSpecificationSchema,
  evidence_bundle: evidenceBundleSchema,
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(100),
  unknown_registry_approved: z.literal(true).optional(),
});

export const reconstructionClaimResultSchema = z.object({
  claim_id: claimIdSchema,
  kind: z.enum(["behavioral", "structural-function", "structural-artifact"]),
  dimension: z.string().min(1),
  status: verificationStatusSchema,
  observed_status: z.enum([
    "unchanged",
    "added",
    "removed",
    "changed",
    "truncated",
    "unknown",
    "contradiction",
  ]),
  comparison_evidence_id: evidenceIdSchema,
  left_evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
  right_evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
  evidence_links: z.array(evidenceIdSchema).min(3).max(201),
  unknown_ids: z.array(unknownIdSchema).max(100),
  limitations: z.array(z.string()),
});

/** Evidence-cited result over every declared claim, independently paged. */
export const reconstructionVerificationResultSchema = z.object({
  status: verificationStatusSchema,
  specification_sha256: digestSchema,
  summary: z.object({
    total: z.number().int().min(1).max(100),
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    unknown: z.number().int().min(0),
    behavioral: z.number().int().min(0),
    structural: z.number().int().min(0),
  }),
  claims: z.object({
    items: z.array(reconstructionClaimResultSchema).max(100),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(100),
    total: z.number().int().min(1).max(100),
    next_offset: z.number().int().min(0).nullable(),
  }),
  recommended_probes: z
    .array(
      z.object({
        operation: z.string().min(1).max(200),
        rationale: z.string().min(1).max(1_000),
        claim_ids: z.array(claimIdSchema).min(1).max(100),
        unknown_ids: z.array(unknownIdSchema).max(100),
      }),
    )
    .max(2_000),
  evidence_links: z.array(evidenceIdSchema).min(3).max(20_100),
  limitations: z.array(z.string()),
});

export type ReconstructionClaim = z.infer<typeof reconstructionClaimSchema>;
export type ReconstructionClaimResult = z.infer<
  typeof reconstructionClaimResultSchema
>;
export type ReconstructionVerificationResult = z.infer<
  typeof reconstructionVerificationResultSchema
>;
export type ReconstructionObservedStatus =
  ReconstructionClaimResult["observed_status"];
