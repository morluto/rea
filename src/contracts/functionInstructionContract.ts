import { z } from "zod";

import { procedure } from "./toolContractHelpers.js";

/** Provider-neutral input for a function's complete raw instruction list. */
export const functionInstructionInputSchema = z.object({
  procedure,
  document: z.string().optional().describe("The document name"),
});
