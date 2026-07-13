import { z } from "zod";

/** Input contract for opening a target with an optional staged snapshot. */
export const openBinaryInputSchema = z.object({
  path: z.string().min(1),
  snapshot_path: z.string().min(1).optional(),
});

/** Input contract for closing a target after an optional atomic snapshot. */
export const closeBinaryInputSchema = z.object({
  snapshot_path: z.string().min(1).optional(),
  overwrite: z.boolean().default(false),
});
