import { z } from "zod";
import { analysisErrorProjectionSchema } from "../../contracts/errorSchemas.js";

/** Identity facts attached to one requested batch selector. */
export const batchProcedureIdentitySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("resolved"),
    address: z.string().min(1).describe("Observed canonical procedure entry."),
    name: z
      .string()
      .nullable()
      .describe("Provider's entry label, or null when unavailable."),
    name_error: analysisErrorProjectionSchema.exactOptional(),
  }),
  z.object({
    status: z.literal("unknown"),
    error: analysisErrorProjectionSchema,
  }),
]);

const batchSelectorSchema = z
  .string()
  .describe("Original caller-selected symbol or address.");

/** Caveats only this item's own provider observation can explain. */
export const batchItemLimitationsSchema = z
  .array(z.string())
  .exactOptional()
  .describe(
    "Caveats of this item's own provider observation when it supplied no pseudocode, including any reason the provider reported.",
  );

/** One ordered batch outcome; array position keeps duplicate selectors distinct. */
export const batchDecompileItemSchema = z.discriminatedUnion("status", [
  z.object({
    address: batchSelectorSchema,
    procedure: batchProcedureIdentitySchema,
    status: z.literal("ok"),
    pseudocode: z.string().min(1),
  }),
  z.object({
    address: batchSelectorSchema,
    procedure: batchProcedureIdentitySchema,
    status: z.literal("error"),
    error: analysisErrorProjectionSchema,
    limitations: batchItemLimitationsSchema,
  }),
]);

/** Provider-independent result owned by the shared batch decompilation workflow. */
export const batchDecompileResultSchema = z.object({
  items: z.array(batchDecompileItemSchema),
  total: z.int().min(0),
  succeeded: z.int().min(0),
  failed: z.int().min(0),
});

export type BatchProcedureIdentity = z.output<
  typeof batchProcedureIdentitySchema
>;
export type BatchDecompileItem = z.output<typeof batchDecompileItemSchema>;
export type BatchDecompileResult = z.output<typeof batchDecompileResultSchema>;
