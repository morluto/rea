import { z } from "zod";

/**
 * Read the recorded-evidence reference a partial MCP failure carries.
 *
 * A partial observation that the session recorded is reported to the caller as
 * a reference, so one reader serves every provider that records one.
 */
export function retainedEvidenceReference(error: {
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}): { readonly evidence_id: string } {
  return z
    .object({
      partial_observation: z.object({
        kind: z.literal("retained-evidence"),
        evidence_id: z.string(),
      }),
    })
    .parse(error.details).partial_observation;
}
