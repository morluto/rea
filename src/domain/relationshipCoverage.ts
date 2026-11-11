import { z } from "zod";

import { fixedTupleSchema } from "./fixedTupleSchema.js";

const diagnostics = z.array(z.string().min(1)).min(1).exactOptional();
/** Discovery describes possible static calls beyond the returned provider graph. */
export const relationshipDiscoveryDirectionSchema = z.strictObject({
  status: z.enum(["complete", "partial", "unknown"]),
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
  limited_directions: limitedDirections.exactOptional(),
  diagnostics,
  discovery,
});
export const unknownRelationshipCoverageSchema = z.strictObject({
  status: z.literal("unknown"),
  reason: z.string().min(1),
  limited_directions: limitedDirections.exactOptional(),
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

export type RelationshipDiscoveryStatus = z.infer<
  typeof relationshipDiscoveryDirectionSchema
>["status"];

/** Combine discovery facts without treating missing historical metadata as proof. */
export const combineRelationshipDiscovery = (
  current: RelationshipDiscoveryStatus,
  coverage: RelationshipCoverage | null | undefined,
  direction: "callers" | "callees",
): RelationshipDiscoveryStatus => {
  const next = coverage?.discovery?.[direction]?.status ?? "unknown";
  if (current === "partial" || next === "partial") return "partial";
  if (current === "unknown" || next === "unknown") return "unknown";
  return "complete";
};

/** Reasons the observed relationship inventory cannot establish completeness. */
export const relationshipCoverageLimitations = (
  coverage: RelationshipCoverage | null | undefined,
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
