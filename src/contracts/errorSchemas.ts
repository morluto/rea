import { z } from "zod";

import { analysisErrorProjectionSchema } from "../domain/analysisErrorProjectionSchema.js";

/** CLI label and input diagnostics surrounding the strict canonical error projection. */
export const analysisCliErrorEnvelopeSchema = z
  .object({
    error: z.string().min(1),
    input_path: z.string().optional(),
    input_reason: z
      .enum(["invalid-json", "read-failed", "too-large"])
      .optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    const {
      error: _label,
      input_path: _inputPath,
      input_reason: _inputReason,
      ...projection
    } = value;
    const parsed = analysisErrorProjectionSchema.safeParse(projection);
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        message:
          "CLI error envelope must contain a canonical analysis error projection",
      });
    }
  });
