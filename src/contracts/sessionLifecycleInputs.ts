import { z } from "zod";
import { analysisProviderSelectorSchema } from "./providerSelection.js";

/** Input contract for opening a target with an optional staged snapshot. */
export const openBinaryInputSchema = z.object({
  path: z.string().min(1),
  provider_id: analysisProviderSelectorSchema.optional(),
  snapshot_path: z.string().min(1).optional(),
});

/** Input contract for closing a target after an optional atomic snapshot. */
export const closeBinaryInputSchema = z.object({
  snapshot_path: z.string().min(1).optional(),
  overwrite: z.boolean().default(false),
});
