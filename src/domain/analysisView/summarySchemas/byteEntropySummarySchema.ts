import { z } from "zod";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  byteEntropyPageContextSchema,
  byteEntropySummarySchema,
  byteEntropyViewItemsSchema,
  byteEntropyViewRequestSchema,
} from "../byteEntropyView.js";

export const byteEntropySummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  summary: byteEntropySummarySchema,
  parent_operation: z.literal("inspect_byte_entropy"),
});

/** One index page of the retained block or run series. */
export const byteEntropyPageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("byte-entropy"),
  view: byteEntropyViewRequestSchema,
  entropy: byteEntropyPageContextSchema,
  items: byteEntropyViewItemsSchema,
  parent_operation: z.literal("inspect_byte_entropy"),
});
