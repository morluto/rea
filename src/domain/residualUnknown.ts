import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const unknownIdSchema = z.string().regex(/^unk_[a-f0-9]{64}$/u);
const boundedText = z.string().trim().min(1).max(1_000);
const environmentRequirementSchema = z.object({
  id: z.string().min(1).max(200).nullable(),
  platform: z.string().min(1).max(100).nullable(),
  architecture: z.string().min(1).max(100).nullable(),
  isolation: z
    .enum(["none", "process", "container", "virtual-machine"])
    .nullable(),
});
const probeSchema = z.object({
  operation: z.string().min(1).max(200),
  rationale: boundedText,
});
const relationshipSchema = z.object({
  type: z.enum(["depends-on", "related-to", "contradicts"]),
  unknown_id: unknownIdSchema,
});
const resolutionSchema = z.discriminatedUnion("disposition", [
  z.object({
    disposition: z.literal("verified"),
    rationale: boundedText,
    evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
  }),
  z.object({
    disposition: z.enum(["withdrawn", "out-of-scope"]),
    rationale: boundedText,
    evidence_ids: z.array(evidenceIdSchema).max(100),
  }),
]);

/** Strict durable record for one unresolved or evidence-qualified question. */
const residualUnknownObjectSchema = z.object({
  registry_version: z.literal(1),
  unknown_id: unknownIdSchema,
  revision: z.number().int().min(1),
  previous_revision_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  revision_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  scope_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  question: boundedText,
  status: z.enum([
    "open",
    "investigating",
    "blocked",
    "contradicted",
    "resolved",
  ]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  domain: z.string().trim().min(1).max(100),
  supporting_evidence_ids: z.array(evidenceIdSchema).max(100),
  contradicting_evidence_ids: z.array(evidenceIdSchema).max(100),
  required_authority: z
    .enum([
      "shipped-artifact",
      "controlled-replay",
      "historical-reference",
      "external-service",
      "analyst-inference",
    ])
    .nullable(),
  required_confidence: z.enum(["observed", "derived", "inferred"]),
  required_environment: environmentRequirementSchema.nullable(),
  recommended_probes: z.array(probeSchema).max(20),
  relationships: z.array(relationshipSchema).max(100),
  resolution: resolutionSchema.nullable(),
  mutation_evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
});

export const residualUnknownSchema = residualUnknownObjectSchema.superRefine(
  (value, context) => {
    if (computeRevisionDigest(value) !== value.revision_digest)
      context.addIssue({
        code: "custom",
        message: "Residual unknown revision digest does not match",
        path: ["revision_digest"],
      });
    if ((value.revision === 1) !== (value.previous_revision_digest === null))
      context.addIssue({
        code: "custom",
        message: "Only the first revision has no predecessor",
        path: ["previous_revision_digest"],
      });
    if ((value.status === "resolved") !== (value.resolution !== null))
      context.addIssue({
        code: "custom",
        message: "Only resolved unknowns carry a resolution",
        path: ["resolution"],
      });
    if (
      value.status === "contradicted" &&
      value.contradicting_evidence_ids.length === 0
    )
      context.addIssue({
        code: "custom",
        message: "Contradicted status requires contradicting evidence",
        path: ["contradicting_evidence_ids"],
      });
    if (
      value.relationships.some(
        (relationship) => relationship.unknown_id === value.unknown_id,
      )
    )
      context.addIssue({
        code: "custom",
        message: "An unknown cannot relate to itself",
        path: ["relationships"],
      });
    for (const ids of [
      value.supporting_evidence_ids,
      value.contradicting_evidence_ids,
      value.mutation_evidence_ids,
    ])
      if (new Set(ids).size !== ids.length)
        context.addIssue({
          code: "custom",
          message: "Evidence IDs must be unique",
        });
    if (
      value.supporting_evidence_ids.some((id) =>
        value.contradicting_evidence_ids.includes(id),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Evidence cannot simultaneously support and contradict",
      });
    const relationships = value.relationships.map(
      (relationship) => `${relationship.type}:${relationship.unknown_id}`,
    );
    if (new Set(relationships).size !== relationships.length)
      context.addIssue({
        code: "custom",
        message: "Relationships must be unique",
        path: ["relationships"],
      });
  },
);

export type ResidualUnknown = z.infer<typeof residualUnknownSchema>;
export type UnknownStatus = ResidualUnknown["status"];

/** Input for deterministic creation of one residual unknown. */
export const recordUnknownInputSchema = residualUnknownObjectSchema
  .omit({
    registry_version: true,
    unknown_id: true,
    revision: true,
    previous_revision_digest: true,
    revision_digest: true,
    scope_digest: true,
    status: true,
    supporting_evidence_ids: true,
    contradicting_evidence_ids: true,
    resolution: true,
    mutation_evidence_ids: true,
  })
  .extend({
    supporting_evidence_ids: z.array(evidenceIdSchema).max(100).default([]),
    contradicting_evidence_ids: z.array(evidenceIdSchema).max(100).default([]),
    approved: z.literal(true),
  });

export type RecordUnknownInput = z.infer<typeof recordUnknownInputSchema>;

/** Explicit optimistic-concurrency update command for one unknown. */
export const updateUnknownInputSchema = z.object({
  unknown_id: unknownIdSchema,
  expected_revision: z.number().int().min(1),
  approved: z.literal(true),
  status: residualUnknownObjectSchema.shape.status,
  severity: residualUnknownObjectSchema.shape.severity,
  supporting_evidence_ids: z.array(evidenceIdSchema).max(100),
  contradicting_evidence_ids: z.array(evidenceIdSchema).max(100),
  required_authority: residualUnknownObjectSchema.shape.required_authority,
  required_confidence: residualUnknownObjectSchema.shape.required_confidence,
  required_environment: environmentRequirementSchema.nullable(),
  recommended_probes: z.array(probeSchema).max(20),
  relationships: z.array(relationshipSchema).max(100),
  resolution: resolutionSchema.nullable(),
});

export type UpdateUnknownInput = z.infer<typeof updateUnknownInputSchema>;

/** Create stable identity from immutable question and domain fields. */
export const createResidualUnknown = (
  input: RecordUnknownInput,
  mutationEvidenceId: string,
  scopeDigest: string | null,
): ResidualUnknown => {
  const question = input.question.replace(/\s+/gu, " ");
  const identity = canonicalJson({
    domain: input.domain,
    question,
    scope_digest: scopeDigest,
  });
  const revision = {
    registry_version: 1,
    unknown_id: `unk_${createHash("sha256").update(identity).digest("hex")}`,
    revision: 1,
    previous_revision_digest: null,
    scope_digest: scopeDigest,
    question,
    status:
      input.contradicting_evidence_ids.length > 0 ? "contradicted" : "open",
    domain: input.domain,
    ...projectRevisionDetails(input),
    resolution: null,
    mutation_evidence_ids: [mutationEvidenceId],
  } satisfies Omit<ResidualUnknown, "revision_digest">;
  return residualUnknownSchema.parse({
    ...revision,
    revision_digest: computeRevisionDigest(revision),
  });
};

/** Apply a complete, revision-guarded replacement while preserving identity. */
export const updateResidualUnknown = (
  current: ResidualUnknown,
  input: UpdateUnknownInput,
  mutationEvidenceId: string,
): ResidualUnknown => {
  const revision = {
    registry_version: 1,
    unknown_id: current.unknown_id,
    revision: current.revision + 1,
    previous_revision_digest: current.revision_digest,
    scope_digest: current.scope_digest,
    question: current.question,
    status: input.status,
    domain: current.domain,
    ...projectRevisionDetails(input),
    resolution: input.resolution,
    mutation_evidence_ids: sortedUnique([
      ...current.mutation_evidence_ids,
      mutationEvidenceId,
    ]),
  } satisfies Omit<ResidualUnknown, "revision_digest">;
  return residualUnknownSchema.parse({
    ...revision,
    revision_digest: computeRevisionDigest(revision),
  });
};

type RevisionDetailsInput = Pick<
  ResidualUnknown,
  | "severity"
  | "supporting_evidence_ids"
  | "contradicting_evidence_ids"
  | "required_authority"
  | "required_confidence"
  | "required_environment"
  | "recommended_probes"
  | "relationships"
>;

const projectRevisionDetails = (input: RevisionDetailsInput) => ({
  severity: input.severity,
  supporting_evidence_ids: sortedUnique(input.supporting_evidence_ids),
  contradicting_evidence_ids: sortedUnique(input.contradicting_evidence_ids),
  required_authority: input.required_authority,
  required_confidence: input.required_confidence,
  required_environment: input.required_environment,
  recommended_probes: [...input.recommended_probes],
  relationships: sortedRelationships(input.relationships),
});

const computeRevisionDigest = (
  value: Omit<ResidualUnknown, "revision_digest"> | ResidualUnknown,
): string => {
  const { revision_digest: _revisionDigest, ...semantic } =
    "revision_digest" in value ? value : { ...value, revision_digest: "" };
  void _revisionDigest;
  return createHash("sha256").update(canonicalJson(semantic)).digest("hex");
};

const canonicalJson = (value: unknown): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined) throw new TypeError("Unknown identity failed");
  return serialized;
};

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const sortedRelationships = (
  values: readonly z.infer<typeof relationshipSchema>[],
): z.infer<typeof relationshipSchema>[] =>
  [...values].sort((left, right) =>
    `${left.type}:${left.unknown_id}`.localeCompare(
      `${right.type}:${right.unknown_id}`,
    ),
  );
