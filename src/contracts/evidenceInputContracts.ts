import { z } from "zod";
import { evidenceSchema } from "../domain/evidence.js";
import { prefixedDigestSchema } from "../domain/digests.js";

/** Exact reference to Evidence already retained by the current session. */
export const retainedEvidenceReferenceSchema = z.strictObject({
  kind: z.literal("retained-evidence"),
  evidence_id: prefixedDigestSchema("ev"),
});

/** Portable inline Evidence or an exact, session-scoped reference. */
export const evidenceInputSchema = z.union([
  evidenceSchema,
  retainedEvidenceReferenceSchema,
]);

/** Evidence input after parsing the advertised boundary contract. */
export type EvidenceInput = z.output<typeof evidenceInputSchema>;
