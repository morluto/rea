import { z } from "zod";
import { packetCaptureSchema } from "./packetCapture.js";
import {
  BOUNDED_PRODUCER_LIMITS,
  boundedProducerLimitsSchema,
} from "../producerResourceLimits.js";

/** TShark 4.6.9 emits a 22.3 MB glossary, so discovery retains more output than a capture. */
export const PACKET_FIELD_PRODUCER_LIMITS = {
  ...BOUNDED_PRODUCER_LIMITS,
  output_bytes: 32 * 1024 * 1024,
} as const;

export const inspectPacketFieldsInputSchema = z.strictObject({
  producer_limits: boundedProducerLimitsSchema
    .unwrap()
    .omit({ input_bytes: true })
    .optional()
    .describe(
      "Per-call producer budgets; defaults match packet capture except output_bytes defaults to 32 MiB for the complete field glossary. No capture input is read. Tighter inherited OS limits still win; no restart. Does not raise the separate page record budget.",
    ),
  kind: z
    .enum(["protocols", "fields"])
    .default("protocols")
    .describe("Return protocol registrations or field definitions"),
  protocol: z
    .string()
    .min(1)
    .max(8192)
    .nullable()
    .default(null)
    .describe(
      "Exact protocol abbreviation; selects that protocol or its registered fields",
    ),
  query: z
    .string()
    .max(8192)
    .default("")
    .describe(
      "Case-insensitive literal substring in name, abbreviation or field description",
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .default(0)
    .describe("Number of matching records to skip"),
  limit: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .default(50)
    .describe(
      "Maximum matches returned; null requests all remaining. A page whose records exceed the 8 MiB record budget ends early with output_window.record_budget_reached; continue from offset + returned",
    ),
});
export type InspectPacketFieldsInput = z.infer<
  typeof inspectPacketFieldsInputSchema
>;
export const packetFieldRecordSchema = z.strictObject({
  source_line: z.number().int().positive(),
  kind: z.enum(["protocol", "field"]),
  name: z.string(),
  abbreviation: z.string(),
  field_type: z.string().nullable(),
  parent_protocol: z.string().nullable(),
  display_base: z.string().nullable(),
  bitmask: z.string().nullable(),
  description: z.string().nullable(),
});
export type PacketFieldRecord = z.infer<typeof packetFieldRecordSchema>;
export const packetFieldsCatalogSchema = z
  .strictObject({
    selection: inspectPacketFieldsInputSchema,
    records: z.array(packetFieldRecordSchema),
    output_window: z.strictObject({
      examined: z.number().int().nonnegative(),
      matching: z.number().int().nonnegative(),
      returned: z.number().int().nonnegative(),
      has_more: z.boolean(),
      /** The page ended before `limit` because its records filled the record budget. */
      record_budget_reached: z.boolean(),
    }),
    diagnostics: z.string(),
    tool: packetCaptureSchema.shape.tool,
    resource_limiter: packetCaptureSchema.shape.resource_limiter,
    limits: packetCaptureSchema.shape.limits.extend({
      record_budget_bytes: z.literal(8388608),
    }),
    configuration: z.literal("private-empty-personal-profile"),
    hardware_acquisition: z.literal("not-performed"),
  })
  .superRefine((report, context) => {
    const w = report.output_window;
    const remaining = Math.max(0, w.matching - report.selection.offset);
    const requested = Math.min(remaining, report.selection.limit ?? remaining);
    if (
      w.matching > w.examined ||
      (w.record_budget_reached
        ? w.returned < 1 || w.returned >= requested
        : w.returned !== requested) ||
      report.records.length !== w.returned ||
      w.has_more !== remaining > w.returned ||
      report.records.some(
        (row) =>
          row.kind !==
          (report.selection.kind === "protocols" ? "protocol" : "field"),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["output_window"],
        message:
          "Field discovery coverage must match the selected page and record kind",
      });
  });
