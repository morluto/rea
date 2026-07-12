import { z } from "zod";

import { evidenceSchema, type Evidence } from "./evidence.js";

export const evidenceBundleSchema = z.object({
  bundle_version: z.literal(1),
  records: z.array(evidenceSchema),
});

export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

/** Project records into a deterministic bundle whose order has no semantics. */
export const createEvidenceBundle = (
  records: readonly Evidence[],
): EvidenceBundle => ({
  bundle_version: 1,
  records: [...records].sort((left, right) =>
    left.evidence_id.localeCompare(right.evidence_id),
  ),
});
