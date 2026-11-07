import { z } from "zod";
import { literalFeatureMatchSchema } from "./literalFeatureMatch.js";
import { traceContainingProcedureSchema } from "./nativeObservation.js";

/** One observed reference with an independently resolved or unavailable owner. */
export const literalFeatureReferenceSchema = z.object({
  target_address: z.string(),
  source_address: z.string(),
  containing_procedure: traceContainingProcedureSchema,
});

/** Complete result of a native literal feature trace. */
export const literalFeatureTraceSchema = z.object({
  query: z.string(),
  search_mode: z.literal("literal"),
  matches: z.array(literalFeatureMatchSchema),
  references: z.array(literalFeatureReferenceSchema),
  truncated: z.boolean(),
  residual_unknowns: z.array(z.string()),
});

export type LiteralFeatureReference = z.infer<
  typeof literalFeatureReferenceSchema
>;
