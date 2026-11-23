import { z } from "zod";
import { digestSchema } from "../../digests.js";
import {
  javaScriptRouteInventorySchema,
  javaScriptRouteInventorySourceSchema,
} from "../../javascript/javascriptRouteInventory.js";
import { artifactSchema, viewResultBaseFields } from "../analysisViewBase.js";
import {
  javaScriptRoutesViewItemsSchema,
  javaScriptRoutesViewRequestSchema,
  javaScriptRoutesViewSummarySchema,
} from "../javascriptRoutesView.js";

export const javaScriptRoutesViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  artifact: artifactSchema.nullable(),
  kind: z.literal("javascript-routes"),
  parent_operation: z.enum([
    "analyze_javascript_application",
    "analyze_web_bundle",
  ]),
  view: javaScriptRoutesViewRequestSchema,
  inventory_id: javaScriptRouteInventorySchema.shape.inventory_id,
  source_manifest_sha256: digestSchema,
  source_coverage: javaScriptRouteInventorySchema.shape.coverage,
  inventory_capacity: javaScriptRouteInventorySchema.shape.capacity,
  capture_url: z.string().nullable(),
  items: javaScriptRoutesViewItemsSchema,
  sources: z.array(javaScriptRouteInventorySourceSchema),
  summary: javaScriptRoutesViewSummarySchema.nullable(),
  byte_limited: z.boolean(),
});
