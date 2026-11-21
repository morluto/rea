import { z } from "zod";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import { OTLP_TRACE_MAX_FILE_BYTES } from "./otlpTrace.js";

export const inspectOtlpTraceInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute path to one caller-supplied OTLP JSON trace export",
  ),
  format: z.enum(["otlp-json"]).default("otlp-json"),
  max_file_bytes: z
    .int()
    .positive()
    .max(OTLP_TRACE_MAX_FILE_BYTES)
    .default(OTLP_TRACE_MAX_FILE_BYTES)
    .describe(
      "Maximum export bytes read (up to 32 MiB); this does not adjust span or attribute allowances",
    ),
});
export type InspectOtlpTraceInput = z.output<
  typeof inspectOtlpTraceInputSchema
>;
