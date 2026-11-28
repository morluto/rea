import { z } from "zod";
import { SOURCE_MAP_BUDGETS } from "../../domain/sourceMapLimits.js";
import {
  webSourceMapReportSchema,
  webSourcePositionSchema,
} from "../../domain/webSourceLocation.js";

/** Limits that the isolated local source-map codec can raise on its own. */
export const CODEC_SOURCE_MAP_LIMIT_FIELDS = [
  "map_bytes",
  "output_bytes",
  "decoded_rows",
  "decoded_segments",
  "decoded_records",
  "section_depth",
] as const;

export type CodecSourceMapLimitField =
  (typeof CODEC_SOURCE_MAP_LIMIT_FIELDS)[number];

export const codecSourceMapLimitFieldSchema = z.enum(
  CODEC_SOURCE_MAP_LIMIT_FIELDS,
);

const codecFailureLimitSchema = z
  .strictObject({
    field: codecSourceMapLimitFieldSchema,
    maximum: z.number().int(),
  })
  .superRefine((limit, context) => {
    const budget = SOURCE_MAP_BUDGETS[limit.field];
    if (limit.maximum < budget.minimum || limit.maximum > budget.maximum)
      context.addIssue({
        code: "custom",
        path: ["maximum"],
        message: `Codec reported ${limit.field} maximum ${String(limit.maximum)} outside ${String(budget.minimum)}..${String(budget.maximum)}.`,
      });
  });

/** Trusted codec process input; captured application code is never evaluated. */
export const sourceMapCodecInputSchema = z.strictObject({
  text: z.string(),
  url: z.string().min(1),
  position: webSourcePositionSchema,
});

/** Codec success or a specific producer/resource constraint. */
export const sourceMapCodecReplySchema = z.union([
  z.strictObject({
    state: z.literal("success"),
    report: webSourceMapReportSchema,
  }),
  z.strictObject({
    state: z.literal("failure"),
    reason: z.literal("limit"),
    message: z.string(),
    limit: codecFailureLimitSchema.exactOptional(),
  }),
  z.strictObject({
    state: z.literal("failure"),
    reason: z.enum(["malformed", "unsupported"]),
    message: z.string(),
  }),
]);
