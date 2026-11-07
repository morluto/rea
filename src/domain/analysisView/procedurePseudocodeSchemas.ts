import { z } from "zod";

export const procedurePseudocodeSelectionSchema = z.strictObject({
  procedure: z.string(),
  document: z.string().optional(),
});

/** A returned null remains distinct from a returned, empty pseudocode string. */
export const procedurePseudocodeSummarySchema = z.strictObject({
  selection: procedurePseudocodeSelectionSchema,
  pseudocode: z.discriminatedUnion("available", [
    z.strictObject({
      available: z.literal(true),
      code_units: z.number().int().nonnegative(),
      unit: z.literal("utf16-code-units"),
    }),
    z.strictObject({
      available: z.literal(false),
      reason: z.literal("Provider returned null"),
    }),
  ]),
});
