import { z } from "zod";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  firmwareLiteralPoolsPageContextSchema,
  firmwareLiteralPoolsSummarySchema,
  firmwareLiteralPoolsViewItemsSchema,
  firmwareLiteralPoolsViewRequestSchema,
} from "../firmwareLiteralPoolsView.js";

export const firmwareLiteralPoolsSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_firmware_literal_pools"),
  summary: firmwareLiteralPoolsSummarySchema,
});

export const firmwareLiteralPoolsPageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("firmware-literal-pools"),
  parent_operation: z.literal("inspect_firmware_literal_pools"),
  view: firmwareLiteralPoolsViewRequestSchema,
  literal_pools: firmwareLiteralPoolsPageContextSchema,
  items: firmwareLiteralPoolsViewItemsSchema,
});
