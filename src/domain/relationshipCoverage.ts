import { z } from "zod";

const diagnostics = z.array(z.string().min(1)).min(1);
const completeCoverage = z.strictObject({ status: z.literal("complete") });
const partialCoverage = z.strictObject({
  status: z.literal("partial"),
  limitations: z.array(z.string().min(1)).min(1),
});
const unknownCoverage = z.strictObject({
  status: z.literal("unknown"),
  reason: z.string().min(1),
});

/** Explicit coverage state for a provider's observed caller/callee set. */
export const relationshipCoverageSchema = z.union([
  completeCoverage,
  completeCoverage.extend({ diagnostics }),
  partialCoverage,
  partialCoverage.extend({ diagnostics }),
  unknownCoverage,
  unknownCoverage.extend({ diagnostics }),
]);

export type RelationshipCoverage = z.infer<typeof relationshipCoverageSchema>;
