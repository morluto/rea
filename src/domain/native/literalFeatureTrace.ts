import { z } from "zod";
import { literalFeatureMatchSchema } from "./literalFeatureMatch.js";
import { traceContainingProcedureSchema } from "./nativeObservation.js";

/** One provider-reported reference to a literal match and its owner outcome. */
export const literalFeatureReferenceSchema = z.object({
  target_address: z.string(),
  source_address: z.string(),
  containing_procedure: traceContainingProcedureSchema,
});
export type LiteralFeatureReference = z.infer<
  typeof literalFeatureReferenceSchema
>;

/** Complete trace_feature result, owned once for delivery and retained views. */
export const literalFeatureTraceResultSchema = z.object({
  query: z.string(),
  search_mode: z.literal("literal"),
  matches: z.array(literalFeatureMatchSchema),
  references: z.array(literalFeatureReferenceSchema),
  truncated: z.boolean(),
  residual_unknowns: z.array(z.string()),
});
export type LiteralFeatureTraceResult = z.infer<
  typeof literalFeatureTraceResultSchema
>;

/** Owner outcome of one reference, without reinterpreting its provider facts. */
export const literalReferenceOwner = (
  reference: LiteralFeatureReference,
): "found" | "not-found" | "unavailable" => {
  const owner = reference.containing_procedure;
  if ("status" in owner) return "unavailable";
  return owner.found ? "found" : "not-found";
};
