import { coverageStatusSchema } from "./coverage.js";
import { z } from "zod";

import { fixedTupleSchema } from "./fixedTupleSchema.js";

const diagnostics = z.array(z.string().min(1)).min(1).exactOptional();
/** Discovery describes possible static calls beyond the returned provider graph. */
export const relationshipDiscoveryDirectionSchema = z.strictObject({
  status: coverageStatusSchema,
  reason: z.string().min(1).exactOptional(),
});
export const relationshipDiscoverySchema = z.strictObject({
  callers: relationshipDiscoveryDirectionSchema.exactOptional(),
  callees: relationshipDiscoveryDirectionSchema.exactOptional(),
});
const discovery = relationshipDiscoverySchema.exactOptional();
export const completeRelationshipCoverageSchema = z.strictObject({
  status: z.literal("complete"),
  diagnostics,
  discovery,
});
const limitedDirections = z.union([
  fixedTupleSchema([z.literal("callers")]),
  fixedTupleSchema([z.literal("callees")]),
  fixedTupleSchema([z.literal("callers"), z.literal("callees")]),
]);
export const partialRelationshipCoverageSchema = z.strictObject({
  status: z.literal("partial"),
  limitations: z.array(z.string().min(1)).min(1),
  limited_directions: limitedDirections,
  diagnostics,
  discovery,
});
export const unknownRelationshipCoverageSchema = z.strictObject({
  status: z.literal("unknown"),
  reason: z.string().min(1),
  limited_directions: limitedDirections,
  diagnostics,
  discovery,
});

/** Explicit coverage state for a provider's observed caller/callee set. */
export const relationshipCoverageSchema = z.discriminatedUnion("status", [
  completeRelationshipCoverageSchema,
  partialRelationshipCoverageSchema,
  unknownRelationshipCoverageSchema,
]);

export type RelationshipCoverage = z.infer<typeof relationshipCoverageSchema>;

/**
 * Persisted format-2 Evidence/snapshot reader schema.
 *
 * Format-2 records written before `limited_directions` became required on live
 * provider replies (for example IDA `procedure_callees` when upstream omitted
 * its truncation marker) may omit `limited_directions` on `partial` and
 * `unknown` coverage. Keeping it optional here preserves saved investigations
 * and their committed `evidence_id`s until `EVIDENCE_FORMAT_REVISION` advances,
 * while live provider replies enforce `relationshipCoverageSchema`.
 */
export const evidenceRelationshipCoverageSchema = z.discriminatedUnion(
  "status",
  [
    completeRelationshipCoverageSchema,
    partialRelationshipCoverageSchema.extend({
      limited_directions: limitedDirections.exactOptional(),
    }),
    unknownRelationshipCoverageSchema.extend({
      limited_directions: limitedDirections.exactOptional(),
    }),
  ],
);

export type EvidenceRelationshipCoverage = z.infer<
  typeof evidenceRelationshipCoverageSchema
>;

/** Ensure a persisted format-2 coverage carries `limited_directions` for live tool outputs. */
export const withRequiredLimitedDirections = (
  coverage: EvidenceRelationshipCoverage,
  fallbackDirections: Extract<
    RelationshipCoverage,
    { status: "partial" }
  >["limited_directions"],
): RelationshipCoverage => {
  if (coverage.status === "complete") return coverage;
  if (coverage.limited_directions !== undefined)
    return { ...coverage, limited_directions: coverage.limited_directions };
  return { ...coverage, limited_directions: fallbackDirections };
};

export type RelationshipDiscoveryStatus = z.infer<
  typeof relationshipDiscoveryDirectionSchema
>["status"];

/** Combine discovery facts without treating missing historical metadata as proof. */
export const combineRelationshipDiscovery = (
  current: RelationshipDiscoveryStatus,
  coverage: EvidenceRelationshipCoverage | null | undefined,
  direction: "callers" | "callees",
): RelationshipDiscoveryStatus => {
  const next = coverage?.discovery?.[direction]?.status ?? "unknown";
  if (current === "partial" || next === "partial") return "partial";
  if (current === "unknown" || next === "unknown") return "unknown";
  return "complete";
};

/** Reasons the observed relationship inventory cannot establish completeness. */
export const relationshipCoverageLimitations = (
  coverage: EvidenceRelationshipCoverage | null | undefined,
): readonly string[] => {
  switch (coverage?.status) {
    case undefined:
      return ["Provider did not report relationship coverage."];
    case "complete":
      return [];
    case "partial":
      return coverage.limitations;
    case "unknown":
      return [coverage.reason];
  }
};
