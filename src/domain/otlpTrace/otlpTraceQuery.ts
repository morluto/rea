import { z } from "zod";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  OTLP_TRACE_DEFAULT_ATTRIBUTES,
  OTLP_TRACE_DEFAULT_SPANS,
  OTLP_TRACE_MAX_ATTRIBUTES,
  OTLP_TRACE_MAX_FILE_BYTES,
  OTLP_TRACE_MAX_SPANS,
} from "./otlpTrace.js";

export const inspectOtlpTraceInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute path to one caller-supplied OTLP JSON trace export",
  ),
  format: z.enum(["otlp-json"]).optional(),
  max_file_bytes: z
    .int()
    .positive()
    .max(OTLP_TRACE_MAX_FILE_BYTES)
    .optional()
    .describe("Maximum export bytes read (default and maximum 32 MiB)"),
  max_spans: z
    .int()
    .positive()
    .max(OTLP_TRACE_MAX_SPANS)
    .optional()
    .describe(
      `Maximum spans retained from the export (default ${String(OTLP_TRACE_DEFAULT_SPANS)})`,
    ),
  max_attributes: z
    .int()
    .positive()
    .max(OTLP_TRACE_MAX_ATTRIBUTES)
    .optional()
    .describe(
      `Maximum attributes retained per span or resource (default ${String(OTLP_TRACE_DEFAULT_ATTRIBUTES)})`,
    ),
});
export type InspectOtlpTraceInput = z.output<
  typeof inspectOtlpTraceInputSchema
>;
