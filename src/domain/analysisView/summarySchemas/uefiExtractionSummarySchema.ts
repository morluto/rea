import { z } from "zod";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  uefiExtractionPageContextSchema,
  uefiExtractionSummarySchema,
  uefiExtractionViewItemsSchema,
  uefiExtractionViewRequestSchema,
} from "../uefiExtractionView.js";

export const uefiExtractionSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("extract_uefi_firmware"),
  summary: uefiExtractionSummarySchema,
});

export const uefiExtractionPageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("uefi-extraction"),
  parent_operation: z.literal("extract_uefi_firmware"),
  view: uefiExtractionViewRequestSchema,
  uefi_extraction: uefiExtractionPageContextSchema,
  items: uefiExtractionViewItemsSchema,
});
