import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import {
  traceDiagnosticSchema,
  traceEventSchema,
  traceMemberSchema,
  traceStreamSchema,
} from "./playwrightTrace.js";
const page = {
  kind: z.literal("playwright-trace"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(32),
};
export const playwrightTraceViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      ...page,
      collection: z.literal("event-text"),
      event_id: traceEventSchema.shape.event_id,
      limit: z.int().positive().default(2048),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("streams"),
      stream_ids: z.array(traceStreamSchema.shape.stream_id).optional(),
      fields: z.array(traceStreamSchema.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("events"),
      event_ids: z.array(traceEventSchema.shape.event_id).optional(),
      stream_ids: z.array(traceEventSchema.shape.stream_id).optional(),
      kinds: z.array(traceEventSchema.shape.kind).optional(),
      call_ids: z.array(z.string()).optional(),
      fields: z
        .array(z.enum([...traceEventSchema.keyof().options, "text_preview"]))
        .optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("members"),
      member_ids: z.array(traceMemberSchema.shape.member_id).optional(),
      paths: z.array(z.string()).optional(),
      fields: z.array(traceMemberSchema.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("diagnostics"),
      codes: z.array(z.string()).optional(),
      fields: z.array(traceDiagnosticSchema.keyof()).optional(),
    }),
  ],
);
export const inspectPlaywrightTraceInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to an offline Playwright v10 trace ZIP",
  ),
  detail: z.enum(["summary", "complete"]).default("summary"),
  view: playwrightTraceViewRequestSchema
    .optional()
    .describe(
      "Return this selected page immediately; complete supported Evidence is retained",
    ),
});
