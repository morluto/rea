import { z } from "zod";

/** Repeatable option whose literals the command and its CLI diagnostics exclude. */
export const explicitSensitiveValueOptions = {
  sensitiveValue: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Literal string values explicitly marked sensitive; repeat as needed",
    ),
};
