import { z } from "zod";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  uefiFirmwarePageContextSchema,
  uefiFirmwareSummarySchema,
  uefiFirmwareViewItemsSchema,
  uefiFirmwareViewRequestSchema,
} from "../uefiFirmwareView.js";

export const uefiFirmwareSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_uefi_firmware"),
  summary: uefiFirmwareSummarySchema,
});

export const uefiFirmwarePageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("uefi-firmware"),
  parent_operation: z.literal("inspect_uefi_firmware"),
  view: uefiFirmwareViewRequestSchema,
  uefi_firmware: uefiFirmwarePageContextSchema,
  items: uefiFirmwareViewItemsSchema,
});
