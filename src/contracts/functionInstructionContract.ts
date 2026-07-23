import { z } from "zod";

/** Provider-neutral input for one bounded raw function-instruction window. */
export const functionInstructionInputSchema = z.object({
  procedure: z.string().describe("The procedure name or address"),
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(500).default(64),
  document: z.string().optional().describe("The document name"),
});
