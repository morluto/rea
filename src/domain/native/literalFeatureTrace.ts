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
  references: z
    .array(literalFeatureReferenceSchema)
    .describe(
      "References to matched start addresses only; references to interior bytes of strings and procedures are not searched. Empty does not establish absence.",
    ),
  truncated: z
    .boolean()
    .describe(
      "True only when a provider reports a reference cap; false does not establish complete reference coverage.",
    ),
  residual_unknowns: z.array(z.string()),
});

export type LiteralFeatureReference = z.infer<
  typeof literalFeatureReferenceSchema
>;
