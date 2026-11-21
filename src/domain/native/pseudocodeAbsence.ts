import { z } from "zod";

/** Provider-observed reasons for a null pseudocode result. */
export const pseudocodeAbsenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("provider-failure"),
    reason: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("not-in-export"),
    reason: z.string().min(1),
  }),
]);

export type PseudocodeAbsence = z.infer<typeof pseudocodeAbsenceSchema>;
